import {
  parseSearchCandidateDraft,
  parseSearchSelection,
  type SearchCandidateStatus,
  type SearchRunStatus,
} from "../domain/evidence-search.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import {
  EvidenceConflictError,
  EvidenceNotFoundError,
  EvidenceRequestValidationError,
  EvidenceUnavailableError,
} from "./evidence-errors.ts";
import type { EvidenceSourcePolicy } from "./evidence-source-policy.ts";
import type { EvidenceD1Database, EvidenceD1Statement } from "./evidence-service.ts";
import type { EvidenceFileStore, StoredEvidenceFile } from "./evidence-storage.ts";
import {
  quoteAppearsInPages,
  type FetchedExternalEvidence,
} from "./evidence-web-fetcher.ts";
import {
  EvidenceSearchError,
  type EvidenceSearchProvider,
} from "./openai-evidence-search.ts";

const MAX_CANDIDATES = 8;
const MAX_SELECTION = 5;
const MAX_DIRECT_SUMMARY_BYTES = 4_000;
const MAX_DIRECT_SUMMARY_CODE_UNITS = 2_000;
const MAX_ERROR_LENGTH = 240;
const ACQUISITION_LEASE_MS = 60_000;
const SEARCH_REUSABLE_STATUSES = new Set<SearchRunStatus>(["queued", "searching", "ready"]);
const SELECTION_STATUSES = new Set<SearchRunStatus>(["ready", "completed"]);
const IMPORT_START_STATUSES = new Set<SearchRunStatus>(["ready", "completed", "failed"]);

type EvidenceSearchRunRow = {
  id: string;
  bundleId: string;
  inputVersion: string;
  bundleVersion: number;
  status: SearchRunStatus;
  searchModel: string;
  promptVersion: string;
  queryJson: string;
  errorMessage: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  isStale: number | boolean;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type EvidenceSearchCandidateRow = {
  id: string;
  runId: string;
  bundleId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  publisher: string;
  publishedAt: string;
  retrievedAt: number | null;
  documentType: "web_page" | "pdf";
  quote: string;
  relevance: string;
  trustTier: 1 | 2 | 3;
  rank: number;
  status: SearchCandidateStatus;
  selectedBy: string | null;
  selectedAt: number | null;
  sourceId: string | null;
  contentHash: string | null;
  failureReason: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type SearchBundleRow = {
  id: string;
  title: string;
  purpose: string;
  version: number;
  contentVersion: string;
};

type DirectSourceRow = {
  id: string;
  originalFileName: string;
  extractedTextKey: string | null;
};

export type EvidenceSearchRunRecord = Omit<
  EvidenceSearchRunRow,
  "queryJson" | "leaseToken" | "leaseExpiresAt" | "isStale"
> & {
  queries: string[];
  isStale: boolean;
};

export type EvidenceSearchCandidateRecord = Omit<
  EvidenceSearchCandidateRow,
  "leaseToken" | "leaseExpiresAt"
>;

export type EvidenceSearchRunDetail = {
  run: EvidenceSearchRunRecord;
  candidates: EvidenceSearchCandidateRecord[];
};

export type ExternalEvidenceFetcher = (
  input: { url: string; expectedType: "web_page" | "pdf"; quote: string },
) => Promise<FetchedExternalEvidence>;

export type EvidenceExternalSearchJobDependencies = {
  db: EvidenceD1Database;
  provider: EvidenceSearchProvider;
  policy: EvidenceSourcePolicy;
  files: Pick<EvidenceFileStore, "getFile" | "putValidatedFile">;
  promptVersion: string;
  fetchExternalEvidence: ExternalEvidenceFetcher;
  schedule(promise: Promise<unknown>): void;
  now?: () => number;
  newId?: () => string;
};

const RUN_COLUMNS = `id,bundle_id AS bundleId,input_version AS inputVersion,
  bundle_version AS bundleVersion,status,search_model AS searchModel,prompt_version AS promptVersion,
  query_json AS queryJson,error_message AS errorMessage,lease_token AS leaseToken,
  lease_expires_at AS leaseExpiresAt,is_stale AS isStale,
  started_at AS startedAt,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt`;
const CANDIDATE_COLUMNS = `id,run_id AS runId,bundle_id AS bundleId,url,canonical_url AS canonicalUrl,
  title,publisher,published_at AS publishedAt,retrieved_at AS retrievedAt,document_type AS documentType,
  quote,relevance,trust_tier AS trustTier,rank,status,selected_by AS selectedBy,selected_at AS selectedAt,
  source_id AS sourceId,content_hash AS contentHash,failure_reason AS failureReason,
  lease_token AS leaseToken,lease_expires_at AS leaseExpiresAt,
  created_at AS createdAt,updated_at AS updatedAt`;

function changes(value: { meta?: { changes?: number } } | undefined): number {
  return value?.meta?.changes ?? 0;
}

function asRun(row: EvidenceSearchRunRow): EvidenceSearchRunRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.queryJson);
  } catch {
    parsed = [];
  }
  const queries = Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string").slice(0, 5)
    : [];
  return {
    id: row.id,
    bundleId: row.bundleId,
    inputVersion: row.inputVersion,
    bundleVersion: row.bundleVersion,
    status: row.status,
    searchModel: row.searchModel,
    promptVersion: row.promptVersion,
    errorMessage: row.errorMessage,
    isStale: Boolean(row.isStale),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    queries,
  };
}

