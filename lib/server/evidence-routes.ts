import { EvidenceValidationError } from "../domain/evidence.ts";
import { EvidenceSearchValidationError } from "../domain/evidence-search.ts";
import { EvidenceAnalyzerError } from "./evidence-analyzer.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import {
  EvidenceConflictError,
  EvidencePayloadTooLargeError,
  EvidencePublicError,
  EvidenceRequestValidationError,
  EvidenceUnsupportedMediaTypeError,
} from "./evidence-errors.ts";
import type {
  EvidenceAnalysisJobRecord,
  EvidenceAnalysisJobs,
} from "./evidence-jobs.ts";
import type {
  EvidenceExternalSearchJobs,
  EvidenceSearchCandidateRecord,
  EvidenceSearchRunDetail,
  EvidenceSearchRunRecord,
} from "./evidence-search-jobs.ts";
import { EvidenceSearchError } from "./openai-evidence-search.ts";
import {
  type EvidenceBundleDetail,
  type EvidenceBundleRecord,
  type EvidenceCardAdminDetail,
  type EvidenceCardRecord,
  type EvidenceScenarioDraftRecord,
  type EvidenceService,
} from "./evidence-service.ts";
import type {
  EvidenceFileStore,
  StoredEvidenceFile,
} from "./evidence-storage.ts";

const MAX_EVIDENCE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MULTIPART_REQUEST_BYTES = MAX_EVIDENCE_FILE_BYTES + 64 * 1024;
const JOB_CARD_PAGE_SIZE = 20;
const JOB_CARD_CITATION_LIMIT = 20;
const JOB_EXCERPT_MAX_BYTES = 2_000;
const JOB_AGGREGATE_EXCERPT_MAX_BYTES = 32 * 1024;
const EXTERNAL_CITATION_URL_MAX_BYTES = 4 * 1024;
const EXTERNAL_CITATION_PUBLISHER_MAX_LENGTH = 160;

type RouteContext<T extends Record<string, string>> = { params: Promise<T> };

export type EvidenceRouteRuntime = {
  admin: EvidenceAdmin;
  service: Pick<
    EvidenceService,
    | "listBundlesForAdmin"
    | "createBundle"
    | "getBundleForAdmin"
    | "updateBundle"
    | "addVideoClip"
    | "describeDeleteImpact"
    | "removeSource"
    | "reviewCard"
    | "createScenarioDraft"
    | "listCardsForJob"
  >;
  fileStore: Pick<EvidenceFileStore, "putValidatedFile" | "getFile">;
  jobs: Pick<
    EvidenceAnalysisJobs,
    "startAnalysis" | "retryAnalysis" | "getAnalysisStatus" | "getLatestAnalysisStatusForBundle"
  >;
  searchJobs: Pick<
    EvidenceExternalSearchJobs,
    "startSearch" | "getLatestSearch" | "getSearch" | "saveSelection" | "startImport"
  >;
};

type EvidenceAuthorizer = (
  request: Request,
) => Promise<EvidenceAdmin | Response>;
type EvidenceRuntimeFactory = (
  admin: EvidenceAdmin,
) => EvidenceRouteRuntime | Promise<EvidenceRouteRuntime>;

function adminJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store");
  headers.delete("access-control-allow-origin");
  return Response.json(body, { ...init, headers });
}

function protectAdminResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.delete("access-control-allow-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(message: string, status: number): Response {
  return adminJson({ error: message }, { status });
}

