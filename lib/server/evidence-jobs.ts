import { computeEvidenceVersion, type TacticCardContent } from "../domain/evidence.ts";
import {
  EvidenceAnalyzerError,
  extractedCitationIds,
  parseAnalyzerCards,
  parseExtractedEvidence,
  type EvidenceAnalyzer,
  type EvidenceChunkInput,
} from "./evidence-analyzer.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import type {
  EvidenceAnalysisSettings,
  EvidenceD1Database,
  EvidenceD1Statement,
} from "./evidence-service.ts";
import { EvidenceConflictError, EvidenceJobConfigurationConflictError, EvidenceNotFoundError } from "./evidence-errors.ts";

const LEASE_MS = 60_000;
const MAX_ANALYZER_ATTEMPTS = 3;
const MAX_R2_OBJECT_BYTES = 20 * 1024 * 1024;
export const EVIDENCE_CHUNK_MAX_BYTES = 256 * 1024;
export const EVIDENCE_CHECKPOINT_MAX_BYTES = 700 * 1024;
export const EVIDENCE_CARD_MAX_BYTES = 700 * 1024;

export type EvidenceAnalysisJobStage =
  | "validate_sources"
  | "extract_text"
  | "normalize_clips"
  | "extract_evidence"
  | "generate_cards"
  | "persist_cards"
  | "done";

export type EvidenceAnalysisJobStatus = "queued" | "running" | "review_ready" | "completed" | "failed";

export type EvidenceAnalysisJobRecord = {
  id: string;
  bundleId: string;
  inputVersion: string;
  status: EvidenceAnalysisJobStatus;
  analyzerModel: string;
  promptVersion: string;
  schemaVersion: string;
  stage: EvidenceAnalysisJobStage;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
  attemptCount: number;
  extractedEvidenceJson: string | null;
  generatedCardsJson: string | null;
  isStale: boolean;
  createdAt: number;
  updatedAt: number;
};

type EvidenceSourceRow = {
  id: string;
  bundleId: string;
  contentHash: string;
  storageKey: string;
  extractedTextKey: string | null;
  extractionStatus: "pending" | "completed" | "failed";
  extractionError: string | null;
};

type EvidenceVideoClipRow = {
  id: string;
  url: string;
  startMs: number;
  endMs: number;
  observation: string;
};

type ExtractedPage = { locator: string; text: string };

export type EvidenceJobFileReader = {
  getFile(key: string): Promise<unknown | null>;
};

export type EvidenceAnalysisJobsDependencies = {
  db: EvidenceD1Database;
  files: EvidenceJobFileReader;
  analyzer: EvidenceAnalyzer;
  settings: EvidenceAnalysisSettings;
  /** Production passes the platform request context's `waitUntil` adapter. */
  schedule(promise: Promise<unknown>): void;
  runnerId?: string;
  now?: () => number;
  newId?: () => string;
};

const JOB_COLUMNS = `id,bundle_id AS bundleId,input_version AS inputVersion,status,
  analyzer_model AS analyzerModel,prompt_version AS promptVersion,schema_version AS schemaVersion,stage,
  lease_owner AS leaseOwner,lease_token AS leaseToken,lease_expires_at AS leaseExpiresAt,error_message AS errorMessage,
  started_at AS startedAt,completed_at AS completedAt,attempt_count AS attemptCount,
  extracted_evidence_json AS extractedEvidenceJson,generated_cards_json AS generatedCardsJson,
  is_stale AS isStale,created_at AS createdAt,updated_at AS updatedAt`;

const CHECKPOINT_GUARD = `EXISTS (
  SELECT 1 FROM evidence_analysis_jobs AS active
  JOIN evidence_bundles AS bundle ON bundle.id=active.bundle_id
  WHERE active.id=? AND active.stage=? AND active.lease_owner=? AND active.lease_token=?
    AND active.lease_expires_at>? AND active.is_stale=0
    AND active.analyzer_model=? AND active.prompt_version=? AND active.schema_version=?
    AND bundle.content_version=active.input_version
)`;

