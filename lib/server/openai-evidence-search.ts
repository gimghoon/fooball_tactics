import {
  parseSearchCandidateDraft,
  type SearchCandidateDraft,
} from "../domain/evidence-search.ts";
import {
  createEvidenceSourcePolicy,
  type EvidenceSourcePolicy,
} from "./evidence-source-policy.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_DIRECT_EVIDENCE_SUMMARY_LENGTH = 2_000;
const MAX_CANDIDATES = 8;

type AbortCause = "none" | "timeout" | "caller";

class ResponseBodyTransportError extends Error {}
class ResponseBodyTooLargeError extends Error {}

export class EvidenceSearchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "EvidenceSearchError";
  }
}

export type EvidenceSearchEnvironment = {
  EVIDENCE_LLM_ENDPOINT?: string;
  EVIDENCE_LLM_API_KEY?: string;
  EVIDENCE_SEARCH_MODEL?: string;
  EVIDENCE_EXTERNAL_ALLOWED_HOSTS?: string;
};

export type EvidenceSearchProvider = {
  modelId: string;
  search(
    input: { title: string; purpose: string; directEvidenceSummary: string },
    signal: AbortSignal,
  ): Promise<{ queries: string[]; candidates: SearchCandidateDraft[] }>;
};

export type EvidenceSearchTransportDiagnostic = {
  name: string;
  message: string;
  causeName?: string;
  causeCode?: string;
};

export type OpenAiEvidenceSearchDependencies = {
  fetch?: typeof globalThis.fetch;
  /** Test seam; production calls retain the exact 30-second default. */
  requestTimeoutMs?: number;
  onTransportError?: (diagnostic: EvidenceSearchTransportDiagnostic) => void;
};

type AdapterConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  policy: EvidenceSourcePolicy;
  fetch: typeof globalThis.fetch;
  requestTimeoutMs: number;
  onTransportError?: (diagnostic: EvidenceSearchTransportDiagnostic) => void;
};

const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries", "candidates"],
  properties: {
    queries: { type: "array", maxItems: MAX_CANDIDATES, items: { type: "string" } },
    candidates: {
      type: "array",
      maxItems: MAX_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "canonicalUrl", "title", "publisher", "publishedAt", "documentType", "quote", "relevance", "proposedTrustTier"],
        properties: {
          url: { type: "string" },
          canonicalUrl: { type: "string" },
          title: { type: "string" },
          publisher: { type: "string" },
          publishedAt: { type: "string" },
          documentType: { type: "string", enum: ["web_page", "pdf"] },
          quote: { type: "string" },
          relevance: { type: "string" },
          proposedTrustTier: { type: "integer", enum: [1, 2, 3] },
        },
      },
    },
  },
} as const;

const SEARCH_INSTRUCTIONS = [
  "Search for tactical football evidence in this source order: official football bodies and associations first, official coach-education institutions second, and identified professional research or analysis publishers third.",
  "Return only HTTPS web pages or PDFs from allowed, reputable publishers; exclude videos, blogs, communities, social media, and unsupported model knowledge.",
  "Return no more than 8 distinct candidates. Each candidate must have a publisher, an exact publication date (YYYY-MM-DD), and a direct quotation from that source; omit a candidate when any of those is unavailable.",
  "Use the supplied title, purpose, and bounded direct-evidence summary only to formulate search queries and explain relevance. Do not create tactical cards or make unsupported tactical claims.",
].join(" ");

function required(value: string | undefined, name: string): string {
  if (!value || !value.trim()) throw new EvidenceSearchError(`${name} 설정이 필요합니다.`, false);
  return value;
}

function validateEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new EvidenceSearchError("EVIDENCE_LLM_ENDPOINT가 올바르지 않습니다.", false);
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new EvidenceSearchError("EVIDENCE_LLM_ENDPOINT는 자격 증명 없는 HTTPS URL이어야 합니다.", false);
  }
  return endpoint.toString();
}

function timeoutMs(value: number | undefined): number {
  if (value === undefined) return REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new EvidenceSearchError("검색 요청 시간 제한이 올바르지 않습니다.", false);
  return value;
}

