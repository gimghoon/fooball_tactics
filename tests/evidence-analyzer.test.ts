import assert from "node:assert/strict";
import test from "node:test";
import {
  EvidenceAnalyzerError,
  enforceExternalEvidenceRules,
  parseAnalyzerCards,
  parseExtractedEvidence,
  type EvidenceChunkInput,
  type ExtractedEvidence,
} from "../lib/server/evidence-analyzer.ts";
import type { TacticCardContent } from "../lib/domain/evidence.ts";
import { createConfiguredEvidenceAnalyzer } from "../lib/server/openai-evidence-analyzer.ts";

const chunks: EvidenceChunkInput[] = [{ id: "chunk-1", locationLabel: "page:1", content: "수비수는 중앙을 막는다.", origin: "uploaded" }];
const defaultConfig = {
  EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses",
  EVIDENCE_LLM_API_KEY: "key",
  EVIDENCE_LLM_MODEL: "model",
};
const card = (citationIds = ["chunk-1"]): TacticCardContent => ({
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
const extracted = (): ExtractedEvidence => ({
  citationIds: ["chunk-1"],
  situation: "중앙으로 공을 운반한다.",
  conditions: ["전방 압박이 없다."],
  cues: ["중앙 수비수가 안쪽을 닫는다."],
  actions: [{ action: "pass", reason: "측면 공간이 열려 있다.", citationIds: ["chunk-1"] }],
  outcomes: ["측면으로 전진한다."],
  exceptions: [],
});
const cardInput = { extracted: [extracted()], allowedCitationIds: ["chunk-1"], promptVersion: "p", schemaVersion: "s" };

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

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
  assert.throws(() => parseAnalyzerCards(JSON.stringify([{ ...card(), preferred: [{ action: "screen", reason: "x", citationIds: ["chunk-1"] }] }]), chunks), /행동/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([{ ...card(), preferred: [{ action: "pass", reason: "", citationIds: ["chunk-1"] }] }]), chunks), /필요/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([card([])]), chunks), /근거/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([{ ...card(), preferred: [], alternatives: [], risky: [] }]), chunks), /행동/);
  const actionless = { ...card(), preferred: [], alternatives: [], risky: [] };
  assert.throws(() => parseAnalyzerCards(JSON.stringify([card(), actionless]), chunks), /행동/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([]), chunks), /행동/);
});

test("preserves defensive intent and zonal defense without inventing a dribble", () => {
  const result = parseAnalyzerCards(JSON.stringify({ cards: [{
    ...card(),
    defenseType: "zonal",
    ballOwnerId: "A1",
    preferred: [{
      action: "move",
      tacticalIntent: "cover",
      actorId: "D2",
      targetId: null,
      trigger: "D1이 압박을 시작하면",
      path: [{ x: 52, y: 70 }, { x: 48, y: 62 }],
      provenance: "coach_statement",
      confidence: "high",
      reason: "D2가 먼저 뒤 공간을 커버한다.",
      citationIds: ["chunk-1"],
    }],
    risky: [],
  }] }), chunks);

  assert.equal(result[0]?.defenseType, "zonal");
  assert.equal(result[0]?.preferred[0]?.action, "move");
  assert.equal(result[0]?.preferred[0]?.tacticalIntent, "cover");
});

test("semantic validation blocks impossible possession actions and unsafe animation claims", () => {
  const impossible = {
    ...card(),
    ballOwnerId: "A1",
    preferred: [{
      action: "dribble", tacticalIntent: "press", actorId: "D1", targetId: null,
      trigger: "즉시", path: [{ x: 50, y: 80 }, { x: 50, y: 70 }],
      provenance: "inferred", confidence: "high", reason: "공을 압박한다.", citationIds: ["chunk-1"],
    }],
    risky: [],
  };
  assert.throws(() => parseAnalyzerCards(JSON.stringify({ cards: [impossible] }), chunks), /드리블|수비 전술 의도/);

  const missingPath = {
    ...card(),
    ballOwnerId: "A1",
    preferred: [{
      action: "move", tacticalIntent: "support", actorId: "A2", targetId: null,
      trigger: "A1이 공을 잡으면", path: [], provenance: "observation", confidence: "medium",
      reason: "패스 각도를 만든다.", citationIds: ["chunk-1"],
    }],
    risky: [],
  };
  assert.equal(parseAnalyzerCards(JSON.stringify({ cards: [missingPath] }), chunks)[0]?.animationSuitable, false);
});

