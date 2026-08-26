import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceProductionRouteRuntime } from "../lib/server/evidence-route-runtime.ts";
import type { EvidenceD1Database, EvidenceD1Statement } from "../lib/server/evidence-service.ts";
import type { EvidenceR2Bucket } from "../lib/server/evidence-storage.ts";

const emptyStatement: EvidenceD1Statement = {
  bind() { return this; },
  async first<T>() { return null as T | null; },
  async run() { return {}; },
};

const database: EvidenceD1Database = {
  prepare() { return emptyStatement; },
};

const bucket: EvidenceR2Bucket = {
  async put() {},
  async get() { return null; },
  async delete() {},
};

test("production evidence runtime can read the latest bundle analysis status", async () => {
  const runtime = createEvidenceProductionRouteRuntime({
    admin: { userId: "coach-1", email: "coach@example.test", displayName: "Coach", fullName: "Coach" },
    bindings: { DB: database, EVIDENCE_FILES: bucket },
    analyzerEnvironment: {
      EVIDENCE_LLM_ENDPOINT: "https://api.openai.com/v1/responses",
      EVIDENCE_LLM_API_KEY: "test-key",
      EVIDENCE_LLM_MODEL: "test-model",
    },
    schedule() {},
  });

  assert.equal(await runtime.jobs.getLatestAnalysisStatusForBundle("bundle-1"), null);
});