function asCandidate(row: EvidenceSearchCandidateRow): EvidenceSearchCandidateRecord {
  const candidate: Partial<EvidenceSearchCandidateRow> = { ...row };
  delete candidate.leaseToken;
  delete candidate.leaseExpiresAt;
  return candidate as EvidenceSearchCandidateRecord;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function truncateUtf8(value: string, byteLimit: number, codeUnitLimit = Number.POSITIVE_INFINITY): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let codeUnits = 0;
  let result = "";
  for (const character of value) {
    const nextBytes = encoder.encode(character).byteLength;
    const nextCodeUnits = character.length;
    if (bytes + nextBytes > byteLimit || codeUnits + nextCodeUnits > codeUnitLimit) break;
    result += character;
    bytes += nextBytes;
    codeUnits += nextCodeUnits;
  }
  return result;
}

function objectBody(value: unknown): ReadableStream<Uint8Array> | null {
  if (typeof value !== "object" || value === null || !("body" in value)) return null;
  const body = (value as { body?: unknown }).body;
  return body instanceof ReadableStream ? body : null;
}

async function objectPrefix(value: unknown, maximumBytes: number): Promise<string> {
  if (maximumBytes <= 0) return "";
  if (typeof value === "string") return truncateUtf8(value, maximumBytes);
  if (value instanceof Uint8Array) {
    return truncateUtf8(new TextDecoder("utf-8").decode(value.subarray(0, maximumBytes)), maximumBytes);
  }
  const body = objectBody(value);
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (size < maximumBytes) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      const retained = next.value.subarray(0, maximumBytes - size);
      chunks.push(retained);
      size += retained.byteLength;
      if (retained.byteLength !== next.value.byteLength) break;
    }
  } finally {
    if (!complete) void reader.cancel("Direct evidence summary prefix is complete.").catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return truncateUtf8(new TextDecoder("utf-8").decode(bytes), maximumBytes);
}

function searchErrorMessage(error: unknown): string {
  if (error instanceof EvidenceSearchError && !error.retryable) {
    if (/설정|호스트|연결/.test(error.message)) return "외부 출처 검색 설정을 확인해 주세요.";
    if (/취소|거부/.test(error.message)) return "외부 출처 검색 요청이 거부되었습니다.";
  }
  if (error instanceof EvidenceSearchError && /시간/.test(error.message)) {
    return "외부 출처 검색 시간이 초과되었습니다. 다시 시도해 주세요.";
  }
  return "외부 출처 검색을 완료하지 못했습니다. 다시 시도해 주세요.";
}

function importErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/인용/.test(message)) return "선택한 인용을 외부 문서에서 확인할 수 없습니다.";
  if (/시간|timeout/i.test(message)) return "외부 문서 가져오기 시간이 초과되었습니다. 다시 시도해 주세요.";
  if (/MIME|파일 형식/.test(message)) return "외부 문서의 파일 형식을 확인할 수 없습니다.";
  if (/허용된 외부 출처|호스트|DNS|주소/.test(message)) return "허용된 외부 출처인지 확인할 수 없습니다.";
  if (/크기|너무 큽니다/.test(message)) return "외부 문서가 허용된 크기를 초과했습니다.";
  return "외부 문서를 가져오지 못했습니다. 다시 시도해 주세요.";
}

function safeError(value: string): string {
  return value.slice(0, MAX_ERROR_LENGTH);
}

function selectionInput(value: unknown) {
  try {
    return parseSearchSelection(value);
  } catch (error) {
    throw new EvidenceRequestValidationError(error instanceof Error ? error.message : undefined);
  }
}

/** D1-authoritative external search, human selection, and selected-only import orchestration. */
export class EvidenceExternalSearchJobs {
  constructor(private readonly dependencies: EvidenceExternalSearchJobDependencies) {}

