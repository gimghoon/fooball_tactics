import { EvidenceValidationError } from "../domain/evidence.ts";
import { EvidenceAnalyzerError } from "./evidence-analyzer.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import type { EvidenceAnalysisJobRecord, EvidenceAnalysisJobs } from "./evidence-jobs.ts";
import {
  EvidenceConflictError,
  type EvidenceBundleDetail,
  type EvidenceBundleRecord,
  type EvidenceCardAdminDetail,
  type EvidenceCardRecord,
  type EvidenceScenarioDraftRecord,
  type EvidenceService,
} from "./evidence-service.ts";
import type { EvidenceFileStore, StoredEvidenceFile } from "./evidence-storage.ts";

const MAX_EVIDENCE_FILE_BYTES = 20 * 1024 * 1024;

type RouteContext<T extends Record<string, string>> = { params: Promise<T> };

export type EvidenceRouteRuntime = {
  admin: EvidenceAdmin;
  service: Pick<EvidenceService,
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
  jobs: Pick<EvidenceAnalysisJobs, "startAnalysis" | "retryAnalysis" | "getAnalysisStatus">;
};

type EvidenceAuthorizer = (request: Request) => Promise<EvidenceAdmin | Response>;
type EvidenceRuntimeFactory = (admin: EvidenceAdmin) => EvidenceRouteRuntime | Promise<EvidenceRouteRuntime>;

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function isMissing(error: Error): boolean {
  return error.message.includes("찾을 수 없습니다") || error.message.includes("존재하지 않습니다");
}

function isConflict(error: Error): boolean {
  return error.message.includes("연결된 카드")
    || error.message.includes("오래된 근거")
    || error.message.includes("승인된 전술 카드")
    || error.message.includes("적합한 카드")
    || error.message.includes("승인 스냅샷")
    || error.message.includes("현재 카드의 근거")
    || error.message.includes("재시도할 수 없습니다")
    || error.message.includes("버전이 변경")
    || error.message.includes("변경되어");
}