test("simulation assumptions cannot remain high-confidence but stay available for human review", () => {
  const assumption = {
    ...card(),
    ballOwnerId: "A1",
    preferred: [{
      action: "move", tacticalIntent: "support", actorId: "A2", targetId: null,
      trigger: "A1이 전진하면", path: [{ x: 20, y: 90 }, { x: 30, y: 75 }],
      provenance: "simulation_assumption", confidence: "high",
      reason: "지원 각도를 만든다고 가정한다.", citationIds: ["chunk-1"],
    }],
    risky: [],
  };
  const result = parseAnalyzerCards(JSON.stringify({ cards: [assumption] }), chunks)[0]!;
  assert.equal(result.preferred[0]?.confidence, "medium");
  assert.equal(result.scenarioSuitable, true);
});

test("external-only cards are capped from high to medium using every action citation", () => {
  const externalOnly = {
    ...card(["external-chunk"]),
    confidence: "high" as const,
    alternatives: [{ action: "move" as const, reason: "외부 근거의 대안이다.", citationIds: ["external-chunk"] }],
  };
  const origins = new Map([
    ["external-chunk", "external_web" as const],
    ["uncited-uploaded-chunk", "uploaded" as const],
  ]);

  assert.equal(enforceExternalEvidenceRules(externalOnly, origins).confidence, "medium");
  assert.equal(enforceExternalEvidenceRules({
    ...externalOnly,
    preferred: [{ action: "pass", reason: "직접 근거도 사용한다.", citationIds: ["uploaded-chunk"] }],
  }, new Map([...origins, ["uploaded-chunk", "uploaded" as const]])).confidence, "high");
});

test("same-condition conflicts remain exact and block scenario and animation suitability", () => {
  const conflict = "직접 근거는 중앙 유지, 외부 근거는 즉시 측면 이동을 지시함";
  const result = enforceExternalEvidenceRules({
    ...card(),
    conflicts: [conflict],
    scenarioSuitable: true,
    animationSuitable: true,
  }, new Map([["chunk-1", "uploaded"]]));

  assert.deepEqual(result.conflicts, [conflict]);
  assert.equal(result.scenarioSuitable, false);
  assert.equal(result.animationSuitable, false);
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
    ...cardInput, promptVersion: "prompt-1", schemaVersion: "schema-1",
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
  const cardSchema = record(record(body.text).format).schema;
  const cardSchemaRecord = record(cardSchema);
  const cardItems = record(record(record(cardSchemaRecord.properties).cards).items);
  const preferredItems = record(record(record(cardItems.properties).preferred).items);
  assert.equal(cardSchemaRecord.additionalProperties, false);
  assert.deepEqual(cardSchemaRecord.required, ["cards"]);
  assert.equal(cardItems.additionalProperties, false);
  assert.ok((cardItems.required as string[]).includes("situation"));
  assert.equal(preferredItems.additionalProperties, false);
  assert.ok((preferredItems.required as string[]).includes("tacticalIntent"));
  assert.ok((preferredItems.required as string[]).includes("actorId"));
  assert.ok((cardItems.required as string[]).includes("ballOwnerId"));
  assert.match(String(body.instructions), /supplied evidence/i);
  assert.match(String(body.instructions), /press.*cover.*dribble/i);
  assert.match(String(body.instructions), /different triggers.*not.*conflict/i);
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
  await assert.rejects(() => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), /완료/);
});

test("classifies transient provider errors without leaking raw provider bodies or API keys", async () => {
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response("provider raw body secret-key", { status: 429 }) });

  await assert.rejects(
    () => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)),
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
    () => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)),
    (error: unknown) => error instanceof EvidenceAnalyzerError && !error.retryable && !error.message.includes("do not disclose"),
  );
});

test("bounds oversized responses", async () => {
  const tooLarge = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response("x".repeat(1_000_001)) });
  await assert.rejects(() => tooLarge.generateCards(cardInput, AbortSignal.timeout(1_000)), /너무 큽니다/);

});