function routeFailure(error: unknown): Response {
  if (error instanceof EvidencePublicError) {
    const messages = {
      400: "근거 자료 요청이 올바르지 않습니다.",
      404: "요청한 근거 자료를 찾을 수 없습니다.",
      409: "근거 자료가 다른 변경으로 갱신되었습니다. 다시 시도해 주세요.",
      413: "업로드 요청이 허용된 크기를 초과했습니다.",
      415: "지원하지 않거나 올바르지 않은 파일 형식입니다.",
      503: "근거 자료 서비스를 사용할 수 없습니다.",
    } as const;
    return jsonError(messages[error.status], error.status);
  }
  if (error instanceof EvidenceValidationError)
    return jsonError("근거 자료 요청이 올바르지 않습니다.", 400);
  if (error instanceof EvidenceSearchValidationError)
    return jsonError("근거 자료 요청이 올바르지 않습니다.", 400);
  if (error instanceof EvidenceAnalyzerError) {
    return jsonError("근거 분석 서비스를 사용할 수 없습니다.", 503);
  }
  if (error instanceof EvidenceSearchError)
    return jsonError("외부 출처 검색 서비스를 사용할 수 없습니다.", 503);
  if (error instanceof AggregateError)
    return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
  return jsonError("근거 자료 요청을 처리하지 못했습니다.", 500);
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new EvidenceRequestValidationError("요청 JSON을 확인할 수 없습니다.");
  }
}

function safeSource(source: StoredEvidenceFile) {
  return {
    id: source.id,
    bundleId: source.bundleId,
    originalFileName: source.originalFileName,
    mediaType: source.mediaType,
    byteSize: source.byteSize,
    contentHash: source.contentHash,
    extractionStatus: source.extractionStatus,
    extractionError:
      source.extractionError === null
        ? null
        : "근거 텍스트를 준비하지 못했습니다.",
  };
}

function safeBundle(bundle: EvidenceBundleRecord) {
  return {
    id: bundle.id,
    title: bundle.title,
    purpose: bundle.purpose,
    version: bundle.version,
    contentVersion: bundle.contentVersion,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
  };
}

function safeBundleDetail(bundle: EvidenceBundleDetail) {
  return {
    ...safeBundle(bundle),
    sources: bundle.sources.map(safeSource),
    videoClips: bundle.videoClips,
  };
}