/** Creates the only server-side adapter that reads the web-search environment bindings. */
export function createConfiguredEvidenceSearchProvider(
  env: EvidenceSearchEnvironment,
  dependencies: OpenAiEvidenceSearchDependencies = {},
): EvidenceSearchProvider {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new EvidenceSearchError("검색 제공자 연결을 사용할 수 없습니다.", false);
  let policy: EvidenceSourcePolicy;
  try {
    policy = createEvidenceSourcePolicy(required(env.EVIDENCE_EXTERNAL_ALLOWED_HOSTS, "EVIDENCE_EXTERNAL_ALLOWED_HOSTS"));
  } catch (error) {
    if (error instanceof EvidenceSearchError) throw error;
    throw new EvidenceSearchError("외부 출처 호스트 설정이 올바르지 않습니다.", false);
  }
  return new OpenAiEvidenceSearch({
    endpoint: validateEndpoint(required(env.EVIDENCE_LLM_ENDPOINT, "EVIDENCE_LLM_ENDPOINT")),
    apiKey: required(env.EVIDENCE_LLM_API_KEY, "EVIDENCE_LLM_API_KEY"),
    model: required(env.EVIDENCE_SEARCH_MODEL, "EVIDENCE_SEARCH_MODEL"),
    policy,
    fetch: fetchImpl,
    requestTimeoutMs: timeoutMs(dependencies.requestTimeoutMs),
    onTransportError: dependencies.onTransportError,
  });
}

function sanitizeDiagnosticText(value: unknown, apiKey: string): string {
  if (typeof value !== "string") return "";
  return value.replaceAll(apiKey, "[redacted]").slice(0, 240);
}

function transportDiagnostic(error: unknown, apiKey: string): EvidenceSearchTransportDiagnostic {
  const value = error instanceof Error ? error : new Error("unknown transport error");
  const cause = value.cause;
  const causeRecord = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : null;
  return {
    name: value.name || "Error",
    message: sanitizeDiagnosticText(value.message, apiKey),
    ...(cause === undefined ? {} : { causeName: cause instanceof Error ? cause.name : cause?.constructor?.name ?? typeof cause }),
    ...(typeof causeRecord?.code === "string" ? { causeCode: causeRecord.code.slice(0, 80) } : {}),
  };
}

class OpenAiEvidenceSearch implements EvidenceSearchProvider {
  readonly modelId: string;

  constructor(private readonly config: AdapterConfig) {
    this.modelId = config.model;
  }

  async search(
    input: { title: string; purpose: string; directEvidenceSummary: string },
    signal: AbortSignal,
  ): Promise<{ queries: string[]; candidates: SearchCandidateDraft[] }> {
    const text = await this.request({
      title: boundedText(input.title, 200),
      purpose: boundedText(input.purpose, 600),
      directEvidenceSummary: boundedText(input.directEvidenceSummary, MAX_DIRECT_EVIDENCE_SUMMARY_LENGTH),
    }, signal);
    return parseSearchOutput(text, this.config.policy);
  }

  private async request(input: Record<string, string>, signal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let abortCause: AbortCause = signal.aborted ? "caller" : "none";
    const abort = (cause: Exclude<AbortCause, "none">) => {
      if (abortCause !== "none") return;
      abortCause = cause;
      controller.abort();
    };
    const transportFailure = () => abortCause === "caller"
      ? new EvidenceSearchError("검색 요청이 취소되었습니다.", false)
      : abortCause === "timeout"
        ? new EvidenceSearchError("검색 요청 시간이 초과되었습니다.", true)
        : new EvidenceSearchError("검색 제공자와 통신할 수 없습니다.", true);
    const timer = setTimeout(() => abort("timeout"), this.config.requestTimeoutMs);
    const forwardAbort = () => abort("caller");
    if (abortCause === "caller") controller.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.config.fetch(this.config.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({
            model: this.config.model,
            reasoning: { effort: "minimal" },
            instructions: SEARCH_INSTRUCTIONS,
            input: JSON.stringify(input),
            tools: [{ type: "web_search" }],
            include: ["web_search_call.action.sources"],
            text: { format: { type: "json_schema", name: "evidence_search_candidates", schema: SEARCH_SCHEMA, strict: true } },
            store: false,
          }),
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (error) {
        if (abortCause === "none") this.config.onTransportError?.(transportDiagnostic(error, this.config.apiKey));
        throw transportFailure();
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const message = response.status === 400 || response.status === 401 || response.status === 403
          ? "검색 제공자 설정 오류가 발생했습니다."
          : retryable ? "검색 제공자가 일시적으로 응답하지 않습니다." : "검색 제공자 요청이 거부되었습니다.";
        throw new EvidenceSearchError(message, retryable);
      }
      let responseJson: unknown;
      try {
        responseJson = await parseResponseJson(response);
      } catch (error) {
        if (error instanceof ResponseBodyTransportError) throw transportFailure();
        throw error;
      }
      return extractOutputText(responseJson);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
    }
  }
}