test("extraction parser rejects unknown fields, blank values, unknown citations, and empty output", () => {
  assert.throws(() => parseExtractedEvidence(JSON.stringify({ extracted: [{ ...extracted(), providerResponse: "raw" }] }), chunks), /알 수 없는/);
  assert.throws(() => parseExtractedEvidence(JSON.stringify({ extracted: [{ ...extracted(), situation: " " }] }), chunks), /필요/);
  assert.throws(() => parseExtractedEvidence(JSON.stringify({ extracted: [{ ...extracted(), citationIds: ["unknown"] }] }), chunks), /근거/);
  assert.throws(() => parseExtractedEvidence(JSON.stringify({ extracted: [{ ...extracted(), actions: [{ action: "screen", reason: "x", citationIds: ["chunk-1"] }] }] }), chunks), /행동/);
  assert.throws(() => parseExtractedEvidence(JSON.stringify({ extracted: [{ ...extracted(), actions: [{ action: "pass", reason: " ", citationIds: ["chunk-1"] }] }] }), chunks), /필요/);
  assert.throws(() => parseExtractedEvidence(JSON.stringify({ extracted: [{ ...extracted(), actions: [{ action: "pass", reason: "x", citationIds: [] }] }] }), chunks), /근거/);
  assert.throws(() => parseExtractedEvidence(JSON.stringify({ extracted: [] }), chunks), /근거/);
});

test("extraction preserves the ball owner and named defense type for card generation", () => {
  const result = parseExtractedEvidence({ extracted: [{
    ...extracted(), defenseType: "zonal", ballOwnerId: "A1",
  }] }, chunks);
  assert.equal(result[0]?.defenseType, "zonal");
  assert.equal(result[0]?.ballOwnerId, "A1");
});

test("stage one rejects empty or blank chunks and stage two requires extracted citations", async () => {
  let calls = 0;
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => {
    calls += 1;
    return completedResponse(JSON.stringify({ cards: [card()] }));
  } });
  await assert.rejects(() => analyzer.analyzeExtraction({ chunks: [], promptVersion: "p" }, AbortSignal.timeout(1_000)), /근거/);
  assert.equal(calls, 0);
  await assert.rejects(() => analyzer.analyzeExtraction({ chunks: [{ ...chunks[0], content: " " }], promptVersion: "p" }, AbortSignal.timeout(1_000)), /필요/);
  await assert.rejects(() => analyzer.generateCards({ ...cardInput, extracted: [] }, AbortSignal.timeout(1_000)), /근거/);
  await assert.rejects(() => analyzer.generateCards({ ...cardInput, extracted: [], allowedCitationIds: [] }, AbortSignal.timeout(1_000)), /근거/);
  assert.equal(calls, 0);
  await assert.rejects(() => analyzer.generateCards({ ...cardInput, extracted: [{ ...extracted(), citationIds: ["chunk-2"], actions: [{ action: "pass", reason: "x", citationIds: ["chunk-2"] }] }] }, AbortSignal.timeout(1_000)), /근거/);
});

test("extraction adapter sends strict schema and evidence-only instructions", async () => {
  let request: Request | undefined;
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async (input, init) => {
    request = new Request(input, init);
    return completedResponse(JSON.stringify({ extracted: [extracted()] }));
  } });
  assert.deepEqual(await analyzer.analyzeExtraction({ chunks, promptVersion: "p" }, AbortSignal.timeout(1_000)), [extracted()]);
  const body = await request?.json() as Record<string, unknown>;
  const format = record(record(body.text).format);
  const extractionSchema = record(format.schema);
  const extractionItems = record(record(record(extractionSchema.properties).extracted).items);
  assert.equal(format.name, "evidence_extraction");
  assert.equal(extractionSchema.additionalProperties, false);
  assert.equal(extractionItems.additionalProperties, false);
  assert.deepEqual(extractionItems.required, ["citationIds", "situation", "conditions", "defenseType", "ballOwnerId", "cues", "actions", "outcomes", "exceptions"]);
  assert.equal(record(JSON.parse(String(body.input))).stage, "extract_evidence");
  assert.deepEqual(body.reasoning, { effort: "minimal" });
  assert.match(String(body.instructions), /only.*supplied evidence/i);
  assert.match(String(body.instructions), /conflict/i);
  assert.match(String(body.instructions), /differing conditions/i);
  assert.match(String(body.instructions), /action and reason.*cite/i);
  assert.match(String(body.instructions), /documents?.*data.*not.*instructions/i);
  assert.match(String(body.instructions), /external-only.*medium/i);
  assert.equal(request?.redirect, "manual");
});