function safeMessage(error: unknown): string {
  return error instanceof EvidenceAnalyzerError
    ? error.message
    : "근거 분석 단계에서 오류가 발생했습니다.";
}

function asChanges(result: { meta?: { changes?: number } } | undefined): number {
  return result?.meta?.changes ?? 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readStream(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_R2_OBJECT_BYTES) throw new Error("근거 파일이 너무 큽니다.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function objectBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (isObject(value) && value.body instanceof ReadableStream) return readStream(value.body);
  throw new Error("근거 파일을 읽을 수 없습니다.");
}

async function objectText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  return new TextDecoder("utf-8", { fatal: true }).decode(await objectBytes(value));
}

function extractedPages(value: unknown): ExtractedPage[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("추출된 텍스트가 없습니다.");
  return value.map((page) => {
    if (!isObject(page) || typeof page.locator !== "string" || page.locator.trim() === ""
      || typeof page.text !== "string" || page.text.trim() === "") {
      throw new Error("추출된 텍스트 형식이 올바르지 않습니다.");
    }
    return { locator: page.locator, text: page.text };
  });
}

function citationIds(card: TacticCardContent): string[] {
  return [...new Set([...card.preferred, ...card.alternatives, ...card.risky].flatMap((action) => action.citationIds))];
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedJson(value: unknown, maximumBytes: number, message: string, retryable = true): string {
  const json = JSON.stringify(value);
  if (utf8ByteLength(json) > maximumBytes) throw new EvidenceAnalyzerError(message, retryable);
  return json;
}

function splitUtf8(value: string, maximumBytes: number): string[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const buffer = new Uint8Array(maximumBytes);
    const { read, written } = encoder.encodeInto(value.slice(offset), buffer);
    if (read === 0 || written === 0) throw new Error("근거 텍스트를 안전한 크기로 나눌 수 없습니다.");
    pieces.push(decoder.decode(buffer.subarray(0, written)));
    offset += read;
  }
  return pieces;
}

/** D1-authoritative, lease-based evidence analysis runner. */
export class EvidenceAnalysisJobs {
  private readonly runnerId: string;

  constructor(private readonly dependencies: EvidenceAnalysisJobsDependencies) {
    this.runnerId = dependencies.runnerId ?? crypto.randomUUID();
    if (dependencies.analyzer.modelId !== dependencies.settings.analyzerModel) {
      throw new EvidenceAnalyzerError("분석 모델 설정이 근거 버전 설정과 일치하지 않습니다.", false);
    }
  }

  async startAnalysis(bundleId: string, admin: EvidenceAdmin): Promise<EvidenceAnalysisJobRecord> {
    void admin;
    const bundle = await this.refreshBundleVersion(bundleId);
    if (bundle === null) throw new EvidenceNotFoundError("근거 묶음을 찾을 수 없습니다.");

    const now = this.now();
    const id = this.id();
    await this.dependencies.db.prepare(
      `INSERT INTO evidence_analysis_jobs
        (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,attempt_count,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(bundle_id,input_version) DO NOTHING`,
    ).bind(
      id, bundle.id, bundle.contentVersion, "queued", this.dependencies.analyzer.modelId,
      this.dependencies.settings.promptVersion, this.dependencies.settings.schemaVersion,
      "validate_sources", 0, 0, now, now,
    ).run();
    const job = await this.findByInputVersion(bundle.id, bundle.contentVersion);
    if (job === null) throw new Error("근거 분석 작업을 생성할 수 없습니다.");
    if (this.configurationMismatch(job)) {
      await this.failConfigurationMismatch(job);
      return (await this.getAnalysisStatus(job.id)) ?? job;
    }
    if (this.canContinue(job, now)) this.scheduleStep(job.id);
    return job;
  }

