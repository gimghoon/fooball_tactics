import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceSourcePolicy } from "../lib/server/evidence-source-policy.ts";
import { createConfiguredEvidenceSearchProvider } from "../lib/server/openai-evidence-search.ts";

let lastRequest: Record<string, unknown> | undefined;

function searchInput() {
  return {
    title: "다이아몬드",
    purpose: "중앙 차단 탈출",
    directEvidenceSummary: "픽소가 공 소유",
  };
}

function candidate(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: `https://learning.uefa.com/guidance/${index}#section`,
    canonicalUrl: `https://learning.uefa.com/guidance/${index}`,
    title: `UEFA guidance ${index}`,
    publisher: "UEFA",
    publishedAt: "2026-08-26",
    documentType: index % 2 === 0 ? "pdf" : "web_page",
    quote: "Keep the central lane protected while supporting the ball holder.",
    relevance: "Matches the stated central-block escape objective.",
    proposedTrustTier: 3,
    ...overrides,
  };
}

function source(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "url",
    url: `https://learning.uefa.com/guidance/${index}#provider-source`,
    ...overrides,
  };
}

function validSearchEnvelope(
  count: number,
  sources: unknown[] = Array.from({ length: count }, (_, index) => source(index + 1)),
  actionType = "search",
) {
  return {
    status: "completed",
    output: [
      { type: "web_search_call", status: "completed", action: { type: actionType, sources } },
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({
          queries: ["다이아몬드 중앙 차단 탈출 UEFA coaching"],
          candidates: Array.from({ length: count }, (_, index) => candidate(index + 1)),
        }) }],
      },
    ],
  };
}

function recordingResponsesFetch(response: unknown): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    lastRequest = await request.json() as Record<string, unknown>;
    return new Response(JSON.stringify(response));
  };
}

function createProviderWithFetch(fetch: typeof globalThis.fetch) {
  return createConfiguredEvidenceSearchProvider({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses",
    EVIDENCE_LLM_API_KEY: "key",
    EVIDENCE_SEARCH_MODEL: "web-search-model",
    EVIDENCE_EXTERNAL_ALLOWED_HOSTS: "1:fifa.com,1:uefa.com,2:coach.example.edu,3:research.example.org",
  }, { fetch });
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("server host policy owns trust and rejects model-only trust", () => {
  const policy = createEvidenceSourcePolicy("1:fifa.com,1:uefa.com,2:coach.example.edu,3:research.example.org");
  assert.equal(policy.classify(new URL("https://learning.uefa.com/doc")), 1);
  assert.equal(policy.classify(new URL("https://research.example.org/paper")), 3);
  assert.equal(policy.classify(new URL("https://uefa.com.evil.test/doc")), null);
  assert.equal(policy.classify(new URL("https://blog.example/doc")), null);
});

test("server host policy independently rejects non-HTTPS and credential-bearing URLs", () => {
  const policy = createEvidenceSourcePolicy("1:uefa.com");
  const insecure = new URL("http://uefa.com/doc");
  const credentialed = new URL("https://user:pass@uefa.com/doc");

  assert.equal(policy.classify(insecure), null);
  assert.equal(policy.classify(credentialed), null);
  assert.throws(() => policy.assertAllowed(insecure), /허용된 외부 출처/);
  assert.throws(() => policy.assertAllowed(credentialed), /허용된 외부 출처/);
});

test("search request enables web_search and returns at most eight allowed candidates", async () => {
  const provider = createProviderWithFetch(recordingResponsesFetch(validSearchEnvelope(10)));
  const result = await provider.search(searchInput(), AbortSignal.timeout(1_000));

  assert.equal(record((lastRequest?.tools as unknown[])[0]).type, "web_search");
  assert.deepEqual(lastRequest?.include, ["web_search_call.action.sources"]);
  assert.equal(record(record(lastRequest?.text).format).strict, true);
  assert.equal(result.candidates.length, 8);
  assert.ok(result.candidates.every((item) => item.proposedTrustTier === 1));
  assert.deepEqual(result.queries, ["다이아몬드 중앙 차단 탈출 UEFA coaching"]);
});

test("rejects model candidates when the completed web search returned no sources", async () => {
  const provider = createProviderWithFetch(recordingResponsesFetch(validSearchEnvelope(1, [])));

  const result = await provider.search(searchInput(), AbortSignal.timeout(1_000));

  assert.deepEqual(result.candidates, []);
});

test("rejects malformed or unsafe web-search source records without exposing their values", async () => {
  const provider = createProviderWithFetch(recordingResponsesFetch(validSearchEnvelope(1, [
    null,
    { type: "url" },
    { type: "other", url: "https://learning.uefa.com/guidance/1" },
    { type: "url", url: "http://learning.uefa.com/guidance/1" },
    { type: "url", url: "https://user:sk-test@learning.uefa.com/guidance/1" },
    { type: "url", url: `https://learning.uefa.com/${"x".repeat(5_000)}` },
  ])));

  const result = await provider.search(searchInput(), AbortSignal.timeout(1_000));

  assert.deepEqual(result.candidates, []);

  const wrongActionProvider = createProviderWithFetch(recordingResponsesFetch(
    validSearchEnvelope(1, [source(1)], "open_page"),
  ));
  const wrongActionResult = await wrongActionProvider.search(searchInput(), AbortSignal.timeout(1_000));
  assert.deepEqual(wrongActionResult.candidates, []);
});

test("rejects a model candidate whose canonical URL does not match a returned source", async () => {
  const provider = createProviderWithFetch(recordingResponsesFetch(validSearchEnvelope(1, [source(99)])));

  const result = await provider.search(searchInput(), AbortSignal.timeout(1_000));

  assert.deepEqual(result.candidates, []);
});

test("uses the normalized matching web-search source URL as candidate authority", async () => {
  const provider = createProviderWithFetch(recordingResponsesFetch(validSearchEnvelope(1, [{
    type: "url",
    url: "https://LEARNING.UEFA.com/guidance/1#provider-source",
  }])));

  const result = await provider.search(searchInput(), AbortSignal.timeout(1_000));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.url, "https://learning.uefa.com/guidance/1");
  assert.equal(result.candidates[0]!.canonicalUrl, "https://learning.uefa.com/guidance/1");
  assert.equal(result.candidates[0]!.proposedTrustTier, 1);
});

