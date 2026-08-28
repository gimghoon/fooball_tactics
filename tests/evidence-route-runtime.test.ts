import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceProductionRouteRuntime } from "../lib/server/evidence-route-runtime.ts";
import { EvidenceUnavailableError } from "../lib/server/evidence-errors.ts";
import type { EvidenceD1Database, EvidenceD1Statement } from "../lib/server/evidence-service.ts";
import type { EvidenceR2Bucket } from "../lib/server/evidence-storage.ts";

const emptyStatement: EvidenceD1Statement = {
  bind() { return this; },
  async first<T>() { return null as T | null; },
  async all<T>() { return { results: [] as T[] }; },
  async run() { return {}; },
};

const database: EvidenceD1Database = {
  prepare() { return emptyStatement; },
  async batch() { return []; },
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

test("production search composition is lazy and configured search can read an empty latest run", async () => {
  let modelReads = 0;
  const searchEnvironment = Object.defineProperties({}, {
    EVIDENCE_SEARCH_MODEL: {
      enumerable: true,
      get() { modelReads += 1; return "web-search-model"; },
    },
    EVIDENCE_EXTERNAL_ALLOWED_HOSTS: {
      enumerable: true,
      get() { return "1:uefa.com"; },
    },
  });
  const runtime = createEvidenceProductionRouteRuntime({
    admin: { userId: "coach-1", email: "coach@example.test", displayName: "Coach", fullName: "Coach" },
    bindings: { DB: database, EVIDENCE_FILES: bucket },
    analyzerEnvironment: {
      EVIDENCE_LLM_ENDPOINT: "https://api.openai.com/v1/responses",
      EVIDENCE_LLM_API_KEY: "test-key",
      EVIDENCE_LLM_MODEL: "test-model",
    },
    searchEnvironment,
    schedule() {},
  });

  assert.equal(modelReads, 0);
  assert.equal(await runtime.jobs.getLatestAnalysisStatusForBundle("bundle-1"), null);
  assert.equal(modelReads, 0);
  assert.equal(await runtime.searchJobs.getLatestSearch("bundle-1"), null);
  assert.equal(modelReads, 1);
});

test("missing or invalid search configuration disables only search ports", async () => {
  for (const searchEnvironment of [
    {},
    { EVIDENCE_SEARCH_MODEL: "web-search-model", EVIDENCE_EXTERNAL_ALLOWED_HOSTS: "not-a-policy" },
  ]) {
    const runtime = createEvidenceProductionRouteRuntime({
      admin: { userId: "coach-1", email: "coach@example.test", displayName: "Coach", fullName: "Coach" },
      bindings: { DB: database, EVIDENCE_FILES: bucket },
      analyzerEnvironment: {
        EVIDENCE_LLM_ENDPOINT: "https://api.openai.com/v1/responses",
        EVIDENCE_LLM_API_KEY: "test-key",
        EVIDENCE_LLM_MODEL: "test-model",
      },
      searchEnvironment,
      schedule() {},
    });

    assert.equal(await runtime.jobs.getLatestAnalysisStatusForBundle("bundle-1"), null);
    assert.deepEqual(await runtime.service.listBundlesForAdmin(runtime.admin), []);
    await assert.rejects(
      async () => runtime.searchJobs.getLatestSearch("bundle-1"),
      (error: unknown) => error instanceof EvidenceUnavailableError,
    );
  }
});