test("extraction input includes bounded external provenance but no uploaded display metadata", async () => {
  let request: Request | undefined;
  const analyzer = createConfiguredEvidenceAnalyzer(defaultConfig, { fetch: async (input, init) => {
    request = new Request(input, init);
    return completedResponse(JSON.stringify({ extracted: [extracted()] }));
  } });
  const externalChunks: EvidenceChunkInput[] = [
    chunks[0]!,
    {
      id: "external-chunk", locationLabel: "page:2", content: "측면으로 이동한다.", origin: "external_web",
      canonicalUrl: "https://uefa.example/pressing", publisher: "UEFA", publishedAt: "2026-01-02", retrievedAt: 123,
    },
  ];

  await analyzer.analyzeExtraction({ chunks: externalChunks, promptVersion: "p" }, AbortSignal.timeout(1_000));

  const body = await request?.json() as Record<string, unknown>;
  const input = record(JSON.parse(String(body.input)));
  assert.deepEqual(input.chunks, externalChunks);
  assert.deepEqual((input.chunks as EvidenceChunkInput[])[0], {
    id: "chunk-1", locationLabel: "page:1", content: "수비수는 중앙을 막는다.", origin: "uploaded",
  });
});

test("rejects all invalid Responses envelopes after inspecting every output item", async (t) => {
  const envelopes: [string, unknown][] = [
    ["later refusal", { status: "completed", output: [
      { type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ cards: [card()] }) }] },
      { type: "message", status: "completed", content: [{ type: "refusal", refusal: "no" }] },
    ] }],
    ["response failed", { status: "failed", output: [] }],
    ["missing output", { status: "completed" }],
    ["incomplete item", { status: "completed", output: [{ type: "reasoning", status: "incomplete", summary: [] }] }],
    ["incomplete message", { status: "completed", output: [{ type: "message", status: "incomplete", content: [{ type: "output_text", text: "{}" }] }] }],
    ["multiple messages", { status: "completed", output: [
      { type: "message", status: "completed", content: [{ type: "output_text", text: "{}" }] },
      { type: "message", status: "completed", content: [{ type: "output_text", text: "{}" }] },
    ] }],
    ["multiple texts", { status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: "{}" }, { type: "output_text", text: "{}" }] }] }],
    ["unexpected message content", { status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_image" }] }] }],
    ["missing text", { status: "completed", output: [{ type: "message", status: "completed", content: [] }] }],
    ["unexpected item", { status: "completed", output: [{ type: "tool_call", status: "completed" }] }],
  ];
  for (const [name, envelope] of envelopes) await t.test(name, async () => {
    const analyzer = createConfiguredEvidenceAnalyzer({
      EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
    }, { fetch: async () => new Response(JSON.stringify(envelope)) });
    await assert.rejects(() => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), EvidenceAnalyzerError);
  });
});

test("allows a documented reasoning item before one completed structured message", async () => {
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response(JSON.stringify({
    status: "completed",
    output: [
      { type: "reasoning", status: "completed", summary: [] },
      { type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ cards: [card()] }) }] },
    ],
  })) });
  assert.deepEqual(await analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), [card()]);
});

test("sanitizes a shared analyzer error thrown by fetch", async () => {
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => { throw new EvidenceAnalyzerError("secret-key provider raw body", false); } });
  await assert.rejects(() => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => {
    assert.ok(error instanceof EvidenceAnalyzerError);
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.message.includes("provider raw body"), false);
    return true;
  });
});

test("classifies 408, 400, 403, 5xx, and network failures without provider leakage", async (t) => {
  for (const [status, retryable] of [[408, true], [400, false], [403, false], [503, true]] as const) await t.test(String(status), async () => {
    const analyzer = createConfiguredEvidenceAnalyzer({
      EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
    }, { fetch: async () => new Response("provider raw body secret-key", { status }) });
    await assert.rejects(() => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => {
      assert.ok(error instanceof EvidenceAnalyzerError);
      assert.equal(error.retryable, retryable);
      assert.equal(error.message.includes("secret-key"), false);
      assert.equal(error.message.includes("provider raw body"), false);
      return true;
    });
  });
  const network = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => { throw new Error("secret-key provider raw body"); } });
  await assert.rejects(() => network.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => {
    assert.ok(error instanceof EvidenceAnalyzerError);
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.message.includes("provider raw body"), false);
    return true;
  });
});

