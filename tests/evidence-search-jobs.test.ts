import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import type { SearchCandidateDraft, SearchSelectionInput } from "../lib/domain/evidence-search.ts";
import type { EvidenceAdmin } from "../lib/server/evidence-auth.ts";
import { createEvidenceProductionRuntime } from "../lib/server/evidence-runtime.ts";
import {
  EvidenceExternalSearchJobs,
  type EvidenceSearchRunDetail,
} from "../lib/server/evidence-search-jobs.ts";
import type { EvidenceSourcePolicy } from "../lib/server/evidence-source-policy.ts";
import type { EvidenceD1Database, EvidenceD1Statement } from "../lib/server/evidence-service.ts";
import type { EvidenceR2Bucket } from "../lib/server/evidence-storage.ts";
import type { FetchedExternalEvidence } from "../lib/server/evidence-web-fetcher.ts";
import type { EvidenceSearchProvider } from "../lib/server/openai-evidence-search.ts";

const admin: EvidenceAdmin = {
  userId: "admin-1",
  email: "admin@example.test",
  displayName: "Admin",
  fullName: "Admin User",
};
const settings = { analyzerModel: "model-1", promptVersion: "prompt-1", schemaVersion: "schema-1" };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class SQLiteD1Statement implements EvidenceD1Statement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    private readonly executeRun: (statement: SQLiteD1Statement) => Promise<{ meta: { changes: number } }>,
  ) {}

  bind(...values: unknown[]): EvidenceD1Statement {
    this.values = values as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.query).all(...this.values) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.executeRun(this);
  }

  execute(): { meta: { changes: number } } {
    const result = this.database.prepare(this.query).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class SQLiteD1Database implements EvidenceD1Database {
  readonly database = new DatabaseSync(":memory:");
  beforeNextBatch: (() => void | Promise<void>) | null = null;
  afterNextBatchCommit: (() => void | Promise<void>) | null = null;
  beforeNextRun: { pattern: RegExp; callback: () => void | Promise<void> } | null = null;
  afterNextRunCommit: { pattern: RegExp; callback: () => void | Promise<void> } | null = null;

  constructor() {
    this.database.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync("drizzle").filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort()) {
      this.database.exec(readFileSync(`drizzle/${name}`, "utf8"));
    }
  }

  prepare(query: string): EvidenceD1Statement {
    return new SQLiteD1Statement(this.database, query, (statement) => this.executeRun(statement));
  }

  private async executeRun(statement: SQLiteD1Statement): Promise<{ meta: { changes: number } }> {
    const before = this.beforeNextRun;
    if (before?.pattern.test(statement.query)) {
      this.beforeNextRun = null;
      await before.callback();
    }
    const result = statement.execute();
    const after = this.afterNextRunCommit;
    if (after?.pattern.test(statement.query)) {
      this.afterNextRunCommit = null;
      await after.callback();
    }
    return result;
  }

  async batch(statements: EvidenceD1Statement[]): Promise<{ meta: { changes: number } }[]> {
    const before = this.beforeNextBatch;
    this.beforeNextBatch = null;
    await before?.();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SQLiteD1Statement)) throw new Error("Unexpected D1 statement implementation.");
        return statement.execute();
      });
      this.database.exec("COMMIT");
      const after = this.afterNextBatchCommit;
      this.afterNextBatchCommit = null;
      await after?.();
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  all<T>(query: string, ...values: SQLInputValue[]): T[] {
    return this.database.prepare(query).all(...values) as T[];
  }

  first<T>(query: string, ...values: SQLInputValue[]): T {
    const row = this.database.prepare(query).get(...values) as T | undefined;
    if (row === undefined) throw new Error(`Expected one row for: ${query}`);
    return row;
  }

  run(query: string, ...values: SQLInputValue[]): void {
    this.database.prepare(query).run(...values);
  }
}