  async runAnalysisStep(jobId: string): Promise<EvidenceAnalysisJobRecord | null> {
    const persisted = await this.getAnalysisStatus(jobId);
    if (persisted === null) return null;
    if (this.configurationMismatch(persisted)) {
      await this.failConfigurationMismatch(persisted);
      return this.getAnalysisStatus(jobId);
    }
    const now = this.now();
    const leaseToken = this.id();
    const acquired = await this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs
        SET lease_owner=?,lease_token=?,lease_expires_at=?,status='running',started_at=COALESCE(started_at,?),updated_at=?
        WHERE id=? AND is_stale=0 AND status IN ('queued','running')
          AND analyzer_model=? AND prompt_version=? AND schema_version=?
          AND (lease_expires_at IS NULL OR lease_expires_at<=?
            OR (lease_owner=? AND lease_token=?))`,
    ).bind(
      this.runnerId, leaseToken, now + LEASE_MS, now, now, jobId,
      this.dependencies.analyzer.modelId, this.dependencies.settings.promptVersion,
      this.dependencies.settings.schemaVersion, now, this.runnerId, leaseToken,
    ).run() as { meta?: { changes?: number } };
    if (asChanges(acquired) !== 1) return this.getAnalysisStatus(jobId);

    const job = await this.getAnalysisStatus(jobId);
    if (job === null || job.leaseToken !== leaseToken) return job;
    if (this.configurationMismatch(job)) {
      await this.failConfigurationMismatch(job);
      return this.getAnalysisStatus(jobId);
    }
    try {
      switch (job.stage) {
        case "validate_sources":
          await this.validateSources(job);
          break;
        case "extract_text":
          await this.extractText(job);
          break;
        case "normalize_clips":
          await this.normalizeClips(job);
          break;
        case "extract_evidence":
          await this.extractEvidence(job);
          break;
        case "generate_cards":
          await this.generateCards(job);
          break;
        case "persist_cards":
          await this.persistCards(job);
          break;
        case "done":
          await this.complete(job);
          break;
      }
    } catch (error) {
      await this.handleStageError(job, error);
    }
    return this.getAnalysisStatus(jobId);
  }

  async retryAnalysis(jobId: string, admin: EvidenceAdmin): Promise<EvidenceAnalysisJobRecord> {
    void admin;
    const job = await this.getAnalysisStatus(jobId);
    if (job === null) throw new EvidenceNotFoundError("근거 분석 작업을 찾을 수 없습니다.");
    if (job.status === "review_ready" || job.status === "completed") {
      throw new EvidenceConflictError("완료된 근거 분석 작업은 재시도할 수 없습니다.");
    }
    if (this.configurationMismatch(job)) {
      await this.failConfigurationMismatch(job);
      throw new EvidenceJobConfigurationConflictError();
    }
    const now = this.now();
    const result = await this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs
        SET status='queued',attempt_count=0,error_message=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND stage=? AND input_version=? AND is_stale=0
          AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND content_version=?)
          AND (status='failed' OR lease_expires_at IS NULL OR lease_expires_at<=?)`,
    ).bind(now, job.id, job.stage, job.inputVersion, job.bundleId, job.inputVersion, now).run() as {
      meta?: { changes?: number };
    };
    if (asChanges(result) !== 1) {
      await this.markStaleIfSuperseded(job);
      throw new EvidenceConflictError("근거 분석 작업을 아직 재시도할 수 없습니다.");
    }
    this.scheduleStep(job.id);
    const retried = await this.getAnalysisStatus(job.id);
    if (retried === null) throw new EvidenceNotFoundError("근거 분석 작업을 찾을 수 없습니다.");
    return retried;
  }

  async getAnalysisStatus(jobId: string): Promise<EvidenceAnalysisJobRecord | null> {
    const row = await this.dependencies.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM evidence_analysis_jobs WHERE id=?`,
    ).bind(jobId).first<EvidenceAnalysisJobRecord>();
    return row === null ? null : { ...row, isStale: Boolean(row.isStale) };
  }

  async getLatestAnalysisStatusForBundle(bundleId: string): Promise<EvidenceAnalysisJobRecord | null> {
    const row = await this.dependencies.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM evidence_analysis_jobs
        WHERE bundle_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).bind(bundleId).first<EvidenceAnalysisJobRecord>();
    return row === null ? null : { ...row, isStale: Boolean(row.isStale) };
  }

  private async findByInputVersion(bundleId: string, inputVersion: string): Promise<EvidenceAnalysisJobRecord | null> {
    const row = await this.dependencies.db.prepare(
      `SELECT ${JOB_COLUMNS} FROM evidence_analysis_jobs WHERE bundle_id=? AND input_version=?`,
    ).bind(bundleId, inputVersion).first<EvidenceAnalysisJobRecord>();
    return row === null ? null : { ...row, isStale: Boolean(row.isStale) };
  }

  private async sources(bundleId: string): Promise<EvidenceSourceRow[]> {
    return (await this.dependencies.db.prepare(
      `SELECT id,bundle_id AS bundleId,content_hash AS contentHash,storage_key AS storageKey,
        extracted_text_key AS extractedTextKey,extraction_status AS extractionStatus,extraction_error AS extractionError
        FROM evidence_sources WHERE bundle_id=? ORDER BY id`,
    ).bind(bundleId).all<EvidenceSourceRow>()).results;
  }

  private async chunks(job: EvidenceAnalysisJobRecord): Promise<EvidenceChunkInput[]> {
    return (await this.dependencies.db.prepare(
      `SELECT chunk.id,chunk.location_label AS locationLabel,chunk.content
        FROM evidence_chunks AS chunk
        WHERE chunk.bundle_id=? AND chunk.input_version=?
          AND ((chunk.source_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM evidence_sources AS source
            WHERE source.id=chunk.source_id AND source.bundle_id=chunk.bundle_id
              AND source.extraction_status='completed'
          )) OR (chunk.video_clip_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM evidence_video_clips AS clip
            WHERE clip.id=chunk.video_clip_id AND clip.bundle_id=chunk.bundle_id
          )))
        ORDER BY chunk.source_id,chunk.video_clip_id,chunk.ordinal,chunk.id`,
    ).bind(job.bundleId, job.inputVersion).all<EvidenceChunkInput>()).results;
  }

  private guard(job: EvidenceAnalysisJobRecord, checkpointAt: number): unknown[] {
    return [
      job.id, job.stage, this.runnerId, job.leaseToken, checkpointAt,
      job.analyzerModel, job.promptVersion, job.schemaVersion,
    ];
  }

  private checkpointStatement(job: EvidenceAnalysisJobRecord, next: EvidenceAnalysisJobStage, now: number): EvidenceD1Statement {
    return this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs
        SET stage=?,attempt_count=0,error_message=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND stage=? AND lease_owner=? AND lease_token=? AND lease_expires_at>? AND is_stale=0
          AND analyzer_model=? AND prompt_version=? AND schema_version=?
          AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND content_version=?)`,
    ).bind(
      next, now, job.id, job.stage, this.runnerId, job.leaseToken, now,
      job.analyzerModel, job.promptVersion, job.schemaVersion, job.bundleId, job.inputVersion,
    );
  }

  private async commitCheckpoint(
    job: EvidenceAnalysisJobRecord,
    next: EvidenceAnalysisJobStage,
    statements: EvidenceD1Statement[],
    checkpointAt: number,
  ): Promise<boolean> {
    const results = await this.dependencies.db.batch([
      ...statements,
      this.checkpointStatement(job, next, checkpointAt),
    ]);
    const committed = asChanges(results.at(-1)) === 1;
    if (!committed) await this.markStaleIfSuperseded(job);
    return committed;
  }

  private async validateSources(job: EvidenceAnalysisJobRecord): Promise<void> {
    const outcomes = await Promise.all((await this.sources(job.bundleId)).map(async (source) => {
      if (source.extractionStatus === "failed") return null;
      try {
        const object = await this.dependencies.files.getFile(source.storageKey);
        if (object === null) throw new Error("원본 근거 파일을 찾을 수 없습니다.");
        if (await sha256(await objectBytes(object)) !== source.contentHash) {
          throw new Error("원본 근거 파일 무결성 검사에 실패했습니다.");
        }
        return null;
      } catch (error) {
        return { source, error: error instanceof Error ? error.message : "원본 근거 파일을 검사할 수 없습니다." };
      }
    }));
    const now = this.now();
    const statements = outcomes.flatMap((outcome) => outcome === null ? [] : [
      this.dependencies.db.prepare(
        `UPDATE evidence_sources SET extraction_status='failed',extraction_error=?,updated_at=?
          WHERE id=? AND bundle_id=? AND ${CHECKPOINT_GUARD}`,
      ).bind(outcome.error, now, outcome.source.id, job.bundleId, ...this.guard(job, now)),
    ]);
    if (await this.commitCheckpoint(job, "extract_text", statements, now)) this.scheduleStep(job.id);
  }

  private async extractText(job: EvidenceAnalysisJobRecord): Promise<void> {
    const outcomes = await Promise.all((await this.sources(job.bundleId)).map(async (source) => {
      if (source.extractionStatus === "failed") return { source, pages: [] as ExtractedPage[], error: null };
      try {
        if (source.extractedTextKey === null) throw new Error("추출 텍스트를 찾을 수 없습니다.");
        const object = await this.dependencies.files.getFile(source.extractedTextKey);
        if (object === null) throw new Error("추출 텍스트를 찾을 수 없습니다.");
        const parsed = JSON.parse(await objectText(object)) as unknown;
        return { source, pages: extractedPages(parsed), error: null };
      } catch (error) {
        return {
          source,
          pages: [] as ExtractedPage[],
          error: error instanceof Error ? error.message : "추출 텍스트를 읽을 수 없습니다.",
        };
      }
    }));
    const now = this.now();
    const statements: EvidenceD1Statement[] = [];
    for (const outcome of outcomes) {
      if (outcome.error !== null) {
        statements.push(this.dependencies.db.prepare(
          `UPDATE evidence_sources SET extraction_status='failed',extraction_error=?,updated_at=?
            WHERE id=? AND bundle_id=? AND ${CHECKPOINT_GUARD}`,
        ).bind(outcome.error, now, outcome.source.id, job.bundleId, ...this.guard(job, now)));
        continue;
      }
      let ordinal = 0;
      for (const page of outcome.pages) {
        for (const piece of splitUtf8(page.text, EVIDENCE_CHUNK_MAX_BYTES)) {
          statements.push(this.dependencies.db.prepare(
            `INSERT INTO evidence_chunks
              (id,bundle_id,input_version,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
              SELECT ?,?,?,?,NULL,?,?,?,?,? WHERE ${CHECKPOINT_GUARD}`,
          ).bind(
            this.id(), job.bundleId, job.inputVersion, outcome.source.id, ordinal, page.locator, piece, await sha256(piece), now,
            ...this.guard(job, now),
          ));
          ordinal += 1;
        }
      }
    }
    if (await this.commitCheckpoint(job, "normalize_clips", statements, now)) this.scheduleStep(job.id);
  }

  private async normalizeClips(job: EvidenceAnalysisJobRecord): Promise<void> {
    const clips = (await this.dependencies.db.prepare(
      `SELECT id,url,start_ms AS startMs,end_ms AS endMs,observation
        FROM evidence_video_clips WHERE bundle_id=? ORDER BY id`,
    ).bind(job.bundleId).all<EvidenceVideoClipRow>()).results;
    const now = this.now();
    const statements: EvidenceD1Statement[] = [];
    for (const clip of clips) {
      const location = `${clip.url}#t=${clip.startMs},${clip.endMs}`;
      for (const [ordinal, piece] of splitUtf8(clip.observation, EVIDENCE_CHUNK_MAX_BYTES).entries()) {
        statements.push(this.dependencies.db.prepare(
          `INSERT INTO evidence_chunks
            (id,bundle_id,input_version,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
            SELECT ?,?,?,NULL,?,?,?,?,?,? WHERE ${CHECKPOINT_GUARD}`,
        ).bind(
          this.id(), job.bundleId, job.inputVersion, clip.id, ordinal, location, piece, await sha256(piece), now,
          ...this.guard(job, now),
        ));
      }
    }
    if (await this.commitCheckpoint(job, "extract_evidence", statements, now)) this.scheduleStep(job.id);
  }

  private async extractEvidence(job: EvidenceAnalysisJobRecord): Promise<void> {
    const chunks = await this.chunks(job);
    const result = await this.dependencies.analyzer.analyzeExtraction(
      { chunks, promptVersion: job.promptVersion },
      new AbortController().signal,
    );
    const extracted = parseExtractedEvidence(result, chunks);
    const extractedJson = boundedJson(
      extracted, EVIDENCE_CHECKPOINT_MAX_BYTES, "추출 근거 결과가 저장 가능한 크기를 초과했습니다.",
    );
    const now = this.now();
    const statement = this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs SET extracted_evidence_json=?,updated_at=?
        WHERE id=? AND ${CHECKPOINT_GUARD}`,
    ).bind(extractedJson, now, job.id, ...this.guard(job, now));
    if (await this.commitCheckpoint(job, "generate_cards", [statement], now)) this.scheduleStep(job.id);
  }

  private async generateCards(job: EvidenceAnalysisJobRecord): Promise<void> {
    const chunks = await this.chunks(job);
    const extracted = parseExtractedEvidence(JSON.parse(job.extractedEvidenceJson ?? "null") as unknown, chunks);
    const allowedCitationIds = chunks.map((chunk) => chunk.id);
    const result = await this.dependencies.analyzer.generateCards({
      extracted,
      allowedCitationIds,
      promptVersion: job.promptVersion,
      schemaVersion: job.schemaVersion,
    }, new AbortController().signal);
    const cards = parseAnalyzerCards(result, allowedCitationIds, extractedCitationIds(extracted));
    for (const card of cards) {
      boundedJson(card, EVIDENCE_CARD_MAX_BYTES, "전술 카드가 저장 가능한 크기를 초과했습니다.");
    }
    const cardsJson = boundedJson(
      cards, EVIDENCE_CHECKPOINT_MAX_BYTES, "전술 카드 결과가 저장 가능한 크기를 초과했습니다.",
    );
    const now = this.now();
    const statement = this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs SET generated_cards_json=?,updated_at=?
        WHERE id=? AND ${CHECKPOINT_GUARD}`,
    ).bind(cardsJson, now, job.id, ...this.guard(job, now));
    if (await this.commitCheckpoint(job, "persist_cards", [statement], now)) this.scheduleStep(job.id);
  }

  private async persistCards(job: EvidenceAnalysisJobRecord): Promise<void> {
    const chunks = await this.chunks(job);
    const extracted = parseExtractedEvidence(JSON.parse(job.extractedEvidenceJson ?? "null") as unknown, chunks);
    const cards = parseAnalyzerCards(
      JSON.parse(job.generatedCardsJson ?? "null") as unknown,
      chunks,
      extractedCitationIds(extracted),
    );
    const now = this.now();
    const statements: EvidenceD1Statement[] = [];
    for (const card of cards) {
      const cardId = this.id();
      const contentJson = boundedJson(
        card, EVIDENCE_CARD_MAX_BYTES, "전술 카드가 저장 가능한 크기를 초과했습니다.", false,
      );
      statements.push(this.dependencies.db.prepare(
        `INSERT INTO tactic_cards
          (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
          SELECT ?,?,?,?,'analysis_draft',?,?,0,?,? WHERE ${CHECKPOINT_GUARD}`,
      ).bind(cardId, job.bundleId, job.id, job.inputVersion, contentJson, contentJson, now, now, ...this.guard(job, now)));
      for (const chunkId of citationIds(card)) {
        statements.push(this.dependencies.db.prepare(
          `INSERT INTO tactic_card_citations (id,bundle_id,card_id,chunk_id,created_at)
            SELECT ?,?,?,?,? WHERE ${CHECKPOINT_GUARD}
              AND EXISTS (SELECT 1 FROM evidence_chunks WHERE id=? AND bundle_id=? AND input_version=?)`,
        ).bind(
          this.id(), job.bundleId, cardId, chunkId, now, ...this.guard(job, now), chunkId, job.bundleId, job.inputVersion,
        ));
      }
    }
    if (await this.commitCheckpoint(job, "done", statements, now)) this.scheduleStep(job.id);
  }

  private async complete(job: EvidenceAnalysisJobRecord): Promise<void> {
    const now = this.now();
    const result = await this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs
        SET status='review_ready',completed_at=?,attempt_count=0,error_message=NULL,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND stage='done' AND lease_owner=? AND lease_token=? AND lease_expires_at>? AND is_stale=0
          AND analyzer_model=? AND prompt_version=? AND schema_version=?
          AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND content_version=?)`,
    ).bind(
      now, now, job.id, this.runnerId, job.leaseToken, now,
      job.analyzerModel, job.promptVersion, job.schemaVersion, job.bundleId, job.inputVersion,
    ).run() as { meta?: { changes?: number } };
    if (asChanges(result) !== 1) await this.markStaleIfSuperseded(job);
  }

  private async handleStageError(job: EvidenceAnalysisJobRecord, error: unknown): Promise<void> {
    const retryable = error instanceof EvidenceAnalyzerError && error.retryable;
    const attemptCount = job.attemptCount + 1;
    const retry = retryable && attemptCount < MAX_ANALYZER_ATTEMPTS;
    const now = this.now();
    const result = await this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs
        SET status=?,attempt_count=?,error_message=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND stage=? AND lease_owner=? AND lease_token=? AND lease_expires_at>? AND is_stale=0
          AND analyzer_model=? AND prompt_version=? AND schema_version=?
          AND EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND content_version=?)`,
    ).bind(
      retry ? "queued" : "failed", attemptCount, safeMessage(error), now,
      job.id, job.stage, this.runnerId, job.leaseToken, now,
      job.analyzerModel, job.promptVersion, job.schemaVersion, job.bundleId, job.inputVersion,
    ).run() as { meta?: { changes?: number } };
    if (asChanges(result) === 1 && retry) this.scheduleStep(job.id);
    else if (asChanges(result) !== 1) await this.markStaleIfSuperseded(job);
  }

  private async markStaleIfSuperseded(job: EvidenceAnalysisJobRecord): Promise<void> {
    const bundle = await this.dependencies.db.prepare(
      "SELECT content_version AS contentVersion FROM evidence_bundles WHERE id=?",
    ).bind(job.bundleId).first<{ contentVersion: string }>();
    if (bundle?.contentVersion === job.inputVersion) return;
    await this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs
        SET status='failed',is_stale=1,error_message='evidence version superseded',
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND input_version=?`,
    ).bind(this.now(), job.id, job.inputVersion).run();
  }

  private canContinue(job: EvidenceAnalysisJobRecord, now: number): boolean {
    return !job.isStale
      && (job.status === "queued" || job.status === "running")
      && (job.leaseExpiresAt === null || job.leaseExpiresAt <= now);
  }

  private configurationMismatch(job: EvidenceAnalysisJobRecord): boolean {
    return job.analyzerModel !== this.dependencies.analyzer.modelId
      || job.promptVersion !== this.dependencies.settings.promptVersion
      || job.schemaVersion !== this.dependencies.settings.schemaVersion;
  }

  private async failConfigurationMismatch(job: EvidenceAnalysisJobRecord): Promise<void> {
    await this.dependencies.db.prepare(
      `UPDATE evidence_analysis_jobs
        SET status='failed',attempt_count=attempt_count+1,
          error_message='분석 설정 버전이 현재 실행 환경과 일치하지 않습니다.',
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND analyzer_model=? AND prompt_version=? AND schema_version=?
          AND status IN ('queued','running')`,
    ).bind(
      this.now(), job.id, job.analyzerModel, job.promptVersion, job.schemaVersion,
    ).run();
  }

  private scheduleStep(jobId: string): void {
    let release!: () => void;
    let cancel!: (error: unknown) => void;
    const registration = new Promise<void>((resolve, reject) => {
      release = resolve;
      cancel = reject;
    });
    const continuation = registration.then(() => this.runAnalysisStep(jobId));
    try {
      this.dependencies.schedule(continuation);
      release();
    } catch (error) {
      void continuation.catch(() => undefined);
      cancel(error);
      throw error;
    }
  }

  private async refreshBundleVersion(bundleId: string): Promise<{ id: string; contentVersion: string }> {
    const bundle = await this.dependencies.db.prepare(
      "SELECT id,purpose,content_version AS contentVersion FROM evidence_bundles WHERE id=?",
    ).bind(bundleId).first<{ id: string; purpose: string; contentVersion: string }>();
    if (bundle === null) throw new EvidenceNotFoundError("근거 묶음을 찾을 수 없습니다.");
    const sourceHashes = (await this.dependencies.db.prepare(
      "SELECT content_hash AS contentHash FROM evidence_sources WHERE bundle_id=? ORDER BY content_hash",
    ).bind(bundleId).all<{ contentHash: string }>()).results.map((source) => source.contentHash);
    const clips = (await this.dependencies.db.prepare(
      `SELECT url,start_ms AS startMs,end_ms AS endMs,observation
        FROM evidence_video_clips WHERE bundle_id=? ORDER BY id`,
    ).bind(bundleId).all<EvidenceVideoClipRow>()).results;
    const contentVersion = await computeEvidenceVersion({
      purpose: bundle.purpose,
      sourceHashes,
      clips,
      ...this.dependencies.settings,
    });
    if (contentVersion === bundle.contentVersion) return { id: bundle.id, contentVersion };
    const now = this.now();
    const guard = "EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND content_version=?)";
    const results = await this.dependencies.db.batch([
      this.dependencies.db.prepare(
        `UPDATE evidence_analysis_jobs SET status='failed',is_stale=1,error_message='evidence version superseded',updated_at=?
          WHERE bundle_id=? AND input_version<>? AND ${guard}`,
      ).bind(now, bundleId, contentVersion, bundleId, bundle.contentVersion),
      this.dependencies.db.prepare(
        `UPDATE tactic_cards SET is_stale=1,
          status=CASE WHEN status IN ('analysis_draft','owner_reviewed','coach_reviewed') THEN 'held' ELSE status END,
          updated_at=?
          WHERE bundle_id=? AND bundle_version<>? AND ${guard}`,
      ).bind(now, bundleId, contentVersion, bundleId, bundle.contentVersion),
      this.dependencies.db.prepare(
        "UPDATE evidence_bundles SET content_version=?,version=version+1,updated_at=? WHERE id=? AND content_version=?",
      ).bind(contentVersion, now, bundleId, bundle.contentVersion),
    ]);
    if (asChanges(results.at(-1)) !== 1)
      throw new EvidenceConflictError("근거 묶음 버전이 변경되어 분석을 시작할 수 없습니다.");
    return { id: bundle.id, contentVersion };
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private id(): string {
    return this.dependencies.newId?.() ?? crypto.randomUUID();
  }
}