test("reports a sanitized transport diagnostic without credentials or request evidence", async () => {
  const diagnostics: unknown[] = [];
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses",
    EVIDENCE_LLM_API_KEY: "secret-key",
    EVIDENCE_LLM_MODEL: "model",
  }, {
    fetch: async () => { throw new TypeError("connection failed for secret-key", { cause: { code: "EHOSTUNREACH" } }); },
    onTransportError: (diagnostic) => diagnostics.push(diagnostic),
  });

  await assert.rejects(() => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), EvidenceAnalyzerError);
  assert.deepEqual(diagnostics, [{
    name: "TypeError",
    message: "connection failed for [redacted]",
    causeName: "Object",
    causeCode: "EHOSTUNREACH",
  }]);
  assert.equal(JSON.stringify(diagnostics).includes("secret-key"), false);
  assert.equal(JSON.stringify(diagnostics).includes("chunk-1"), false);
});

test("redacts and bounds every analyzer transport diagnostic string field", async () => {
  const diagnostics: Array<{ name: string; message: string; causeName?: string; causeCode?: string }> = [];
  const cause = Object.assign(new Error("cause"), { code: `CODE-secret-key-${"c".repeat(300)}` });
  cause.name = `Cause-secret-key-${"n".repeat(300)}`;
  const failure = new TypeError(`message-secret-key-${"m".repeat(300)}`, { cause });
  failure.name = `Type-secret-key-${"t".repeat(300)}`;
  const analyzer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses",
    EVIDENCE_LLM_API_KEY: "secret-key",
    EVIDENCE_LLM_MODEL: "model",
  }, {
    fetch: async () => { throw failure; },
    onTransportError: (diagnostic) => diagnostics.push(diagnostic),
  });

  await assert.rejects(() => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), EvidenceAnalyzerError);
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes("secret-key"), false);
  for (const value of Object.values(diagnostics[0]!)) assert.ok(value.length <= 240);
});

test("distinguishes an injected adapter timeout from caller cancellation", async () => {
  const waitingFetch = async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const timedOut = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: waitingFetch, requestTimeoutMs: 1 });
  await assert.rejects(() => timedOut.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => error instanceof EvidenceAnalyzerError && error.retryable && /시간이 초과/.test(error.message));
  const cancelled = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: waitingFetch, requestTimeoutMs: 1_000 });
  await assert.rejects(() => cancelled.generateCards(cardInput, AbortSignal.abort()), (error: unknown) => error instanceof EvidenceAnalyzerError && !error.retryable && /취소/.test(error.message));
});

test("latches the first abort cause even when fetch rejection is delayed", async () => {
  const delayedAbortFetch = async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => setTimeout(() => reject(new Error("secret-key provider raw body")), 10), { once: true });
  });
  const timeoutFirstSignal = new AbortController();
  const timeoutFirst = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: delayedAbortFetch, requestTimeoutMs: 1 });
  const timeoutFirstResult = timeoutFirst.generateCards(cardInput, timeoutFirstSignal.signal);
  setTimeout(() => timeoutFirstSignal.abort(), 5);
  await assert.rejects(() => timeoutFirstResult, (error: unknown) => error instanceof EvidenceAnalyzerError && error.retryable && /시간이 초과/.test(error.message));

  const callerFirstSignal = new AbortController();
  const callerFirst = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: delayedAbortFetch, requestTimeoutMs: 50 });
  const callerFirstResult = callerFirst.generateCards(cardInput, callerFirstSignal.signal);
  callerFirstSignal.abort();
  await assert.rejects(() => callerFirstResult, (error: unknown) => error instanceof EvidenceAnalyzerError && !error.retryable && /취소/.test(error.message));

  const callerThenTimerSignal = new AbortController();
  const callerThenTimer = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: delayedAbortFetch, requestTimeoutMs: 1 });
  const callerThenTimerResult = callerThenTimer.generateCards(cardInput, callerThenTimerSignal.signal);
  callerThenTimerSignal.abort();
  await assert.rejects(() => callerThenTimerResult, (error: unknown) => error instanceof EvidenceAnalyzerError && !error.retryable && /취소/.test(error.message));
});