class MemoryR2Bucket implements EvidenceR2Bucket {
  readonly objects = new Map<string, Uint8Array | string>();
  readonly putKeys: string[] = [];

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.putKeys.push(key);
    this.objects.set(key, value instanceof Uint8Array ? value.slice() : value);
  }

  async get(key: string): Promise<Uint8Array | string | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return value instanceof Uint8Array ? value.slice() : value;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class RecordingProvider implements EvidenceSearchProvider {
  readonly modelId = "search-model-1";
  readonly inputs: { title: string; purpose: string; directEvidenceSummary: string }[] = [];

  constructor(private readonly result: { queries: string[]; candidates: SearchCandidateDraft[] }) {}

  async search(input: { title: string; purpose: string; directEvidenceSummary: string }) {
    this.inputs.push(input);
    return this.result;
  }
}

const policy: EvidenceSourcePolicy = {
  classify(url) {
    return url.hostname === "allowed.example.test" ? 1 : null;
  },
  assertAllowed(url) {
    if (url.hostname !== "allowed.example.test") throw new Error("허용된 외부 출처가 아닙니다.");
    return 1;
  },
};

function candidate(index: number, overrides: Partial<SearchCandidateDraft> = {}): SearchCandidateDraft {
  const url = `https://allowed.example.test/document-${index}`;
  return {
    url,
    canonicalUrl: url,
    title: `문서 ${index}`,
    publisher: "Allowed Federation",
    publishedAt: "2026-08-20",
    documentType: "web_page",
    quote: `verified quote ${index}`,
    relevance: `relevance ${index}`,
    proposedTrustTier: 3,
    ...overrides,
  };
}

function successfulFetch(input: { url: string; quote: string }): FetchedExternalEvidence {
  const bytes = new TextEncoder().encode(input.quote);
  return {
    finalUrl: input.url,
    mediaType: "text/plain",
    fileName: "document.txt",
    bytes,
    extractedPages: [{ locator: "section 1", text: input.quote }],
    contentHash: "advisory-fetch-hash",
    retrievedAt: 2_000,
  };
}

function seedBundle(database: SQLiteD1Database, version = 1, contentVersion = "content-1"): void {
  database.run(
    "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    "bundle-1", "압박 탈출", "전방 압박을 탈출한다", version, contentVersion, 1, 1,
  );
}

