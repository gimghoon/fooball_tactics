import {
  EvidenceAnalyzerError,
  parseAnalyzerCards,
  parseExtractedEvidence,
  type EvidenceAnalyzer,
  type EvidenceChunkInput,
  type ExtractedEvidence,
} from "./evidence-analyzer.ts";
import type { TacticCardContent } from "../domain/evidence.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export type EvidenceAnalyzerEnvironment = {
  EVIDENCE_LLM_ENDPOINT?: string;
  EVIDENCE_LLM_API_KEY?: string;
  EVIDENCE_LLM_MODEL?: string;
};

export type OpenAiEvidenceAnalyzerDependencies = {
  fetch?: typeof globalThis.fetch;
};

type AdapterConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  fetch: typeof globalThis.fetch;
};

const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cards"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["situation", "conditions", "defenseType", "cues", "preferred", "alternatives", "risky", "confidence", "uncertainties", "conflicts", "scenarioSuitable", "animationSuitable"],
        properties: {
          situation: { type: "string" }, conditions: { type: "array", items: { type: "string" } },
          defenseType: { type: "string", enum: ["front_press", "central_block", "wide_funnel", "one_v_one", "numerical_advantage", "numerical_disadvantage"] },
          cues: { type: "array", items: { type: "string" } },
          preferred: actionArraySchema(), alternatives: actionArraySchema(), risky: actionArraySchema(),
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          uncertainties: { type: "array", items: { type: "string" } }, conflicts: { type: "array", items: { type: "string" } },
          scenarioSuitable: { type: "boolean" }, animationSuitable: { type: "boolean" },
        },
      },
    },
  },
} as const;

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["extracted"],
  properties: {
    extracted: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["citationIds", "situation", "conditions", "cues", "actions", "outcomes", "exceptions"],
        properties: {
          citationIds: { type: "array", items: { type: "string" } }, situation: { type: "string" },
          conditions: { type: "array", items: { type: "string" } }, cues: { type: "array", items: { type: "string" } },
          actions: actionArraySchema(), outcomes: { type: "array", items: { type: "string" } }, exceptions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

function actionArraySchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["action", "reason", "citationIds"],
      properties: {
        action: { type: "string", enum: ["pass", "dribble", "move"] },
        reason: { type: "string" },
        citationIds: { type: "array", items: { type: "string" } },
      },
    },
  } as const;
}

const EXTRACTION_INSTRUCTIONS = [
  "Use only the supplied evidence. Never add general tactical knowledge or facts not present in it.",
  "Preserve conflicts instead of resolving them and keep differing conditions distinct.",
  "Extract only explicit situations, conditions, cues, actions, outcomes, and exceptions.",
  "Every extracted action and reason must cite one or more supplied evidence chunk IDs.",
].join(" ");

const CARD_INSTRUCTIONS = [
  "Use only supplied evidence in the extracted records and allowed citation IDs. Never add general tactical knowledge.",
  "Preserve conflicts, record them in conflicts, and split principles with differing conditions into separate cards.",
  "Every action and reason must cite one or more allowed evidence chunk IDs.",
].join(" ");

function required(value: string | undefined, name: string): string {
  if (!value || !value.trim()) throw new EvidenceAnalyzerError(`${name} 설정이 필요합니다.`, false);
  return value;
}

function validateEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new EvidenceAnalyzerError("EVIDENCE_LLM_ENDPOINT가 올바르지 않습니다.", false);
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new EvidenceAnalyzerError("EVIDENCE_LLM_ENDPOINT는 자격 증명 없는 HTTPS URL이어야 합니다.", false);
  }
  return endpoint.toString();
}

/** Creates the only server-side adapter that reads the LLM environment bindings. */
export function createConfiguredEvidenceAnalyzer(
  env: EvidenceAnalyzerEnvironment,
  dependencies: OpenAiEvidenceAnalyzerDependencies = {},
): EvidenceAnalyzer {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new EvidenceAnalyzerError("분석 제공자 연결을 사용할 수 없습니다.", false);
  return new OpenAiEvidenceAnalyzer({
    endpoint: validateEndpoint(required(env.EVIDENCE_LLM_ENDPOINT, "EVIDENCE_LLM_ENDPOINT")),
    apiKey: required(env.EVIDENCE_LLM_API_KEY, "EVIDENCE_LLM_API_KEY"),
    model: required(env.EVIDENCE_LLM_MODEL, "EVIDENCE_LLM_MODEL"),
    fetch: fetchImpl,
  });
}