function routeFailure(error: unknown): Response {
  if (error instanceof EvidenceConflictError) return jsonError(error.message, 409);
  if (error instanceof EvidenceValidationError) return jsonError(error.message, 400);
  if (error instanceof EvidenceAnalyzerError) {
    return jsonError("근거 분석 서비스를 사용할 수 없습니다.", 503);
  }
  if (error instanceof AggregateError) return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
  if (error instanceof Error && isConflict(error)) return jsonError(error.message, 409);
  if (error instanceof Error && isMissing(error)) return jsonError(error.message, 404);
  if (error instanceof Error && error.message.includes("구성되지 않았습니다")) {
    return jsonError("근거 자료 서비스를 사용할 수 없습니다.", 503);
  }
  if (error instanceof Error && (error.message.includes("올바르지 않습니다") || error.message.includes("필요합니다"))) {
    return jsonError(error.message, 400);
  }
  return jsonError("근거 자료 요청을 처리하지 못했습니다.", 500);
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new EvidenceValidationError("요청 JSON을 확인할 수 없습니다.");
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
    extractionError: source.extractionError === null ? null : "근거 텍스트를 준비하지 못했습니다.",
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
    errorMessage: job.errorMessage === null ? null : "근거 분석 작업을 완료하지 못했습니다.",
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attemptCount: job.attemptCount,
    isStale: job.isStale,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
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

function safeCardDetail(card: EvidenceCardAdminDetail) {
  return {
    ...safeCard(card),
    citations: card.citations.map((citation) => ({
      chunkId: citation.chunkId,
      sourceId: citation.sourceId,
      videoClipId: citation.videoClipId,
      locationLabel: citation.locationLabel,
      excerpt: citation.content.slice(0, 2_000),
    })),
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
): Promise<{ bundle: EvidenceBundleDetail; source: StoredEvidenceFile } | Response> {
  const bundle = await runtime.service.getBundleForAdmin(bundleId, runtime.admin);
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
  if (decision instanceof Response) return decision;
  let runtime: EvidenceRouteRuntime;
  try {
    runtime = await createRuntime(decision);
  } catch {
    return jsonError("근거 자료 서비스를 사용할 수 없습니다.", 503);
  }
  try {
    return await handle(runtime);
  } catch (error) {
    return routeFailure(error);
  }
}

export function bindEvidenceSchedule(waitUntil: (promise: Promise<unknown>) => void) {
  return (promise: Promise<unknown>): void => waitUntil(promise);
}

export async function handleEvidenceCollectionList(runtime: EvidenceRouteRuntime): Promise<Response> {
  try {
    const bundles = await runtime.service.listBundlesForAdmin(runtime.admin);
    return Response.json({ bundles: bundles.map(safeBundle) });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceCollectionCreate(request: Request, runtime: EvidenceRouteRuntime): Promise<Response> {
  try {
    const bundle = await runtime.service.createBundle(await parseJson(request), runtime.admin);
    return Response.json({ bundle: safeBundle(bundle) }, { status: 201 });
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
    const bundle = await runtime.service.getBundleForAdmin(bundleId, runtime.admin);
    return bundle === null
      ? jsonError("근거 묶음을 찾을 수 없습니다.", 404)
      : Response.json({ bundle: safeBundleDetail(bundle) });
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
    const bundle = await runtime.service.updateBundle(bundleId, input, runtime.admin);
    return Response.json({ bundle: safeBundle(bundle) });
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
    const bundle = await runtime.service.getBundleForAdmin(bundleId, runtime.admin);
    if (bundle === null) return jsonError("근거 묶음을 찾을 수 없습니다.", 404);
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      return jsonError("multipart/form-data 파일 업로드가 필요합니다.", 415);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError("파일 업로드 형식을 확인할 수 없습니다.", 400);
    }
    const candidate = form.get("file");
    if (!(candidate instanceof File)) return jsonError("업로드할 파일이 필요합니다.", 400);
    if (candidate.size > MAX_EVIDENCE_FILE_BYTES) {
      return jsonError("파일은 20MB 이하여야 합니다.", 413);
    }
    try {
      const source = await runtime.fileStore.putValidatedFile({
        bundleId,
        name: candidate.name,
        type: candidate.type,
        bytes: new Uint8Array(await candidate.arrayBuffer()),
      });
      return Response.json({ source: safeSource(source) }, { status: 201 });
    } catch (error) {
      if (error instanceof EvidenceValidationError) {
        const status = error.message.includes("20MB") || error.message.includes("크기") ? 413 : 415;
        return jsonError(error.message, status);
      }
      return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
    }
  } catch (error) {
    return routeFailure(error);
  }
}

function cleanDisplayFilename(value: string): string {
  const cleaned = [...value.normalize("NFC")].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 || character === "/" || character === "\\" ? "_" : character;
  }).join("").trim();
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
    if (body === null) return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
    return new Response(body, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": attachmentDisposition(located.source.originalFileName),
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
    return Response.json({ impact: await runtime.service.describeDeleteImpact(sourceId) });
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
    return Response.json({ bundle: safeBundle(bundle), removedSourceId: sourceId });
  } catch (error) {
    if (error instanceof EvidenceConflictError || (error instanceof Error && isConflict(error))) {
      return jsonError(error.message, 409);
    }
    if (error instanceof Error && isMissing(error)) return jsonError(error.message, 404);
    return jsonError("근거 파일 저장소를 사용할 수 없습니다.", 503);
  }
}

export async function handleEvidenceClipCreate(
  request: Request,
  context: RouteContext<{ bundleId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { bundleId } = await context.params;
    const bundle = await runtime.service.addVideoClip(bundleId, await parseJson(request), runtime.admin);
    return Response.json({ bundle: safeBundle(bundle) }, { status: 201 });
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
    return Response.json({ job: safeJob(job) }, { status: 202 });
  } catch (error) {
    return routeFailure(error);
  }
}

export async function handleEvidenceJobStatus(
  context: RouteContext<{ jobId: string }>,
  runtime: EvidenceRouteRuntime,
): Promise<Response> {
  try {
    const { jobId } = await context.params;
    const job = await runtime.jobs.getAnalysisStatus(jobId);
    if (job === null) return jsonError("근거 분석 작업을 찾을 수 없습니다.", 404);
    const cards = job.status === "review_ready" || job.status === "completed"
      ? await runtime.service.listCardsForJob(jobId, runtime.admin)
      : [];
    return Response.json({ job: safeJob(job), cards: cards.map(safeCardDetail) });
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
    return Response.json({ job: safeJob(job) }, { status: 202 });
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
    const card = await runtime.service.reviewCard(cardId, input as never, runtime.admin);
    return Response.json({ card: safeCard(card) });
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
    const scenario = await runtime.service.createScenarioDraft(cardId, input as never, runtime.admin);
    return Response.json({ scenario: safeScenario(scenario) }, { status: 201 });
  } catch (error) {
    return routeFailure(error);
  }
}