function safeJob(job: EvidenceAnalysisJobRecord) {
  return {
    id: job.id,
    bundleId: job.bundleId,
    inputVersion: job.inputVersion,
    status: job.status,
    stage: job.stage,
    errorMessage:
      job.errorMessage === null
        ? null
        : "근거 분석 작업을 완료하지 못했습니다.",
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attemptCount: job.attemptCount,
    isStale: job.isStale,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function safeSearchRun(run: EvidenceSearchRunRecord) {
  return {
    id: run.id,
    bundleId: run.bundleId,
    bundleVersion: run.bundleVersion,
    status: run.status,
    errorMessage:
      run.errorMessage === null
        ? null
        : "외부 출처 검색을 완료하지 못했습니다.",
    isStale: run.isStale,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function safeSearchStart(run: EvidenceSearchRunRecord) {
  return {
    id: run.id,
    bundleId: run.bundleId,
    status: run.status,
  };
}

function safeSearchCandidate(candidate: EvidenceSearchCandidateRecord) {
  return {
    id: candidate.id,
    title: candidate.title,
    publisher: candidate.publisher,
    publishedAt: candidate.publishedAt,
    canonicalUrl: candidate.canonicalUrl,
    documentType: candidate.documentType,
    quote: candidate.quote,
    relevance: candidate.relevance,
    trustTier: candidate.trustTier,
    rank: candidate.rank,
    status: candidate.status,
    failureReason:
      candidate.failureReason === null
        ? null
        : "외부 문서를 가져오지 못했습니다.",
  };
}

function safeSearchDetail(detail: EvidenceSearchRunDetail) {
  return {
    run: safeSearchRun(detail.run),
    candidates: detail.candidates.map(safeSearchCandidate),
  };
}

async function requireSearchBundle(
  bundleId: string,
  runtime: EvidenceRouteRuntime,
): Promise<Response | undefined> {
  const bundle = await runtime.service.getBundleForAdmin(bundleId, runtime.admin);
  if (bundle === null) return jsonError("근거 묶음을 찾을 수 없습니다.", 404);
}

function safeCard(card: EvidenceCardRecord) {
  let content: unknown;
  try {
    content = JSON.parse(card.currentContentJson);
  } catch {
    content = null;
  }
  return {
    id: card.id,
    bundleId: card.bundleId,
    jobId: card.jobId,
    bundleVersion: card.bundleVersion,
    status: card.status,
    content,
    isStale: card.isStale,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  const buffer = new Uint8Array(maximumBytes);
  const { read } = encoder.encodeInto(value, buffer);
  return value.slice(0, read);
}

function safeExternalCitationMetadata(citation: EvidenceCardAdminDetail["citations"][number]) {
  if (citation.origin !== "external_web") return { origin: citation.origin };
  if (typeof citation.canonicalUrl !== "string" || typeof citation.publisher !== "string"
    || typeof citation.publishedAt !== "string" || typeof citation.retrievedAt !== "number"
    || citation.publisher.trim() === "" || citation.publisher.length > EXTERNAL_CITATION_PUBLISHER_MAX_LENGTH
    || !/^\d{4}-\d{2}-\d{2}$/.test(citation.publishedAt)
    || !Number.isSafeInteger(citation.retrievedAt) || citation.retrievedAt < 0
    || new TextEncoder().encode(citation.canonicalUrl).byteLength > EXTERNAL_CITATION_URL_MAX_BYTES) {
    return { origin: citation.origin };
  }
  try {
    const url = new URL(citation.canonicalUrl);
    if (url.protocol !== "https:" || url.username || url.password) return { origin: citation.origin };
  } catch {
    return { origin: citation.origin };
  }
  return {
    origin: citation.origin,
    canonicalUrl: citation.canonicalUrl,
    publisher: citation.publisher,
    publishedAt: citation.publishedAt,
    retrievedAt: citation.retrievedAt,
  };
}

function safeCardDetail(card: EvidenceCardAdminDetail, budget: { remaining: number }) {
  return {
    ...safeCard(card),
    citationCount: card.citationCount,
    citations: card.citations.slice(0, JOB_CARD_CITATION_LIMIT).map((citation) => {
      const excerpt = truncateUtf8(citation.content, Math.min(JOB_EXCERPT_MAX_BYTES, budget.remaining));
      budget.remaining -= new TextEncoder().encode(excerpt).byteLength;
      return { chunkId: citation.chunkId, sourceId: citation.sourceId, videoClipId: citation.videoClipId,
        locationLabel: citation.locationLabel, excerpt, ...safeExternalCitationMetadata(citation) };
    }),
  };
}

function safeScenario(scenario: EvidenceScenarioDraftRecord) {
  return {
    id: scenario.id,
    campaignId: scenario.campaignId,
    role: scenario.role,
    principle: scenario.principle,
    prompt: scenario.prompt,
    hint: scenario.hint,
    explanation: scenario.explanation,
    reviewStatus: scenario.reviewStatus,
    orderIndex: scenario.orderIndex,
  };
}

async function bundleWithSource(
  bundleId: string,
  sourceId: string,
  runtime: EvidenceRouteRuntime,
): Promise<
  { bundle: EvidenceBundleDetail; source: StoredEvidenceFile } | Response
> {
  const bundle = await runtime.service.getBundleForAdmin(
    bundleId,
    runtime.admin,
  );
  if (bundle === null) return jsonError("근거 묶음을 찾을 수 없습니다.", 404);
  const source = bundle.sources.find((candidate) => candidate.id === sourceId);
  if (!source) return jsonError("근거 파일을 찾을 수 없습니다.", 404);
  return { bundle, source };
}

/**
 * Production entrypoints pass the non-injectable admin guard and runtime factory.
 * Authorization always completes before bindings, request bodies, or records are touched.
 */
export async function runEvidenceAdminRoute(
  request: Request,
  authorize: EvidenceAuthorizer,
  createRuntime: EvidenceRuntimeFactory,
  handle: (runtime: EvidenceRouteRuntime) => Promise<Response>,
): Promise<Response> {
  const decision = await authorize(request);
  if (decision instanceof Response) return protectAdminResponse(decision);
  let runtime: EvidenceRouteRuntime;
  try {
    runtime = await createRuntime(decision);
  } catch {
    return jsonError("근거 자료 서비스를 사용할 수 없습니다.", 503);
  }
  try {
    return protectAdminResponse(await handle(runtime));
  } catch (error) {
    return routeFailure(error);
  }
}

export function bindEvidenceSchedule(
  waitUntil: (promise: Promise<unknown>) => void,
) {
  return (promise: Promise<unknown>): void => waitUntil(promise);
}

export async function handleEvidenceCollectionList(
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const bundles = await runtime.service.listBundlesForAdmin(runtime.admin);
    return adminJson({ bundles: bundles.map(safeBundle) });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceCollectionCreate(
  request: Request,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const bundle = await runtime.service.createBundle(
      await parseJson(request),
      runtime.admin,
    );
    return adminJson({ bundle: safeBundle(bundle) }, { status: 201 });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceBundleGet(
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const bundle = await runtime.service.getBundleForAdmin(
      bundleId,
      runtime.admin,
    );
    if (bundle === null) return jsonError("근거 묶음을 찾을 수 없습니다.", 404);
    const latestJob = await runtime.jobs.getLatestAnalysisStatusForBundle(bundleId);
    return adminJson({
      bundle: safeBundleDetail(bundle),
      latestJob: latestJob === null ? null : safeJob(latestJob),
    });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceBundleUpdate(
  request: Request,
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const input = await parseJson(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new EvidenceValidationError("근거 묶음 수정 입력이 필요합니다.");
    }
    const bundle = await runtime.service.updateBundle(
      bundleId,
      input,
      runtime.admin,
    );
    return adminJson({ bundle: safeBundle(bundle) });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceFileUpload(
  request: Request,
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const bundle = await runtime.service.getBundleForAdmin(
      bundleId,
      runtime.admin,
    );
    if (bundle === null) return jsonError("근거 묶음을 찾을 수 없습니다.", 404);
    if (!/^multipart\/form-data(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
      return jsonError("multipart/form-data 파일 업로드가 필요합니다.", 415);
    }
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength))
        return jsonError("Content-Length가 올바르지 않습니다.", 400);
      if (Number(declaredLength) > MAX_MULTIPART_REQUEST_BYTES) {
        return routeFailure(new EvidencePayloadTooLargeError());
      }
    }
    if (request.body === null)
      return jsonError("업로드할 파일이 필요합니다.", 400);
    if (request.signal.aborted)
      return jsonError("파일 업로드가 중단되었습니다.", 400);
    let total = 0;
    let overflowed = false;
    let aborted = false;
    let streamTerminated = false;
    const reader = request.body.getReader();
    let cancelPromise: Promise<void> | undefined;
    const cancelReader = (reason: unknown) => {
      cancelPromise ??= reader.cancel(reason).catch(() => undefined);
      return cancelPromise;
    };
    const abortError = new DOMException("Evidence upload was aborted.", "AbortError");
    let boundedController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const onAbort = () => {
      aborted = true;
      if (streamTerminated) return;
      streamTerminated = true;
      boundedController?.error(abortError);
      void cancelReader(abortError);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const boundedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        boundedController = controller;
        if (aborted) controller.error(abortError);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (streamTerminated) return;
          if (done) {
            streamTerminated = true;
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > MAX_MULTIPART_REQUEST_BYTES) {
            overflowed = true;
            streamTerminated = true;
            controller.error(new EvidencePayloadTooLargeError());
            await cancelReader(new EvidencePayloadTooLargeError());
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          if (streamTerminated) return;
          streamTerminated = true;
          controller.error(error);
        }
      },
      async cancel(reason) {
        streamTerminated = true;
        await cancelReader(reason);
      },
    });
    let form: FormData;
    try {
      form = await new Response(boundedBody, {
        headers: { "content-type": request.headers.get("content-type")! },
      }).formData();
    } catch {
      if (overflowed) return routeFailure(new EvidencePayloadTooLargeError());
      if (aborted || request.signal.aborted)
        return jsonError("파일 업로드가 중단되었습니다.", 400);
      return jsonError("파일 업로드 형식을 확인할 수 없습니다.", 400);
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      boundedController = undefined;
    }
    if (aborted || request.signal.aborted)
      return jsonError("파일 업로드가 중단되었습니다.", 400);
    const entries = [...form.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== "file") {
      return jsonError("하나의 file 항목만 업로드할 수 있습니다.", 400);
    }
    const candidate = entries[0][1];
    if (!(candidate instanceof File))
      return jsonError("업로드할 파일이 필요합니다.", 400);
    if (candidate.size > MAX_EVIDENCE_FILE_BYTES) {
      return jsonError("파일은 20MB 이하여야 합니다.", 413);
    }
    try {
      const bytes = new Uint8Array(await candidate.arrayBuffer());
      if (aborted || request.signal.aborted)
        return jsonError("파일 업로드가 중단되었습니다.", 400);
      const source = await runtime.fileStore.putValidatedFile({
        bundleId,
        name: candidate.name,
        type: candidate.type,
        bytes,
      }, { abortSignal: request.signal });
      return adminJson({ source: safeSource(source) }, { status: 201 });
    } catch (error) {
      if (aborted || request.signal.aborted)
        return jsonError("파일 업로드가 중단되었습니다.", 400);
      if (error instanceof EvidenceValidationError)
        return routeFailure(new EvidenceUnsupportedMediaTypeError());
      if (error instanceof EvidencePublicError) return routeFailure(error);
      return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
    }
  } catch (error) {
    return routeFailure(error);
  }
}

function cleanDisplayFilename(value: string): string {
  const cleaned = [...value.normalize("NFC")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 ||
        codePoint === 127 ||
        character === "/" ||
        character === "\\"
        ? "_"
        : character;
    })
    .join("")
    .trim();
  return cleaned || "evidence-file";
}

function attachmentDisposition(value: string): string {
  const filename = cleanDisplayFilename(value);
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/[";]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function downloadBody(value: unknown): BodyInit | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return new Blob([copy.buffer]);
  }
  if (typeof value === "object" && value !== null && "body" in value) {
    const body = (value as { body?: unknown }).body;
    if (body instanceof ReadableStream) return body;
  }
  return null;
}

export async function handleEvidenceFileDownload(
  context: RouteContext<{ bundleId: string; sourceId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId, sourceId } = await context.params;
    const located = await bundleWithSource(bundleId, sourceId, runtime);
    if (located instanceof Response) return located;
    let object: unknown | null;
    try {
      object = await runtime.fileStore.getFile(located.source.storageKey);
    } catch {
      return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
    }
    if (object === null) return jsonError("근거 파일을 찾을 수 없습니다.", 404);
    const body = downloadBody(object);
    if (body === null)
      return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
    return new Response(body, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": attachmentDisposition(
          located.source.originalFileName,
        ),
        "content-length": String(located.source.byteSize),
        "content-type": located.source.mediaType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceFileImpact(
  context: RouteContext<{ bundleId: string; sourceId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId, sourceId } = await context.params;
    const located = await bundleWithSource(bundleId, sourceId, runtime);
    if (located instanceof Response) return located;
    return adminJson({
      impact: await runtime.service.describeDeleteImpact(sourceId),
    });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceFileDelete(
  context: RouteContext<{ bundleId: string; sourceId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId, sourceId } = await context.params;
    const located = await bundleWithSource(bundleId, sourceId, runtime);
    if (located instanceof Response) return located;
    const bundle = await runtime.service.removeSource(sourceId, runtime.admin);
    return adminJson({ bundle: safeBundle(bundle), removedSourceId: sourceId });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceClipCreate(
  request: Request,
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const bundle = await runtime.service.addVideoClip(
      bundleId,
      await parseJson(request),
      runtime.admin,
    );
    return adminJson({ bundle: safeBundle(bundle) }, { status: 201 });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceAnalyzeStart(
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const job = await runtime.jobs.startAnalysis(bundleId, runtime.admin);
    return adminJson({ job: safeJob(job) }, { status: 202 });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceSearchStart(
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const missing = await requireSearchBundle(bundleId, runtime);
    if (missing) return missing;
    const search = await runtime.searchJobs.startSearch(bundleId, runtime.admin);
    if (search.status !== "queued" && search.status !== "searching" && search.status !== "ready") {
      throw new EvidenceConflictError();
    }
    const status = search.status === "ready" ? 200 : 202;
    return adminJson({ search: safeSearchStart(search) }, { status });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceSearchLatest(
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const missing = await requireSearchBundle(bundleId, runtime);
    if (missing) return missing;
    const search = await runtime.searchJobs.getLatestSearch(bundleId);
    return adminJson({
      search: search === null ? null : safeSearchDetail(search),
    });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceSearchGet(
  context: RouteContext<{ bundleId: string; runId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId, runId } = await context.params;
    const missing = await requireSearchBundle(bundleId, runtime);
    if (missing) return missing;
    const search = await runtime.searchJobs.getSearch(bundleId, runId);
    if (search === null)
      return jsonError("외부 출처 검색 작업을 찾을 수 없습니다.", 404);
    return adminJson({ search: safeSearchDetail(search) });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceSearchSelection(
  request: Request,
  context: RouteContext<{ bundleId: string; runId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId, runId } = await context.params;
    const input = await parseJson(request);
    const missing = await requireSearchBundle(bundleId, runtime);
    if (missing) return missing;
    const search = await runtime.searchJobs.saveSelection(
      bundleId,
      runId,
      input,
      runtime.admin,
    );
    return adminJson({ search: safeSearchDetail(search) });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceSearchImport(
  context: RouteContext<{ bundleId: string; runId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId, runId } = await context.params;
    const missing = await requireSearchBundle(bundleId, runtime);
    if (missing) return missing;
    const search = await runtime.searchJobs.startImport(bundleId, runId, runtime.admin);
    if (search.status !== "importing") throw new EvidenceConflictError();
    return adminJson({ search: safeSearchStart(search) }, { status: 202 });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceJobStatus(
  request: Request,
  context: RouteContext<{ jobId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { jobId } = await context.params;
    const cursorValue = new URL(request.url).searchParams.get("cursor");
    if (cursorValue !== null && !/^\d+$/.test(cursorValue))
      throw new EvidenceRequestValidationError("페이지 커서가 올바르지 않습니다.");
    const offset = cursorValue === null ? 0 : Number(cursorValue);
    if (!Number.isSafeInteger(offset))
      throw new EvidenceRequestValidationError("페이지 커서가 올바르지 않습니다.");
    const job = await runtime.jobs.getAnalysisStatus(jobId);
    if (job === null)
      return jsonError("근거 분석 작업을 찾을 수 없습니다.", 404);
    const page =
      job.status === "review_ready" || job.status === "completed"
        ? await runtime.service.listCardsForJob(jobId, runtime.admin, {
            offset,
            limit: JOB_CARD_PAGE_SIZE,
            citationLimit: JOB_CARD_CITATION_LIMIT,
          })
        : { cards: [], totalCount: 0, nextOffset: null };
    const excerptBudget = { remaining: JOB_AGGREGATE_EXCERPT_MAX_BYTES };
    const cards = page.cards.slice(0, JOB_CARD_PAGE_SIZE).map((card) => safeCardDetail(card, excerptBudget));
    return adminJson({
      job: safeJob(job),
      cards,
      pagination: {
        count: cards.length,
        totalCount: page.totalCount,
        nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
      },
    });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceJobRetry(
  context: RouteContext<{ jobId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { jobId } = await context.params;
    const job = await runtime.jobs.retryAnalysis(jobId, runtime.admin);
    return adminJson({ job: safeJob(job) }, { status: 202 });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceCardReview(
  request: Request,
  context: RouteContext<{ cardId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { cardId } = await context.params;
    const input = await parseJson(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new EvidenceValidationError("카드 검수 입력이 필요합니다.");
    }
    const card = await runtime.service.reviewCard(
      cardId,
      input as never,
      runtime.admin,
    );
    return adminJson({ card: safeCard(card) });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceScenarioDraft(
  request: Request,
  context: RouteContext<{ cardId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { cardId } = await context.params;
    const input = await parseJson(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new EvidenceValidationError("시나리오 초안 입력이 필요합니다.");
    }
    const scenario = await runtime.service.createScenarioDraft(
      cardId,
      input as never,
      runtime.admin,
    );
    return adminJson({ scenario: safeScenario(scenario) }, { status: 201 });
  } catch (error) {
    return routeFailure(error);
  }
}