test("request sends only the bounded direct-evidence summary and no API secret", async () => {
  const provider = createProviderWithFetch(recordingResponsesFetch(validSearchEnvelope(1)));
  const summary = `bounded-summary-${"x".repeat(4_000)}`;
  await provider.search({ ...searchInput(), directEvidenceSummary: summary }, AbortSignal.timeout(1_000));

  const requestInput = record(JSON.parse(String(lastRequest?.input)));
  assert.equal(String(requestInput.directEvidenceSummary).length, 2_000);
  assert.equal(String(lastRequest?.instructions).includes("key"), false);
  assert.equal(JSON.stringify(lastRequest).includes("key"), false);
});

test("provider errors never expose keys or response bodies", async () => {
  const provider = createProviderWithFetch(async () => new Response(`secret sk-test ${"x".repeat(500)}`, { status: 500 }));
  await assert.rejects(
    () => provider.search(searchInput(), AbortSignal.timeout(1_000)),
    (error: Error) => !error.message.includes("sk-test") && error.message.length < 260,
  );
});

test("transport diagnostics redact keys from every emitted field", async () => {
  const apiKey = "secret-api-key";
  const cause = Object.assign(new Error("cause"), { name: `cause-${apiKey}`, code: `code-${apiKey}` });
  const failure = new Error("network failure", { cause });
  failure.name = `failure-${apiKey}`;
  let diagnostic: Record<string, unknown> | undefined;
  const provider = createConfiguredEvidenceSearchProvider({
    EVIDENCE_LLM_ENDPOINT: "https://llm.example.test/v1/responses",
    EVIDENCE_LLM_API_KEY: apiKey,
    EVIDENCE_SEARCH_MODEL: "web-search-model",
    EVIDENCE_EXTERNAL_ALLOWED_HOSTS: "1:uefa.com",
  }, {
    fetch: async () => { throw failure; },
    onTransportError: (value) => { diagnostic = value as Record<string, unknown>; },
  });

  await assert.rejects(() => provider.search(searchInput(), AbortSignal.timeout(1_000)));
  assert.ok(diagnostic);
  assert.equal(JSON.stringify(diagnostic).includes(apiKey), false);
  assert.ok(Object.values(diagnostic).every((value) => typeof value !== "string" || value.length <= 240));
});