class OpenAiEvidenceAnalyzer implements EvidenceAnalyzer {
  readonly modelId: string;

  constructor(private readonly config: AdapterConfig) {
    this.modelId = config.model;
  }

  async analyzeExtraction(
    input: { chunks: EvidenceChunkInput[]; promptVersion: string },
    signal: AbortSignal,
  ): Promise<ExtractedEvidence[]> {
    const text = await this.request(EXTRACTION_INSTRUCTIONS, {
      stage: "extract_evidence", promptVersion: input.promptVersion, chunks: input.chunks,
    }, "evidence_extraction", EXTRACTION_SCHEMA, signal);
    return parseExtractedEvidence(text, input.chunks);
  }

  async generateCards(
    input: { extracted: ExtractedEvidence[]; allowedCitationIds: string[]; promptVersion: string; schemaVersion: string },
    signal: AbortSignal,
  ): Promise<TacticCardContent[]> {
    const text = await this.request(CARD_INSTRUCTIONS, {
      stage: "generate_cards", promptVersion: input.promptVersion, schemaVersion: input.schemaVersion,
      allowedCitationIds: input.allowedCitationIds, extracted: input.extracted,
    }, "tactic_cards", CARD_SCHEMA, signal);
    return parseAnalyzerCards(text, input.allowedCitationIds);
  }

  private async request(
    instructions: string,
    input: unknown,
    schemaName: string,
    schema: object,
    signal: AbortSignal,
  ): Promise<string> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const forwardAbort = () => timeout.abort();
    if (signal.aborted) timeout.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await this.config.fetch(this.config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          instructions,
          input: JSON.stringify(input),
          text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
          store: false,
        }),
        signal: timeout.signal,
        // An Authorization header must never be forwarded to a different origin.
        redirect: "error",
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const message = response.status === 400 || response.status === 401 || response.status === 403
          ? "분석 제공자 설정 오류가 발생했습니다."
          : retryable ? "분석 제공자가 일시적으로 응답하지 않습니다." : "분석 제공자 요청이 거부되었습니다.";
        throw new EvidenceAnalyzerError(message, retryable);
      }
      return extractOutputText(await parseResponseJson(response));
    } catch (error) {
      if (error instanceof EvidenceAnalyzerError) throw error;
      if (timeout.signal.aborted) throw new EvidenceAnalyzerError("분석 요청 시간이 초과되었습니다.", true);
      throw new EvidenceAnalyzerError("분석 제공자와 통신할 수 없습니다.", true);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
    }
  }
}

async function parseResponseJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new EvidenceAnalyzerError("분석 제공자 응답이 너무 큽니다.", true);
  }
  const bytes = await readBoundedResponse(response, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new EvidenceAnalyzerError("분석 제공자 응답 JSON이 올바르지 않습니다.", true);
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
        throw new EvidenceAnalyzerError("분석 제공자 응답이 너무 큽니다.", true);
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

function extractOutputText(value: unknown): string {
  if (!isRecord(value) || value.status !== "completed") {
    throw new EvidenceAnalyzerError("분석 제공자 응답이 완료되지 않았습니다.", true);
  }
  if (!Array.isArray(value.output)) throw new EvidenceAnalyzerError("분석 제공자 응답에 출력이 없습니다.", true);
  for (const item of value.output) {
    if (!isRecord(item)) continue;
    if (item.status === "incomplete") throw new EvidenceAnalyzerError("분석 제공자 응답이 완료되지 않았습니다.", true);
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (content.type === "refusal") throw new EvidenceAnalyzerError("분석 제공자가 요청을 거부했습니다.", false);
      if (content.type === "output_text" && typeof content.text === "string" && content.text.trim()) return content.text;
    }
  }
  throw new EvidenceAnalyzerError("분석 제공자 응답에 구조화된 출력이 없습니다.", true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