function boundedText(value: string, limit: number): string {
  return value.trim().slice(0, limit);
}

async function parseResponseJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new EvidenceSearchError("검색 제공자 응답이 너무 큽니다.", true);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) throw new EvidenceSearchError("검색 제공자 응답이 너무 큽니다.", true);
    throw new ResponseBodyTransportError();
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new EvidenceSearchError("검색 제공자 응답 JSON이 올바르지 않습니다.", true);
  }
}

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

function parseSearchOutput(text: string, policy: EvidenceSourcePolicy): { queries: string[]; candidates: SearchCandidateDraft[] } {
  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(text) as unknown;
  } catch {
    throw new EvidenceSearchError("검색 제공자 출력 JSON이 올바르지 않습니다.", true);
  }
  if (!isRecord(parsedOutput) || !Array.isArray(parsedOutput.queries) || !Array.isArray(parsedOutput.candidates)) {
    throw new EvidenceSearchError("검색 제공자 출력이 올바르지 않습니다.", true);
  }
  const queries = parsedOutput.queries.filter((query): query is string => typeof query === "string" && query.trim() !== "")
    .map((query) => query.trim())
    .slice(0, MAX_CANDIDATES);
  const canonicalUrls = new Set<string>();
  const candidates: SearchCandidateDraft[] = [];
  for (const candidateValue of parsedOutput.candidates) {
    if (candidates.length === MAX_CANDIDATES) break;
    try {
      const candidate = parseSearchCandidateDraft(candidateValue);
      const trustTier = policy.classify(new URL(candidate.canonicalUrl));
      if (trustTier === null || canonicalUrls.has(candidate.canonicalUrl)) continue;
      canonicalUrls.add(candidate.canonicalUrl);
      candidates.push({ ...candidate, proposedTrustTier: trustTier });
    } catch {
      // Model-provided candidates are advisory; malformed or untrusted records are excluded.
    }
  }
  return { queries, candidates };
}

function extractOutputText(value: unknown): string {
  if (!isRecord(value) || value.status !== "completed") {
    throw new EvidenceSearchError("검색 제공자 응답이 완료되지 않았습니다.", true);
  }
  if (!Array.isArray(value.output)) throw new EvidenceSearchError("검색 제공자 응답에 출력이 없습니다.", true);
  let messageCount = 0;
  const texts: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item)) throw new EvidenceSearchError("검색 제공자 응답 항목이 올바르지 않습니다.", true);
    if (item.status === "incomplete") throw new EvidenceSearchError("검색 제공자 응답이 완료되지 않았습니다.", true);
    if (item.type === "reasoning" || item.type === "web_search_call") {
      if (item.status !== undefined && item.status !== "completed") {
        throw new EvidenceSearchError("검색 제공자 응답이 완료되지 않았습니다.", true);
      }
      continue;
    }
    if (item.type !== "message" || item.status !== "completed" || !Array.isArray(item.content)) {
      throw new EvidenceSearchError("검색 제공자 응답 항목이 올바르지 않습니다.", true);
    }
    messageCount += 1;
    for (const content of item.content) {
      if (!isRecord(content)) throw new EvidenceSearchError("검색 제공자 출력이 올바르지 않습니다.", true);
      if (content.type === "refusal") throw new EvidenceSearchError("검색 제공자가 요청을 거부했습니다.", false);
      if (content.type !== "output_text" || typeof content.text !== "string" || !content.text.trim()) {
        throw new EvidenceSearchError("검색 제공자 출력이 올바르지 않습니다.", true);
      }
      texts.push(content.text);
    }
  }
  if (messageCount !== 1 || texts.length !== 1) {
    throw new EvidenceSearchError("검색 제공자 응답에 구조화된 출력이 없습니다.", true);
  }
  return texts[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