  async startSearch(bundleId: string, admin: EvidenceAdmin): Promise<EvidenceSearchRunRecord> {
    void admin;
    const bundle = await this.bundle(bundleId);
    const directEvidenceSummary = await this.directEvidenceSummary(bundleId);
    const inputVersion = await sha256(JSON.stringify({
      contentVersion: bundle.contentVersion,
      bundleVersion: bundle.version,
      title: bundle.title,
      purpose: bundle.purpose,
      directEvidenceSummary,
      searchModel: this.dependencies.provider.modelId,
      promptVersion: this.dependencies.promptVersion,
    }));
    const existing = await this.findRunByInput(bundleId, inputVersion);
    if (existing !== null && SEARCH_REUSABLE_STATUSES.has(existing.status)) {
      if (existing.status === "queued" || existing.status === "searching") {
        await this.scheduleSearchContinuation(existing.id, bundle, directEvidenceSummary);
        return asRun(existing);
      }
      return asRun(existing);
    }
    if (existing !== null && existing.status !== "failed") return asRun(existing);

    const now = this.now();
    let runId = existing?.id ?? this.id();
    let queued = false;
    if (existing === null) {
      let result: { meta?: { changes?: number } } | undefined;
      try {
        result = await this.dependencies.db.prepare(
          `INSERT OR IGNORE INTO evidence_search_runs
            (id,bundle_id,input_version,bundle_version,status,search_model,prompt_version,query_json,error_message,is_stale,created_at,updated_at)
            SELECT ?,?,?,?,'queued',?,?,?,NULL,0,?,?
            WHERE EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)`,
        ).bind(
          runId,
          bundle.id,
          inputVersion,
          bundle.version,
          this.dependencies.provider.modelId,
          this.dependencies.promptVersion,
          "[]",
          now,
          now,
          bundle.id,
          bundle.version,
          bundle.contentVersion,
        ).run();
      } catch (error) {
        const committed = await this.findRunByInput(bundle.id, inputVersion);
        if (committed === null) throw error;
        runId = committed.id;
        if (committed.status === "queued") queued = true;
        else if (SEARCH_REUSABLE_STATUSES.has(committed.status) || committed.status !== "failed") {
          return asRun(committed);
        } else {
          throw error;
        }
      }
      queued ||= changes(result) === 1;
      if (!queued) {
        const winner = await this.findRunByInput(bundle.id, inputVersion);
        if (winner === null) throw new EvidenceConflictError();
        runId = winner.id;
        if (winner.status === "queued") queued = true;
        else if (SEARCH_REUSABLE_STATUSES.has(winner.status) || winner.status !== "failed") return asRun(winner);
      }
    }

    if (!queued) {
      let result: { meta?: { changes?: number } } | undefined;
      try {
        result = await this.dependencies.db.prepare(
          `UPDATE evidence_search_runs
            SET status='queued',query_json='[]',error_message=NULL,is_stale=0,started_at=NULL,completed_at=NULL,
              lease_token=NULL,lease_expires_at=NULL,bundle_version=?,search_model=?,prompt_version=?,updated_at=?
            WHERE id=? AND bundle_id=? AND input_version=? AND status='failed'
              AND NOT EXISTS (SELECT 1 FROM evidence_search_candidates WHERE run_id=evidence_search_runs.id)
              AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)`,
        ).bind(
          bundle.version,
          this.dependencies.provider.modelId,
          this.dependencies.promptVersion,
          now,
          runId,
          bundle.id,
          inputVersion,
          bundle.id,
          bundle.version,
          bundle.contentVersion,
        ).run();
      } catch (error) {
        const committed = await this.run(runId);
        if (committed?.status !== "queued") throw error;
        queued = true;
      }
      queued ||= changes(result) === 1;
      if (!queued) {
        const current = await this.run(runId);
        if (current === null) throw new EvidenceConflictError();
        if (current.status === "queued") queued = true;
        else return asRun(current);
      }
    }

    const created = await this.run(runId);
    if (created === null) throw new EvidenceConflictError();
    await this.scheduleSearchContinuation(runId, bundle, directEvidenceSummary);
    if (await this.run(runId) === null) throw new EvidenceConflictError();
    return asRun(created);
  }