test("sanitizes response-stream failures and preserves timeout or cancellation during body reads", async () => {
  const streamFetch = (delayAfterAbort: number) => async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      init?.signal?.addEventListener("abort", () => setTimeout(() => controller.error(new Error("secret-key provider raw body")), delayAfterAbort), { once: true });
    },
  }));
  const rawStream = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("secret-key provider raw body")); } })) });
  await assert.rejects(() => rawStream.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => {
    assert.ok(error instanceof EvidenceAnalyzerError);
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.message.includes("provider raw body"), false);
    return true;
  });

  const timedOut = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: streamFetch(1), requestTimeoutMs: 1 });
  await assert.rejects(() => timedOut.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => error instanceof EvidenceAnalyzerError && error.retryable && /시간이 초과/.test(error.message));

  const caller = new AbortController();
  const cancelled = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: streamFetch(1), requestTimeoutMs: 1_000 });
  const cancelledResult = cancelled.generateCards(cardInput, caller.signal);
  caller.abort();
  await assert.rejects(() => cancelledResult, (error: unknown) => error instanceof EvidenceAnalyzerError && !error.retryable && /취소/.test(error.message));

  const rejectedCancel = createConfiguredEvidenceAnalyzer({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses", EVIDENCE_LLM_API_KEY: "secret-key", EVIDENCE_LLM_MODEL: "model",
  }, { fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1_000_001)); },
    cancel() { return Promise.reject(new Error("secret-key provider raw cancel body")); },
  })) });
  await assert.rejects(() => rejectedCancel.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => {
    assert.ok(error instanceof EvidenceAnalyzerError);
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.message.includes("raw cancel body"), false);
    return true;
  });
});

test("removes the identical caller abort listener on success, error, and abort", async (t) => {
  const observableSignal = () => {
    let aborted = false;
    let added: EventListenerOrEventListenerObject | undefined;
    let removed: EventListenerOrEventListenerObject | undefined;
    const signal = {
      get aborted() { return aborted; },
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        assert.equal(type, "abort");
        added = listener;
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        assert.equal(type, "abort");
        removed = listener;
      },
    } as unknown as AbortSignal;
    return {
      signal,
      abort: () => {
        aborted = true;
        if (typeof added === "function") added(new Event("abort"));
        else added?.handleEvent(new Event("abort"));
      },
      assertRemoved: () => assert.strictEqual(removed, added),
    };
  };
  await t.test("success", async () => {
    const probe = observableSignal();
    const analyzer = createConfiguredEvidenceAnalyzer({ ...defaultConfig }, { fetch: async () => completedResponse(JSON.stringify({ cards: [card()] })) });
    await analyzer.generateCards(cardInput, probe.signal);
    probe.assertRemoved();
  });
  await t.test("error", async () => {
    const probe = observableSignal();
    const analyzer = createConfiguredEvidenceAnalyzer({ ...defaultConfig }, { fetch: async () => { throw new Error("network"); } });
    await assert.rejects(() => analyzer.generateCards(cardInput, probe.signal), EvidenceAnalyzerError);
    probe.assertRemoved();
  });
  await t.test("abort", async () => {
    const probe = observableSignal();
    const analyzer = createConfiguredEvidenceAnalyzer({ ...defaultConfig }, { fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    const result = analyzer.generateCards(cardInput, probe.signal);
    probe.abort();
    await assert.rejects(() => result, EvidenceAnalyzerError);
    probe.assertRemoved();
  });
});

test("adapter malformed JSON preserves a safe retryable JSON error", async () => {
  const analyzer = createConfiguredEvidenceAnalyzer({ ...defaultConfig }, { fetch: async () => new Response("not-json secret-key provider raw body") });
  await assert.rejects(() => analyzer.generateCards(cardInput, AbortSignal.timeout(1_000)), (error: unknown) => {
    assert.ok(error instanceof EvidenceAnalyzerError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /JSON/);
    assert.equal(error.message.includes("secret-key"), false);
    return true;
  });
});
