import assert from "node:assert/strict";
import test from "node:test";
import {
  EvidenceAnalyzerError,
  parseAnalyzerCards,
  type EvidenceChunkInput,
} from "../lib/server/evidence-analyzer.ts";
import { createConfiguredEvidenceAnalyzer } from "../lib/server/openai-evidence-analyzer.ts";

const chunks: EvidenceChunkInput[] = [{ id: "chunk-1", locationLabel: "page:1", content: "수비수는 중앙을 막는다." }];
const card = (citationIds = ["chunk-1"]) => ({
  situation: "중앙으로 공을 운반한다.",
  conditions: ["전방 압박이 없다."],
  defenseType: "central_block",
  cues: ["중앙 수비수가 안쪽을 닫는다."],
  preferred: [{ action: "pass", reason: "측면 공간이 열려 있다.", citationIds }],
  alternatives: [],
  risky: [{ action: "dribble", reason: "중앙 수비가 밀집했다.", citationIds }],
  confidence: "medium",
  uncertainties: [],
  conflicts: [],
  scenarioSuitable: true,
  animationSuitable: true,
});

const completedResponse = (text: string) => new Response(JSON.stringify({
  status: "completed",
  output: [{ type: "message", status: "completed", content: [{ type: "output_text", text }] }],
}));

test("rejects malformed JSON and citations outside the supplied evidence", () => {
  assert.throws(() => parseAnalyzerCards("not-json", chunks), /JSON/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([card(["unknown"])]), chunks), /근거/);
});

test("rejects unknown fields, enums, empty action reasons, and empty citations", () => {
  assert.throws(() => parseAnalyzerCards(JSON.stringify([{ ...card(), providerResponse: "raw" }]), chunks), /알 수 없는/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([{ ...card(), defenseType: "other" }]), chunks), /수비 유형/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([{ ...card(), preferred: [{ action: "shoot", reason: "x", citationIds: ["chunk-1"] }] }]), chunks), /행동/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([{ ...card(), preferred: [{ action: "pass", reason: "", citationIds: ["chunk-1"] }] }]), chunks), /필요/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([card([])]), chunks), /근거/);
});

test("configured adapter sends a strict Responses structured-output request and returns only domain cards", async () => {
  let request: Request | undefined;
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses",
    EVIDENCE_LLM_API_KEY: "secret-key",
    EVIDENCE_LLM_MODEL: "gpt-test",
  }, {
    fetch: async (input, init) => {
      request = new Request(input, init);
      return completedResponse(JSON.stringify({ cards: [card()] }));
    },
  });

  const cards = await analyzer.generateCards({
    extracted: [], allowedCitationIds: ["chunk-1"], promptVersion: "prompt-1", schemaVersion: "schema-1",
  }, AbortSignal.timeout(1_000));

  assert.equal(analyzer.modelId, "gpt-test");
  assert.deepEqual(cards, [card()]);
  assert.equal(JSON.stringify(cards).includes("secret-key"), false);
  assert.equal("providerResponse" in cards[0], false);
  assert.equal(request?.headers.get("authorization"), "Bearer secret-key");
  const body = await request?.json() as Record<string, unknown>;
  assert.equal(body.model, "gpt-test");
  assert.equal(body.store, false);
  assert.equal((body.text as { format: { type: string; strict: boolean } }).format.type, "json_schema");
  assert.equal((body.text as { format: { type: string; strict: boolean } }).format.strict, true);
  assert.match(String(body.instructions), /supplied evidence/i);
});

test("rejects non-HTTPS endpoints and provider refusals or incomplete responses", async () => {
  assert.throws(() => createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "http://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }), /HTTPS/);

  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response(JSON.stringify({
    status: "incomplete", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
  })) });
  await assert.rejects(() => analyzer.generateCards({ extracted: [], allowedCitationIds: ["chunk-1"], promptVersion: "p", schemaVersion: "s" }, AbortSignal.timeout(1_000)), /완료/);
});

test("classifies transient provider errors without leaking raw provider bodies or API keys", async () => {
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response("provider raw body secret-key", { status: 429 }) });

  await assert.rejects(
    () => analyzer.generateCards({ extracted: [], allowedCitationIds: ["chunk-1"], promptVersion: "p", schemaVersion: "s" }, AbortSignal.timeout(1_000)),
    (error: unknown) => {
      assert.ok(error instanceof EvidenceAnalyzerError);
      assert.equal(error.retryable, true);
      assert.equal(String(error.message).includes("secret-key"), false);
      assert.equal(String(error.message).includes("provider raw body"), false);
      return true;
    },
  );
});

test("classifies provider configuration errors as terminal", async () => {
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response("do not disclose", { status: 401 }) });

  await assert.rejects(
    () => analyzer.generateCards({ extracted: [], allowedCitationIds: ["chunk-1"], promptVersion: "p", schemaVersion: "s" }, AbortSignal.timeout(1_000)),
    (error: unknown) => error instanceof EvidenceAnalyzerError && !error.retryable && !error.message.includes("do not disclose"),
  );
});

test("bounds oversized responses and treats timeouts as retryable", async () => {
  const tooLarge = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response("x".repeat(1_000_001)) });
  await assert.rejects(() => tooLarge.generateCards({ extracted: [], allowedCitationIds: ["chunk-1"], promptVersion: "p", schemaVersion: "s" }, AbortSignal.timeout(1_000)), /너무 큽니다/);

  const timedOut = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }) });
  await assert.rejects(
    () => timedOut.generateCards({ extracted: [], allowedCitationIds: ["chunk-1"], promptVersion: "p", schemaVersion: "s" }, AbortSignal.abort()),
    (error: unknown) => error instanceof EvidenceAnalyzerError && error.retryable,
  );
});