  async getLatestSearch(bundleId: string): Promise<EvidenceSearchRunDetail | null> {
    const row = await this.dependencies.db.prepare(
      `SELECT ${RUN_COLUMNS} FROM evidence_search_runs WHERE bundle_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).bind(bundleId).first<EvidenceSearchRunRow>();
    return row === null ? null : this.detail(row);
  }

  async getSearch(bundleId: string, runId: string): Promise<EvidenceSearchRunDetail | null> {
    const row = await this.run(runId);
    if (row === null || row.bundleId !== bundleId) return null;
    return this.detail(row);
  }

  async saveSelection(
    bundleId: string,
    runId: string,
    value: unknown,
    admin: EvidenceAdmin,
  ): Promise<EvidenceSearchRunDetail> {
    const input = selectionInput(value);
    const run = await this.run(runId);
    if (run === null || run.bundleId !== bundleId) throw new EvidenceNotFoundError("외부 출처 검색 작업을 찾을 수 없습니다.");
    if (!SELECTION_STATUSES.has(run.status)) {
      throw new EvidenceConflictError("선택할 수 있는 외부 출처 검색 작업 상태가 아닙니다.");
    }
    if (run.isStale) throw new EvidenceConflictError("오래된 검색 결과입니다. 외부 출처를 다시 검색해 주세요.");
    const bundle = await this.bundle(bundleId);
    if (bundle.version !== input.expectedBundleVersion || run.bundleVersion !== bundle.version) {
      throw new EvidenceConflictError();
    }

    const ids = [...new Set([...input.selectedIds, ...input.excludedIds])];
    const requested = await this.candidatesByIds(runId, ids);
    if (requested.length !== ids.length) throw new EvidenceNotFoundError("검색 후보를 찾을 수 없습니다.");
    if (requested.some((candidate) => candidate.bundleId !== bundleId || candidate.runId !== runId)) {
      throw new EvidenceNotFoundError("검색 후보를 찾을 수 없습니다.");
    }
    if (requested.some((candidate) => candidate.status === "importing")) {
      throw new EvidenceConflictError("가져오는 중인 후보의 선택은 변경할 수 없습니다.");
    }
    if (requested.some((candidate) => candidate.status === "imported" && input.excludedIds.includes(candidate.id))) {
      throw new EvidenceConflictError("이미 가져온 후보는 제외할 수 없습니다.");
    }
    const importedOutsideSelection = (await this.candidates(runId))
      .filter((candidate) => candidate.status === "imported" && !input.selectedIds.includes(candidate.id)).length;
    if (input.selectedIds.length + importedOutsideSelection > MAX_SELECTION) {
      throw new EvidenceRequestValidationError("선택한 후보는 최대 5개여야 합니다.");
    }
    if (ids.length === 0 || this.selectionApplied(requested, input.selectedIds, input.excludedIds)) {
      return (await this.getSearch(bundleId, runId))!;
    }

    const now = Math.max(this.now(), run.updatedAt + 1);
    const placeholders = ids.map(() => "?").join(",");
    const authority = `EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=?)
      AND EXISTS (SELECT 1 FROM evidence_search_runs
        WHERE id=? AND bundle_id=? AND status IN ('ready','completed') AND is_stale=0 AND updated_at=?)
      AND (SELECT COUNT(*) FROM evidence_search_candidates WHERE run_id=? AND id IN (${placeholders}))=?`;
    const authorityValues = [
      bundleId,
      input.expectedBundleVersion,
      runId,
      bundleId,
      run.updatedAt,
      runId,
      ...ids,
      ids.length,
    ];
    const statements: EvidenceD1Statement[] = [];
    for (const id of input.selectedIds) {
      const current = requested.find((candidate) => candidate.id === id)!;
      if (current.status === "imported") continue;
      statements.push(
        this.dependencies.db.prepare(
          `UPDATE evidence_search_candidates
            SET status='selected',selected_by=?,selected_at=?,source_id=NULL,content_hash=NULL,
              failure_reason=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE id=? AND run_id=? AND ${authority}`,
        ).bind(admin.userId, now, now, id, runId, ...authorityValues),
        this.auditStatement(bundleId, admin, "search_candidate.selected", id, runId, now, authority, authorityValues),
      );
    }
    for (const id of input.excludedIds) {
      statements.push(
        this.dependencies.db.prepare(
          `UPDATE evidence_search_candidates
            SET status='excluded',selected_by=?,selected_at=?,source_id=NULL,content_hash=NULL,
              failure_reason=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
            WHERE id=? AND run_id=? AND ${authority}`,
        ).bind(admin.userId, now, now, id, runId, ...authorityValues),
        this.auditStatement(bundleId, admin, "search_candidate.excluded", id, runId, now, authority, authorityValues),
      );
    }
    statements.push(this.dependencies.db.prepare(
      `UPDATE evidence_search_runs SET updated_at=?
        WHERE id=? AND bundle_id=? AND updated_at=? AND status IN ('ready','completed') AND is_stale=0
          AND ${authority}`,
    ).bind(now, runId, bundleId, run.updatedAt, ...authorityValues));

    let results: { meta?: { changes?: number } }[];
    try {
      results = await this.dependencies.db.batch(statements);
    } catch (error) {
      const [after, afterRun] = await Promise.all([
        this.candidatesByIds(runId, ids),
        this.run(runId),
      ]);
      if (afterRun?.updatedAt !== now || !this.selectionApplied(after, input.selectedIds, input.excludedIds)) throw error;
      return (await this.getSearch(bundleId, runId))!;
    }
    if (changes(results.at(-1)) !== 1) throw new EvidenceConflictError();
    return (await this.getSearch(bundleId, runId))!;
  }

  async startImport(bundleId: string, runId: string, admin: EvidenceAdmin): Promise<EvidenceSearchRunRecord> {
    void admin;
    const run = await this.run(runId);
    if (run === null || run.bundleId !== bundleId) throw new EvidenceNotFoundError("외부 출처 검색 작업을 찾을 수 없습니다.");
    if (run.isStale) throw new EvidenceConflictError("오래된 검색 결과입니다. 외부 출처를 다시 검색해 주세요.");
    if (run.status === "importing") {
      const bundle = await this.bundle(bundleId);
      if (run.bundleVersion !== bundle.version) throw new EvidenceConflictError();
      this.scheduleImportContinuation(bundleId, runId);
      return asRun(run);
    }
    if (!IMPORT_START_STATUSES.has(run.status)) {
      throw new EvidenceConflictError("가져올 수 있는 외부 출처 검색 작업 상태가 아닙니다.");
    }
    const bundle = await this.bundle(bundleId);
    if (run.bundleVersion !== bundle.version) throw new EvidenceConflictError();
    const retryable = (await this.candidates(runId)).filter((candidate) =>
      candidate.selectedBy !== null && (candidate.status === "selected" || candidate.status === "failed"));
    if (retryable.length === 0) {
      if (run.status === "completed" || run.status === "failed") {
        throw new EvidenceConflictError();
      }
      throw new EvidenceRequestValidationError("가져올 외부 출처 후보를 하나 이상 선택해 주세요.");
    }
    if (retryable.length > MAX_SELECTION) throw new EvidenceRequestValidationError("선택한 후보는 최대 5개여야 합니다.");

    const now = Math.max(this.now(), run.updatedAt + 1);
    let result: { meta?: { changes?: number } } | undefined;
    let accepted: EvidenceSearchRunRow | null = null;
    try {
      result = await this.dependencies.db.prepare(
        `UPDATE evidence_search_runs
          SET status='importing',error_message=NULL,completed_at=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE id=? AND bundle_id=? AND updated_at=? AND is_stale=0
            AND status IN ('ready','completed','failed') AND bundle_version=?
            AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=?)
            AND EXISTS (SELECT 1 FROM evidence_search_candidates
              WHERE run_id=? AND selected_by IS NOT NULL AND status IN ('selected','failed'))`,
      ).bind(now, runId, bundleId, run.updatedAt, bundle.version, bundleId, bundle.version, runId).run();
    } catch (error) {
      const committed = await this.run(runId);
      if (committed?.status !== "importing" || committed.bundleVersion !== bundle.version) throw error;
      accepted = committed;
    }
    if (changes(result) !== 1) {
      const winner = accepted ?? await this.run(runId);
      if (winner?.status !== "importing") throw new EvidenceConflictError();
      accepted = winner;
    } else {
      accepted = {
        ...run,
        status: "importing",
        errorMessage: null,
        completedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      };
    }
    if (accepted === null) throw new EvidenceConflictError();

    try {
      this.scheduleImportContinuation(bundleId, runId);
    } catch {
      throw new EvidenceUnavailableError("외부 문서 가져오기 작업을 예약하지 못했습니다.");
    }
    if (await this.run(runId) === null) throw new EvidenceConflictError();
    return asRun(accepted);
  }

  private async executeSearch(
    runId: string,
    bundle: SearchBundleRow,
    directEvidenceSummary: string,
  ): Promise<void> {
    const startedAt = this.now();
    const leaseToken = this.leaseToken();
    const leaseExpiresAt = startedAt + ACQUISITION_LEASE_MS;
    let acquired: { meta?: { changes?: number } } | undefined;
    try {
      acquired = await this.dependencies.db.prepare(
        `UPDATE evidence_search_runs
          SET status='searching',lease_token=?,lease_expires_at=?,started_at=COALESCE(started_at,?),
            error_message=NULL,updated_at=?
          WHERE id=? AND bundle_id=? AND is_stale=0 AND bundle_version=?
            AND (status='queued' OR (status='searching' AND (lease_expires_at IS NULL OR lease_expires_at<=?)))
            AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)`,
      ).bind(
        leaseToken,
        leaseExpiresAt,
        startedAt,
        startedAt,
        runId,
        bundle.id,
        bundle.version,
        startedAt,
        bundle.id,
        bundle.version,
        bundle.contentVersion,
      ).run();
    } catch {
      const current = await this.run(runId);
      if (current?.status !== "searching" || current.leaseToken !== leaseToken) {
        await this.staleRunIfBundleChanged(runId, bundle);
        return;
      }
      acquired = { meta: { changes: 1 } };
    }
    if (changes(acquired) !== 1) {
      await this.staleRunIfBundleChanged(runId, bundle);
      return;
    }

    try {
      const result = await this.dependencies.provider.search({
        title: bundle.title,
        purpose: bundle.purpose,
        directEvidenceSummary,
      }, new AbortController().signal);
      const candidates: ReturnType<typeof parseSearchCandidateDraft>[] = [];
      const urls = new Set<string>();
      for (const value of result.candidates) {
        if (candidates.length === MAX_CANDIDATES) break;
        try {
          const parsed = parseSearchCandidateDraft(value);
          const tier = this.dependencies.policy.classify(new URL(parsed.canonicalUrl));
          if (tier === null || urls.has(parsed.canonicalUrl)) continue;
          urls.add(parsed.canonicalUrl);
          candidates.push({ ...parsed, proposedTrustTier: tier });
        } catch {
          // Provider candidates are advisory. Invalid or disallowed candidates are dropped.
        }
      }
      const completedAt = this.now();
      const queries = result.queries
        .filter((query): query is string => typeof query === "string" && query.trim() !== "")
        .map((query) => query.trim().slice(0, 200))
        .slice(0, 5);
      const guard = `EXISTS (SELECT 1 FROM evidence_search_runs
          WHERE id=? AND bundle_id=? AND status='searching' AND is_stale=0 AND bundle_version=? AND lease_token=?)
        AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)`;
      const guardValues = [
        runId,
        bundle.id,
        bundle.version,
        leaseToken,
        bundle.id,
        bundle.version,
        bundle.contentVersion,
      ];
      const statements = candidates.map((candidate, rank) => this.dependencies.db.prepare(
        `INSERT INTO evidence_search_candidates
          (id,run_id,bundle_id,url,canonical_url,title,publisher,published_at,retrieved_at,document_type,
            quote,relevance,trust_tier,rank,status,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'candidate',?,? WHERE ${guard}`,
      ).bind(
        this.id(),
        runId,
        bundle.id,
        candidate.url,
        candidate.canonicalUrl,
        candidate.title,
        candidate.publisher,
        candidate.publishedAt,
        completedAt,
        candidate.documentType,
        candidate.quote,
        candidate.relevance,
        candidate.proposedTrustTier,
        rank,
        completedAt,
        completedAt,
        ...guardValues,
      ));
      statements.push(this.dependencies.db.prepare(
        `UPDATE evidence_search_runs
          SET status='ready',query_json=?,error_message=NULL,lease_token=NULL,lease_expires_at=NULL,
            completed_at=?,updated_at=?
          WHERE id=? AND bundle_id=? AND status='searching' AND is_stale=0 AND bundle_version=? AND lease_token=?
            AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)`,
      ).bind(
        JSON.stringify(queries),
        completedAt,
        completedAt,
        runId,
        bundle.id,
        bundle.version,
        leaseToken,
        bundle.id,
        bundle.version,
        bundle.contentVersion,
      ));
      try {
        const committed = await this.dependencies.db.batch(statements);
        if (changes(committed.at(-1)) !== 1) await this.staleRunIfBundleChanged(runId, bundle);
      } catch (error) {
        const current = await this.run(runId);
        if (current?.status !== "ready") throw error;
      }
    } catch (error) {
      const current = await this.run(runId);
      if (current?.status === "ready" || current?.isStale || current?.leaseToken !== leaseToken) return;
      const now = this.now();
      await this.dependencies.db.prepare(
        `UPDATE evidence_search_runs
          SET status='failed',error_message=?,lease_token=NULL,lease_expires_at=NULL,completed_at=?,updated_at=?
          WHERE id=? AND status='searching' AND is_stale=0 AND lease_token=?`,
      ).bind(safeError(searchErrorMessage(error)), now, now, runId, leaseToken).run();
    }
  }

  private async executeImports(bundleId: string, runId: string): Promise<void> {
    try {
      const now = this.now();
      const candidates = (await this.candidates(runId)).filter((candidate) =>
        candidate.selectedBy !== null && (
          candidate.status === "selected"
          || candidate.status === "failed"
          || (candidate.status === "importing"
            && (candidate.leaseExpiresAt === null || candidate.leaseExpiresAt <= now))
        ),
      ).slice(0, MAX_SELECTION);
      for (const candidate of candidates) {
        try {
          await this.importCandidate(bundleId, runId, candidate);
        } catch {
          // Candidate transport/state failures are isolated so later selected siblings still run.
        }
      }
    } finally {
      await this.finishImportRun(runId);
    }
  }

  private async importCandidate(
    bundleId: string,
    runId: string,
    candidate: EvidenceSearchCandidateRow,
  ): Promise<void> {
    const acquiredAt = this.now();
    const leaseToken = this.leaseToken();
    const leaseExpiresAt = acquiredAt + ACQUISITION_LEASE_MS;
    let acquired: { meta?: { changes?: number } } | undefined;
    try {
      acquired = await this.dependencies.db.prepare(
        `UPDATE evidence_search_candidates
          SET status='importing',lease_token=?,lease_expires_at=?,failure_reason=NULL,updated_at=?
          WHERE id=? AND run_id=? AND bundle_id=? AND selected_by IS NOT NULL
            AND (status IN ('selected','failed')
              OR (status='importing' AND (lease_expires_at IS NULL OR lease_expires_at<=?)))
            AND EXISTS (SELECT 1 FROM evidence_search_runs
              WHERE id=? AND bundle_id=? AND status='importing' AND is_stale=0
                AND bundle_version=(SELECT version FROM evidence_bundles WHERE id=?))`,
      ).bind(
        leaseToken,
        leaseExpiresAt,
        acquiredAt,
        candidate.id,
        runId,
        bundleId,
        acquiredAt,
        runId,
        bundleId,
        bundleId,
      ).run();
    } catch (error) {
      const after = await this.candidate(candidate.id);
      if (after?.status !== "importing" || after.leaseToken !== leaseToken) throw error;
      acquired = { meta: { changes: 1 } };
    }
    if (changes(acquired) !== 1) return;

    try {
      const fetched = await this.dependencies.fetchExternalEvidence({
        url: candidate.url,
        expectedType: candidate.documentType,
        quote: candidate.quote,
      });
      this.dependencies.policy.assertAllowed(new URL(fetched.finalUrl));
      if (!quoteAppearsInPages(candidate.quote, fetched.extractedPages)) {
        throw new Error("선택한 인용을 외부 문서에서 확인할 수 없습니다.");
      }
      const source = await this.dependencies.files.putValidatedFile({
        bundleId,
        name: fetched.fileName,
        type: fetched.mediaType,
        bytes: fetched.bytes,
        externalMetadata: {
          origin: "external_web",
          canonicalUrl: fetched.finalUrl,
          publisher: candidate.publisher,
          publishedAt: candidate.publishedAt,
          retrievedAt: fetched.retrievedAt,
          searchCandidateId: candidate.id,
          searchCandidateLeaseToken: leaseToken,
        },
      });
      await this.finishCandidateImport(runId, candidate.id, leaseToken, source);
    } catch (error) {
      const current = await this.candidate(candidate.id);
      if (current?.status === "imported") return;
      if (current?.status !== "importing" || current.leaseToken !== leaseToken) return;
      const now = this.now();
      const message = safeError(importErrorMessage(error));
      try {
        await this.failCandidateImport(runId, candidate.id, leaseToken, message, now);
      } catch (failureError) {
        const after = await this.candidate(candidate.id);
        if (after?.status === "failed" || after?.status === "imported") return;
        if (after?.status !== "importing" || after.leaseToken !== leaseToken) return;
        try {
          await this.failCandidateImport(runId, candidate.id, leaseToken, message, this.now());
        } catch {
          throw failureError;
        }
      }
    }
  }

  private async failCandidateImport(
    runId: string,
    candidateId: string,
    leaseToken: string,
    message: string,
    now: number,
  ): Promise<void> {
    const result = await this.dependencies.db.prepare(
      `UPDATE evidence_search_candidates
        SET status='failed',failure_reason=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND run_id=? AND status='importing' AND lease_token=?
          AND EXISTS (SELECT 1 FROM evidence_search_runs WHERE id=? AND status='importing' AND is_stale=0)`,
    ).bind(message, now, candidateId, runId, leaseToken, runId).run();
    if (changes(result) === 1) return;
    const after = await this.candidate(candidateId);
    if (after?.status === "failed" || after?.status === "imported" || after?.leaseToken !== leaseToken) return;
    throw new EvidenceConflictError();
  }

  private async finishCandidateImport(
    runId: string,
    candidateId: string,
    leaseToken: string,
    source: StoredEvidenceFile,
  ): Promise<void> {
    const current = await this.candidate(candidateId);
    if (current?.status === "imported" && current.sourceId === source.id) return;
    const now = this.now();
    try {
      const result = await this.dependencies.db.prepare(
        `UPDATE evidence_search_candidates
          SET status='imported',source_id=?,content_hash=?,failure_reason=NULL,
            lease_token=NULL,lease_expires_at=NULL,updated_at=?
          WHERE id=? AND run_id=? AND status='importing' AND lease_token=?
            AND EXISTS (SELECT 1 FROM evidence_sources WHERE id=? AND bundle_id=evidence_search_candidates.bundle_id AND content_hash=?)
            AND EXISTS (SELECT 1 FROM evidence_search_runs WHERE id=? AND status='importing' AND is_stale=0)`,
      ).bind(
        source.id,
        source.contentHash,
        now,
        candidateId,
        runId,
        leaseToken,
        source.id,
        source.contentHash,
        runId,
      ).run();
      if (changes(result) === 1) return;
    } catch (error) {
      const after = await this.candidate(candidateId);
      if (after?.status === "imported" && after.sourceId === source.id) return;
      throw error;
    }
    const after = await this.candidate(candidateId);
    if (after?.status !== "imported" || after.sourceId !== source.id) throw new EvidenceConflictError();
  }

  private async finishImportRun(runId: string): Promise<void> {
    const now = this.now();
    await this.dependencies.db.prepare(
      `UPDATE evidence_search_runs
        SET status=CASE WHEN EXISTS (
            SELECT 1 FROM evidence_search_candidates WHERE run_id=? AND status='imported'
          ) THEN 'completed' ELSE 'failed' END,
          error_message=CASE WHEN EXISTS (
            SELECT 1 FROM evidence_search_candidates WHERE run_id=? AND status='imported'
          ) THEN NULL ELSE ? END,
          lease_token=NULL,lease_expires_at=NULL,completed_at=?,updated_at=?
        WHERE id=? AND status='importing' AND is_stale=0
          AND NOT EXISTS (
            SELECT 1 FROM evidence_search_candidates
              WHERE run_id=? AND status IN ('selected','importing')
          )`,
    ).bind(
      runId,
      runId,
      "선택한 외부 문서를 가져오지 못했습니다.",
      now,
      now,
      runId,
      runId,
    ).run();
  }

  private async directEvidenceSummary(bundleId: string): Promise<string> {
    const sources = (await this.dependencies.db.prepare(
      `SELECT id,original_file_name AS originalFileName,extracted_text_key AS extractedTextKey
        FROM evidence_sources WHERE bundle_id=? AND origin='uploaded' ORDER BY id`,
    ).bind(bundleId).all<DirectSourceRow>()).results;
    const clips = (await this.dependencies.db.prepare(
      "SELECT observation FROM evidence_video_clips WHERE bundle_id=? ORDER BY id",
    ).bind(bundleId).all<{ observation: string }>()).results;
    let summary = "";
    const append = (value: string) => {
      const separator = summary === "" ? "" : "\n";
      const remainingBytes = MAX_DIRECT_SUMMARY_BYTES - new TextEncoder().encode(summary + separator).byteLength;
      const remainingCodeUnits = MAX_DIRECT_SUMMARY_CODE_UNITS - (summary + separator).length;
      if (remainingBytes <= 0 || remainingCodeUnits <= 0) return;
      summary += separator + truncateUtf8(value, remainingBytes, remainingCodeUnits);
    };
    for (const source of sources) {
      append(`[직접 파일: ${source.originalFileName}]`);
      if (source.extractedTextKey === null) continue;
      const remaining = MAX_DIRECT_SUMMARY_BYTES - new TextEncoder().encode(summary).byteLength;
      if (remaining <= 0) break;
      try {
        const object = await this.dependencies.files.getFile(source.extractedTextKey);
        if (object !== null) append(await objectPrefix(object, remaining));
      } catch {
        // Search remains available when one advisory summary object is unavailable.
      }
    }
    for (const clip of clips) append(`[직접 영상 관찰] ${clip.observation}`);
    return summary;
  }

  private async staleRunIfBundleChanged(runId: string, bundle: SearchBundleRow): Promise<void> {
    const now = this.now();
    await this.dependencies.db.prepare(
      `UPDATE evidence_search_runs
        SET status='failed',is_stale=1,error_message='근거 묶음이 갱신되었습니다.',
          lease_token=NULL,lease_expires_at=NULL,completed_at=?,updated_at=?
        WHERE id=? AND status IN ('queued','searching') AND is_stale=0
          AND NOT EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)`,
    ).bind(now, now, runId, bundle.id, bundle.version, bundle.contentVersion).run();
  }

  private async failQueuedSearch(runId: string): Promise<void> {
    const now = this.now();
    await this.dependencies.db.prepare(
      `UPDATE evidence_search_runs
        SET status='failed',error_message=?,lease_token=NULL,lease_expires_at=NULL,completed_at=?,updated_at=?
        WHERE id=? AND status='queued'`,
    ).bind("외부 출처 검색 작업을 예약하지 못했습니다.", now, now, runId).run();
  }

  private auditStatement(
    bundleId: string,
    admin: EvidenceAdmin,
    action: string,
    candidateId: string,
    runId: string,
    now: number,
    authority: string,
    authorityValues: unknown[],
  ): EvidenceD1Statement {
    return this.dependencies.db.prepare(
      `INSERT INTO evidence_audit_events
        (id,bundle_id,actor_user_id,action,target_type,target_id,details_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${authority}`,
    ).bind(
      this.id(),
      bundleId,
      admin.userId,
      action,
      "search_candidate",
      candidateId,
      JSON.stringify({ runId }),
      now,
      ...authorityValues,
    );
  }

  private selectionApplied(
    candidates: EvidenceSearchCandidateRow[],
    selectedIds: string[],
    excludedIds: string[],
  ): boolean {
    if (candidates.length !== selectedIds.length + excludedIds.length) return false;
    return selectedIds.every((id) => {
      const candidate = candidates.find((value) => value.id === id);
      return candidate?.status === "selected" || candidate?.status === "imported";
    }) && excludedIds.every((id) => candidates.find((value) => value.id === id)?.status === "excluded");
  }

  private async scheduleSearchContinuation(
    runId: string,
    bundle: SearchBundleRow,
    directEvidenceSummary: string,
  ): Promise<void> {
    try {
      this.schedule(() => this.executeSearch(runId, bundle, directEvidenceSummary));
    } catch {
      await this.failQueuedSearch(runId);
      throw new EvidenceUnavailableError("외부 출처 검색 작업을 예약하지 못했습니다.");
    }
  }

  private scheduleImportContinuation(bundleId: string, runId: string): void {
    this.schedule(() => this.executeImports(bundleId, runId));
  }

  private schedule(operation: () => Promise<void>): void {
    let release!: () => void;
    let cancel!: (error: unknown) => void;
    const registration = new Promise<void>((resolve, reject) => {
      release = resolve;
      cancel = reject;
    });
    const continuation = registration.then(operation);
    try {
      this.dependencies.schedule(continuation);
      release();
    } catch (error) {
      void continuation.catch(() => undefined);
      cancel(error);
      throw error;
    }
  }

  private async bundle(bundleId: string): Promise<SearchBundleRow> {
    const row = await this.dependencies.db.prepare(
      `SELECT id,title,purpose,version,content_version AS contentVersion
        FROM evidence_bundles WHERE id=?`,
    ).bind(bundleId).first<SearchBundleRow>();
    if (row === null) throw new EvidenceNotFoundError("근거 묶음을 찾을 수 없습니다.");
    return row;
  }

  private run(runId: string): Promise<EvidenceSearchRunRow | null> {
    return this.dependencies.db.prepare(
      `SELECT ${RUN_COLUMNS} FROM evidence_search_runs WHERE id=?`,
    ).bind(runId).first<EvidenceSearchRunRow>();
  }

  private findRunByInput(bundleId: string, inputVersion: string): Promise<EvidenceSearchRunRow | null> {
    return this.dependencies.db.prepare(
      `SELECT ${RUN_COLUMNS} FROM evidence_search_runs WHERE bundle_id=? AND input_version=?`,
    ).bind(bundleId, inputVersion).first<EvidenceSearchRunRow>();
  }

  private candidate(candidateId: string): Promise<EvidenceSearchCandidateRow | null> {
    return this.dependencies.db.prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM evidence_search_candidates WHERE id=?`,
    ).bind(candidateId).first<EvidenceSearchCandidateRow>();
  }

  private async candidates(runId: string): Promise<EvidenceSearchCandidateRow[]> {
    return (await this.dependencies.db.prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM evidence_search_candidates WHERE run_id=? ORDER BY rank,id`,
    ).bind(runId).all<EvidenceSearchCandidateRow>()).results;
  }

  private async candidatesByIds(runId: string, ids: string[]): Promise<EvidenceSearchCandidateRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (await this.dependencies.db.prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM evidence_search_candidates
        WHERE run_id=? AND id IN (${placeholders}) ORDER BY rank,id`,
    ).bind(runId, ...ids).all<EvidenceSearchCandidateRow>()).results;
  }

  private async detail(row: EvidenceSearchRunRow): Promise<EvidenceSearchRunDetail> {
    return { run: asRun(row), candidates: (await this.candidates(row.id)).map(asCandidate) };
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private id(): string {
    return this.dependencies.newId?.() ?? crypto.randomUUID();
  }

  private leaseToken(): string {
    return crypto.randomUUID();
  }
}