function seedApprovedWork(database: SQLiteD1Database): void {
  const bundle = database.first<{ contentVersion: string }>(
    "SELECT content_version AS contentVersion FROM evidence_bundles WHERE id='bundle-1'",
  );
  database.run(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    "analysis-1", "bundle-1", bundle.contentVersion, "queued", "model-1", "prompt-1", "schema-1", "validate_sources", 0, 1, 1,
  );
  database.run(
    `INSERT INTO tactic_cards
      (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "card-1", "bundle-1", "analysis-1", bundle.contentVersion, "coach_reviewed", "{}", "{}", 0, 1, 1,
  );
}

function createContext(
  candidates: SearchCandidateDraft[] = [candidate(1), candidate(2)],
  fetcher: (input: { url: string; expectedType: "web_page" | "pdf"; quote: string }) => Promise<FetchedExternalEvidence> = async (input) => successfulFetch(input),
) {
  const db = new SQLiteD1Database();
  const bucket = new MemoryR2Bucket();
  const scheduled: Promise<unknown>[] = [];
  const provider = new RecordingProvider({ queries: ["압박 탈출 공식 코칭"], candidates });
  let serviceId = 0;
  let jobId = 0;
  let now = 1_000;
  const runtime = createEvidenceProductionRuntime({
    bindings: { DB: db, EVIDENCE_FILES: bucket },
    admin,
    settings,
    newId: () => `service-${++serviceId}`,
    now: () => ++now,
  });
  const jobs = new EvidenceExternalSearchJobs({
    db,
    provider,
    policy,
    files: runtime.fileStore,
    promptVersion: "search-prompt-v1",
    fetchExternalEvidence: fetcher,
    schedule: (promise) => scheduled.push(promise),
    newId: () => `search-${++jobId}`,
    now: () => ++now,
  });
  return { db, bucket, scheduled, provider, jobs, ...runtime };
}

async function runSearch(context: ReturnType<typeof createContext>): Promise<EvidenceSearchRunDetail> {
  const before = context.scheduled.length;
  const run = await context.jobs.startSearch("bundle-1", admin);
  await Promise.all(context.scheduled.slice(before));
  const detail = await context.jobs.getSearch("bundle-1", run.id);
  assert.ok(detail);
  assert.equal(detail.run.status, "ready");
  return detail;
}

async function select(
  context: ReturnType<typeof createContext>,
  detail: EvidenceSearchRunDetail,
  selectedIndexes: number[],
): Promise<void> {
  const selected = selectedIndexes.map((index) => detail.candidates[index]!.id);
  const excluded = detail.candidates.filter((_value, index) => !selectedIndexes.includes(index)).map((value) => value.id);
  const bundle = context.db.first<{ version: number }>("SELECT version FROM evidence_bundles WHERE id='bundle-1'");
  await context.jobs.saveSelection("bundle-1", detail.run.id, {
    expectedBundleVersion: bundle.version,
    selectedIds: selected,
    excludedIds: excluded,
  }, admin);
}

test("search is explicit, deduplicated by input version, and stores at most eight candidates", async () => {
  const candidates = Array.from({ length: 10 }, (_value, index) => candidate(index + 1));
  candidates.splice(1, 0, candidate(99, {
    url: candidates[0]!.url,
    canonicalUrl: candidates[0]!.canonicalUrl,
  }));
  candidates.splice(2, 0, candidate(100, {
    url: "https://untrusted.example.test/document",
    canonicalUrl: "https://untrusted.example.test/document",
  }));
  const context = createContext(candidates);
  seedBundle(context.db);
  await context.fileStore.putValidatedFile({
    bundleId: "bundle-1",
    name: "direct.txt",
    type: "text/plain",
    bytes: new TextEncoder().encode("직접 근거 ".repeat(2_000)),
  });

  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_search_runs").count, 0);
  const first = await context.jobs.startSearch("bundle-1", admin);
  const second = await context.jobs.startSearch("bundle-1", admin);
  assert.equal(first.id, second.id);
  assert.equal(context.scheduled.length, 1);
  await Promise.all(context.scheduled);

  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_search_candidates").count, 8);
  assert.equal(context.provider.inputs.length, 1);
  assert.ok(new TextEncoder().encode(context.provider.inputs[0]!.directEvidenceSummary).byteLength <= 4_000);
  assert.ok(context.provider.inputs[0]!.directEvidenceSummary.includes("직접 근거"));
  assert.equal(
    context.db.first<{ count: number }>(
      "SELECT count(DISTINCT canonical_url) AS count FROM evidence_search_candidates",
    ).count,
    8,
  );
});

test("search insertion is guarded by the captured bundle version and content authority", async () => {
  const context = createContext([candidate(1)]);
  seedBundle(context.db);
  context.db.beforeNextRun = {
    pattern: /INSERT OR IGNORE INTO evidence_search_runs/,
    callback: () => context.db.run(
      "UPDATE evidence_bundles SET version=2,content_version='content-2',updated_at=2 WHERE id='bundle-1'",
    ),
  };

  await assert.rejects(() => context.jobs.startSearch("bundle-1", admin), /갱신/);
  assert.equal(context.db.first<{ count: number }>(
    "SELECT count(*) AS count FROM evidence_search_runs",
  ).count, 0);
  assert.equal(context.scheduled.length, 0);
});

test("bundle mutation before search acquisition terminally stales the queued run", async () => {
  const context = createContext([candidate(1)]);
  seedBundle(context.db);
  context.db.beforeNextRun = {
    pattern: /UPDATE evidence_search_runs SET status='searching'/,
    callback: () => context.db.run(
      "UPDATE evidence_bundles SET version=2,content_version='content-2',updated_at=2 WHERE id='bundle-1'",
    ),
  };

  const run = await context.jobs.startSearch("bundle-1", admin);
  await Promise.all(context.scheduled);

  assert.deepEqual({ ...context.db.first(
    "SELECT status,is_stale AS isStale FROM evidence_search_runs WHERE id=?",
    run.id,
  ) }, { status: "failed", isStale: 1 });
  assert.equal(context.provider.inputs.length, 0);
});

test("post-commit search insertion is reconciled and repeated queued starts repair handoff once", async () => {
  const context = createContext([candidate(1)]);
  seedBundle(context.db);
  const acquisitionEntered = deferred();
  const releaseAcquisition = deferred();
  context.db.afterNextRunCommit = {
    pattern: /INSERT OR IGNORE INTO evidence_search_runs/,
    callback: () => { throw new Error("simulated post-commit search insertion transport failure"); },
  };
  context.db.beforeNextRun = {
    pattern: /UPDATE evidence_search_runs SET status='searching'/,
    callback: async () => {
      acquisitionEntered.resolve();
      await releaseAcquisition.promise;
    },
  };

  const first = await context.jobs.startSearch("bundle-1", admin);
  await acquisitionEntered.promise;
  const second = await context.jobs.startSearch("bundle-1", admin);
  assert.equal(second.id, first.id);
  assert.equal(context.scheduled.length, 2);

  releaseAcquisition.resolve();
  await Promise.all(context.scheduled);
  assert.equal(context.provider.inputs.length, 1);
  assert.equal((await context.jobs.getSearch("bundle-1", first.id))?.run.status, "ready");
});

test("selection uses bundle CAS and never fetches or stores an unselected candidate", async () => {
  const fetchCalls: string[] = [];
  const context = createContext([candidate(1), candidate(2)], async (input) => {
    fetchCalls.push(input.url);
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  const sixIds = ["1", "2", "3", "4", "5", "6"];
  await assert.rejects(() => context.jobs.saveSelection("bundle-1", detail.run.id, {
    expectedBundleVersion: 1,
    selectedIds: sixIds,
    excludedIds: [],
  }, admin), /5개/);

  await select(context, detail, [0]);
  assert.deepEqual(
    context.db.all<{ action: string; actorUserId: string }>(
      `SELECT action,actor_user_id AS actorUserId FROM evidence_audit_events
        WHERE target_type='search_candidate' ORDER BY action`,
    ).map((row) => ({ ...row })),
    [
      { action: "search_candidate.excluded", actorUserId: admin.userId },
      { action: "search_candidate.selected", actorUserId: admin.userId },
    ],
  );
  const before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));

  assert.deepEqual(fetchCalls, [detail.candidates[0]!.url]);
  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 1);
  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_chunks").count, 0);
  assert.deepEqual(
    context.db.all<{ status: string; sourceId: string | null }>(
      "SELECT status,source_id AS sourceId FROM evidence_search_candidates ORDER BY rank",
    ).map((row) => ({ ...row })),
    [{ status: "imported", sourceId: context.db.first<{ id: string }>("SELECT id FROM evidence_sources").id }, { status: "excluded", sourceId: null }],
  );
});

test("one failed import preserves its successful sibling and retry is idempotent", async () => {
  const attempts = new Map<string, number>();
  const context = createContext([candidate(1), candidate(2)], async (input) => {
    const attempt = (attempts.get(input.url) ?? 0) + 1;
    attempts.set(input.url, attempt);
    if (input.url.endsWith("document-2") && attempt === 1) throw new Error("secret upstream timeout body");
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0, 1]);

  let before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual(
    context.db.all<{ status: string }>("SELECT status FROM evidence_search_candidates ORDER BY rank").map((row) => row.status),
    ["imported", "failed"],
  );
  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 1);
  assert.doesNotMatch(
    context.db.first<{ failureReason: string }>(
      "SELECT failure_reason AS failureReason FROM evidence_search_candidates WHERE status='failed'",
    ).failureReason,
    /secret|upstream|body/i,
  );

  before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual(
    context.db.all<{ status: string }>("SELECT status FROM evidence_search_candidates ORDER BY rank").map((row) => row.status),
    ["imported", "imported"],
  );
  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 2);
  assert.equal(attempts.get(detail.candidates[0]!.url), 1);
  assert.equal(attempts.get(detail.candidates[1]!.url), 2);

  const completed = await context.jobs.startImport("bundle-1", detail.run.id, admin);
  assert.equal(completed.status, "completed");
  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 2);
});

test("post-commit import start is reconciled and repeated importing starts repair handoff once", async () => {
  const fetchCalls: string[] = [];
  const context = createContext([candidate(1)], async (input) => {
    fetchCalls.push(input.url);
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0]);
  const acquisitionEntered = deferred();
  const releaseAcquisition = deferred();
  context.db.afterNextRunCommit = {
    pattern: /UPDATE evidence_search_runs\s+SET status='importing'/,
    callback: () => { throw new Error("simulated post-commit import start transport failure"); },
  };
  context.db.beforeNextRun = {
    pattern: /UPDATE evidence_search_candidates\s+SET status='importing'/,
    callback: async () => {
      acquisitionEntered.resolve();
      await releaseAcquisition.promise;
    },
  };

  const before = context.scheduled.length;
  const first = await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await acquisitionEntered.promise;
  const second = await context.jobs.startImport("bundle-1", detail.run.id, admin);
  assert.equal(first.id, second.id);
  assert.equal(context.scheduled.length - before, 2);

  releaseAcquisition.resolve();
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual(fetchCalls, [detail.candidates[0]!.url]);
  assert.equal((await context.jobs.getSearch("bundle-1", detail.run.id))?.run.status, "completed");
});

test("candidate acquisition transport failure is isolated, a sibling succeeds, and retry recovers", async () => {
  const fetchCalls: string[] = [];
  const context = createContext([candidate(1), candidate(2)], async (input) => {
    fetchCalls.push(input.url);
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0, 1]);
  context.db.beforeNextRun = {
    pattern: /UPDATE evidence_search_candidates\s+SET status='importing'/,
    callback: () => { throw new Error("simulated candidate acquisition transport failure"); },
  };

  let before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual(
    context.db.all<{ status: string }>("SELECT status FROM evidence_search_candidates ORDER BY rank").map((row) => row.status),
    ["selected", "imported"],
  );
  assert.deepEqual(fetchCalls, [detail.candidates[1]!.url]);
  assert.equal((await context.jobs.getSearch("bundle-1", detail.run.id))?.run.status, "importing");

  before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual(fetchCalls, [detail.candidates[1]!.url, detail.candidates[0]!.url]);
  assert.equal((await context.jobs.getSearch("bundle-1", detail.run.id))?.run.status, "completed");
});

test("post-commit candidate acquisition is reconciled without duplicate fetch work", async () => {
  const fetchCalls: string[] = [];
  const context = createContext([candidate(1), candidate(2)], async (input) => {
    fetchCalls.push(input.url);
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0, 1]);
  context.db.afterNextRunCommit = {
    pattern: /UPDATE evidence_search_candidates\s+SET status='importing'/,
    callback: () => { throw new Error("simulated post-commit candidate acquisition transport failure"); },
  };

  const before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));

  assert.deepEqual(fetchCalls, detail.candidates.map((value) => value.url));
  assert.deepEqual(
    context.db.all<{ status: string }>("SELECT status FROM evidence_search_candidates ORDER BY rank").map((row) => row.status),
    ["imported", "imported"],
  );
  assert.equal((await context.jobs.getSearch("bundle-1", detail.run.id))?.run.status, "completed");
});

test("post-commit candidate failure update is reconciled before a sibling succeeds and retry", async () => {
  const attempts = new Map<string, number>();
  const context = createContext([candidate(1), candidate(2)], async (input) => {
    const attempt = (attempts.get(input.url) ?? 0) + 1;
    attempts.set(input.url, attempt);
    if (input.url === candidate(1).url && attempt === 1) throw new Error("first fetch fails");
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0, 1]);
  context.db.afterNextRunCommit = {
    pattern: /UPDATE evidence_search_candidates SET status='failed'/,
    callback: () => { throw new Error("simulated post-commit candidate failure transport failure"); },
  };

  let before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual(
    context.db.all<{ status: string }>("SELECT status FROM evidence_search_candidates ORDER BY rank").map((row) => row.status),
    ["failed", "imported"],
  );
  assert.equal((await context.jobs.getSearch("bundle-1", detail.run.id))?.run.status, "completed");

  before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual(attempts, new Map([
    [detail.candidates[0]!.url, 2],
    [detail.candidates[1]!.url, 1],
  ]));
  assert.equal((await context.jobs.getSearch("bundle-1", detail.run.id))?.run.status, "completed");
});

test("pre-commit candidate failure update retries state repair and preserves sibling progress", async () => {
  const attempts = new Map<string, number>();
  const context = createContext([candidate(1), candidate(2)], async (input) => {
    const attempt = (attempts.get(input.url) ?? 0) + 1;
    attempts.set(input.url, attempt);
    if (input.url === candidate(1).url && attempt === 1) throw new Error("first fetch fails");
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0, 1]);
  context.db.beforeNextRun = {
    pattern: /UPDATE evidence_search_candidates SET status='failed'/,
    callback: () => { throw new Error("simulated pre-commit candidate failure transport failure"); },
  };

  const before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));

  assert.deepEqual(
    context.db.all<{ status: string }>("SELECT status FROM evidence_search_candidates ORDER BY rank").map((row) => row.status),
    ["failed", "imported"],
  );
  assert.equal((await context.jobs.getSearch("bundle-1", detail.run.id))?.run.status, "completed");
});

test("bundle mutation stales searches and an imported source stales prior analysis", async () => {
  const context = createContext([candidate(1)]);
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0]);
  seedApprovedWork(context.db);

  const before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));
  assert.deepEqual({ ...context.db.first(
    "SELECT status,is_stale AS isStale FROM evidence_analysis_jobs WHERE id='analysis-1'",
  ) }, { status: "failed", isStale: 1 });
  assert.deepEqual({ ...context.db.first(
    "SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='card-1'",
  ) }, { status: "held", isStale: 1 });
  assert.equal(context.db.first<{ isStale: number }>(
    "SELECT is_stale AS isStale FROM evidence_search_runs WHERE id=?",
    detail.run.id,
  ).isStale, 0, "the importing run must advance with its own registered source");

  await context.service.updateBundle("bundle-1", { purpose: "changed" }, admin);
  assert.equal(context.db.first<{ isStale: number }>(
    "SELECT is_stale AS isStale FROM evidence_search_runs WHERE id=?",
    detail.run.id,
  ).isStale, 1);
  const currentVersion = context.db.first<{ version: number }>("SELECT version FROM evidence_bundles WHERE id='bundle-1'").version;
  const selection: SearchSelectionInput = {
    expectedBundleVersion: currentVersion,
    selectedIds: [detail.candidates[0]!.id],
    excludedIds: [],
  };
  await assert.rejects(
    () => context.jobs.saveSelection("bundle-1", detail.run.id, selection, admin),
    /갱신|오래된/,
  );
});

test("selection CAS leaves candidate and audit state unchanged when the bundle wins the race", async () => {
  const context = createContext([candidate(1), candidate(2)]);
  seedBundle(context.db);
  const detail = await runSearch(context);
  context.db.beforeNextBatch = () => {
    context.db.run("UPDATE evidence_bundles SET version=version+1,updated_at=updated_at+1 WHERE id='bundle-1'");
  };

  await assert.rejects(() => context.jobs.saveSelection("bundle-1", detail.run.id, {
    expectedBundleVersion: 1,
    selectedIds: [detail.candidates[0]!.id],
    excludedIds: [detail.candidates[1]!.id],
  }, admin), /갱신/);

  assert.deepEqual(
    context.db.all<{ status: string }>("SELECT status FROM evidence_search_candidates ORDER BY rank").map((row) => row.status),
    ["candidate", "candidate"],
  );
  assert.equal(context.db.first<{ count: number }>(
    "SELECT count(*) AS count FROM evidence_audit_events WHERE target_type='search_candidate'",
  ).count, 0);
});

test("a known zero-row selection CAS remains a conflict after an identical concurrent winner and bundle mutation", async () => {
  const context = createContext([candidate(1), candidate(2)]);
  seedBundle(context.db);
  const detail = await runSearch(context);
  const input: SearchSelectionInput = {
    expectedBundleVersion: 1,
    selectedIds: [detail.candidates[0]!.id],
    excludedIds: [detail.candidates[1]!.id],
  };
  const staleBatchEntered = deferred();
  const releaseStaleBatch = deferred();
  context.db.beforeNextBatch = async () => {
    staleBatchEntered.resolve();
    await releaseStaleBatch.promise;
  };

  const staleSelection = context.jobs.saveSelection("bundle-1", detail.run.id, input, admin);
  await staleBatchEntered.promise;
  await context.jobs.saveSelection("bundle-1", detail.run.id, input, admin);
  context.db.run(
    "UPDATE evidence_bundles SET version=2,content_version='content-2',updated_at=updated_at+1 WHERE id='bundle-1'",
  );
  releaseStaleBatch.resolve();

  await assert.rejects(staleSelection, /갱신/);
  assert.equal(context.db.first<{ count: number }>(
    "SELECT count(*) AS count FROM evidence_audit_events WHERE target_type='search_candidate'",
  ).count, 2);
});

test("registration CAS cleanup leaves no source or R2 object and records a terminal candidate failure", async () => {
  const context = createContext([candidate(1)], async (input) => {
    context.db.beforeNextBatch = () => {
      context.db.run("UPDATE evidence_bundles SET version=version+1,updated_at=updated_at+1 WHERE id='bundle-1'");
    };
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0]);

  const before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));

  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 0);
  assert.equal(context.bucket.objects.size, 0);
  assert.equal(context.db.first<{ status: string }>(
    "SELECT status FROM evidence_search_candidates WHERE id=?",
    detail.candidates[0]!.id,
  ).status, "failed");
  assert.equal(context.db.first<{ status: string }>(
    "SELECT status FROM evidence_search_runs WHERE id=?",
    detail.run.id,
  ).status, "failed");
});

test("a post-commit registration transport failure reconciles to one imported source and current run authority", async () => {
  const context = createContext([candidate(1)], async (input) => {
    context.db.afterNextBatchCommit = () => { throw new Error("simulated post-commit transport failure"); };
    return successfulFetch(input);
  });
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0]);

  const before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));

  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 1);
  assert.equal(context.bucket.objects.size, 2);
  assert.deepEqual({ ...context.db.first(
    `SELECT candidate.status,candidate.source_id AS sourceId,run.status AS runStatus,
      run.bundle_version AS runBundleVersion,bundle.version AS bundleVersion,run.is_stale AS isStale
      FROM evidence_search_candidates AS candidate
      JOIN evidence_search_runs AS run ON run.id=candidate.run_id
      JOIN evidence_bundles AS bundle ON bundle.id=run.bundle_id
      WHERE candidate.id=?`,
    detail.candidates[0]!.id,
  ) }, {
    status: "imported",
    sourceId: context.db.first<{ id: string }>("SELECT id FROM evidence_sources").id,
    runStatus: "completed",
    runBundleVersion: 2,
    bundleVersion: 2,
    isStale: 0,
  });
});

test("production runtime exposes external jobs without starting a search implicitly", async () => {
  const db = new SQLiteD1Database();
  const bucket = new MemoryR2Bucket();
  const scheduled: Promise<unknown>[] = [];
  const provider = new RecordingProvider({ queries: ["official coaching"], candidates: [candidate(1)] });
  const runtime = createEvidenceProductionRuntime({
    bindings: { DB: db, EVIDENCE_FILES: bucket },
    admin,
    settings,
    externalSearch: {
      provider,
      policy,
      promptVersion: "search-prompt-v1",
      schedule: (promise) => scheduled.push(promise),
      fetch: async () => { throw new Error("not used by search"); },
      resolveHost: async () => ["203.0.113.1"],
    },
  });
  seedBundle(db);

  assert.ok(runtime.searchJobs);
  assert.equal(db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_search_runs").count, 0);
  const run = await runtime.searchJobs.startSearch("bundle-1", admin);
  await Promise.all(scheduled);
  assert.equal((await runtime.searchJobs.getSearch("bundle-1", run.id))?.run.status, "ready");
});

test("search provider failure stores only a bounded classified message and leaves existing work untouched", async () => {
  const context = createContext();
  seedBundle(context.db);
  seedApprovedWork(context.db);
  const scheduled: Promise<unknown>[] = [];
  const jobs = new EvidenceExternalSearchJobs({
    db: context.db,
    provider: {
      modelId: "search-model-failure",
      async search() {
        throw new Error(`secret raw provider body ${"x".repeat(1_000)}`);
      },
    },
    policy,
    files: context.fileStore,
    promptVersion: "search-prompt-v1",
    fetchExternalEvidence: async (input) => successfulFetch(input),
    schedule: (promise) => scheduled.push(promise),
  });

  const run = await jobs.startSearch("bundle-1", admin);
  await Promise.all(scheduled);

  const failed = await jobs.getSearch("bundle-1", run.id);
  assert.ok(failed);
  assert.equal(failed.run.status, "failed");
  assert.ok((failed.run.errorMessage?.length ?? 0) <= 240);
  assert.match(failed.run.errorMessage ?? "", /[가-힣]/);
  assert.doesNotMatch(failed.run.errorMessage ?? "", /secret|provider|body/i);
  assert.equal(failed.candidates.length, 0);
  assert.deepEqual({ ...context.db.first(
    "SELECT status,is_stale AS isStale FROM evidence_analysis_jobs WHERE id='analysis-1'",
  ) }, { status: "queued", isStale: 0 });
  assert.deepEqual({ ...context.db.first(
    "SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='card-1'",
  ) }, { status: "coach_reviewed", isStale: 0 });
});

test("quote mismatch fails before R2 and D1 source registration", async () => {
  const context = createContext([candidate(1)], async (input) => ({
    ...successfulFetch(input),
    extractedPages: [{ locator: "section 1", text: "different upstream text" }],
  }));
  seedBundle(context.db);
  const detail = await runSearch(context);
  await select(context, detail, [0]);

  const before = context.scheduled.length;
  await context.jobs.startImport("bundle-1", detail.run.id, admin);
  await Promise.all(context.scheduled.slice(before));

  assert.equal(context.bucket.objects.size, 0);
  assert.equal(context.db.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 0);
  assert.deepEqual({ ...context.db.first(
    "SELECT status,failure_reason AS failureReason FROM evidence_search_candidates WHERE id=?",
    detail.candidates[0]!.id,
  ) }, {
    status: "failed",
    failureReason: "선택한 인용을 외부 문서에서 확인할 수 없습니다.",
  });
});
