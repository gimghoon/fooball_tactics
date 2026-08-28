import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import type { EvidenceAdmin } from "../lib/server/evidence-auth.ts";
import { createEvidenceProductionRuntime } from "../lib/server/evidence-runtime.ts";
import {
  D1EvidenceServiceRepository,
  EvidenceConflictError,
  type EvidenceBundleRecord,
  type EvidenceD1Database,
  type EvidenceD1Statement,
} from "../lib/server/evidence-service.ts";
import type { EvidenceR2Bucket, StoredEvidenceFile } from "../lib/server/evidence-storage.ts";

const admin: EvidenceAdmin = {
  userId: "admin-1",
  email: "admin@example.test",
  displayName: "Admin",
  fullName: "Admin User",
};
const settings = { analyzerModel: "model-1", promptVersion: "prompt-1", schemaVersion: "schema-1" };
const bundleInput = { title: "드리블 대응", purpose: "전방 압박 대응 분석" };

class SQLiteD1Statement implements EvidenceD1Statement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
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
    return this.execute();
  }

  execute(): { meta: { changes: number } } {
    const result = this.database.prepare(this.query).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

/** Executes the production repository's exact SQL in one sequential SQLite transaction. */
class SQLiteD1Database implements EvidenceD1Database {
  readonly database = new DatabaseSync(":memory:");
  beforeNextBatch: (() => void | Promise<void>) | null = null;
  afterNextBatchCommit: (() => void | Promise<void>) | null = null;

  constructor() {
    this.database.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync("drizzle").filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort()) {
      this.database.exec(readFileSync(`drizzle/${name}`, "utf8"));
    }
  }

  prepare(query: string): EvidenceD1Statement {
    return new SQLiteD1Statement(this.database, query);
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
      const afterCommit = this.afterNextBatchCommit;
      this.afterNextBatchCommit = null;
      await afterCommit?.();
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
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
  afterObjectsDeleted: (() => void | Promise<void>) | null = null;
  afterPutCount: { count: number; callback: () => void | Promise<void> } | null = null;
  failDelete: ((key: string) => boolean) | null = null;

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.putKeys.push(key);
    this.objects.set(key, value instanceof Uint8Array ? value.slice() : value);
    if (this.afterPutCount !== null && this.putKeys.length === this.afterPutCount.count) {
      const callback = this.afterPutCount.callback;
      this.afterPutCount = null;
      await callback();
    }
  }

  async get(key: string): Promise<Uint8Array | string | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return value instanceof Uint8Array ? value.slice() : value;
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete?.(key)) throw new Error(`permanent delete failure for ${key}`);
    this.objects.delete(key);
    if (this.objects.size === 0 && this.afterObjectsDeleted !== null) {
      const afterObjectsDeleted = this.afterObjectsDeleted;
      this.afterObjectsDeleted = null;
      await afterObjectsDeleted();
    }
  }
}

function createContext() {
  const database = new SQLiteD1Database();
  const repository = new D1EvidenceServiceRepository(database);
  const bucket = new MemoryR2Bucket();
  let id = 0;
  let now = 1_000;
  const { fileStore, service } = createEvidenceProductionRuntime({
    bindings: { DB: database, EVIDENCE_FILES: bucket },
    admin,
    settings,
    newId: () => `generated-${++id}`,
    now: () => ++now,
  });
  return { database, repository, bucket, fileStore, service };
}

function sourceFor(bundleId: string): StoredEvidenceFile {
  return {
    id: "source-1",
    bundleId,
    originalFileName: "pressing.md",
    mediaType: "text/markdown",
    byteSize: 12,
    contentHash: "source-hash-1",
    storageKey: "original-key",
    extractedTextKey: "extracted-key",
    extractionStatus: "completed",
    extractionError: null,
  };
}

function seedApprovedWork(database: SQLiteD1Database, bundle: EvidenceBundleRecord): void {
  database.run(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    "job-1", bundle.id, bundle.contentVersion, "queued", "model-1", "prompt-1", "schema-1", "validate_sources", 0, 1, 1,
  );
  database.run(
    `INSERT INTO tactic_cards
      (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "card-1", bundle.id, "job-1", bundle.contentVersion, "coach_reviewed", "{}", "{}", 0, 1, 1,
  );
}

async function uploadText(context: ReturnType<typeof createContext>, bundleId: string): Promise<StoredEvidenceFile> {
  return context.fileStore.putValidatedFile({
    bundleId,
    name: "pressing.md",
    type: "text/markdown",
    bytes: new TextEncoder().encode("압박 대응"),
  });
}

function insertDraftScenario(database: SQLiteD1Database, scenarioId: string, contentJson: string): void {
  database.run(
    `INSERT INTO scenarios
      (id,campaign_id,role,principle,prompt,hint,explanation,pitch_json,answer_json,content_json,review_status,order_index)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    scenarioId, "diamond-121-intro", "ala", "width", "p", "h", "e", "{}", "{}", contentJson, "draft", 99,
  );
}

function linkScenarioSource(database: SQLiteD1Database, scenarioId: string, sourceId: string): void {
  database.run(
    "INSERT INTO scenario_evidence_sources (scenario_id,source_id) VALUES (?,?)",
    scenarioId,
    sourceId,
  );
}

async function removeSourceAsCompetingWinner(
  context: ReturnType<typeof createContext>,
  sourceId: string,
): Promise<void> {
  await context.service.removeSource(sourceId, admin);
}

test("production source upload atomically inserts, versions, invalidates approved work, and audits", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  seedApprovedWork(context.database, bundle);

  await uploadText(context, bundle.id);

  const changed = context.database.first<{ version: number; contentVersion: string }>(
    "SELECT version, content_version AS contentVersion FROM evidence_bundles WHERE id=?",
    bundle.id,
  );
  assert.equal(changed.version, 2);
  assert.notEqual(changed.contentVersion, bundle.contentVersion);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 1);
  assert.equal(context.bucket.objects.size, 2);
  assert.deepEqual(
    { ...context.database.first("SELECT status,is_stale AS isStale,error_message AS errorMessage FROM evidence_analysis_jobs WHERE id='job-1'") },
    { status: "failed", isStale: 1, errorMessage: "evidence version superseded" },
  );
  assert.deepEqual(
    { ...context.database.first("SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='card-1'") },
    { status: "held", isStale: 1 },
  );
  assert.deepEqual(
    context.database.all<{ action: string }>("SELECT action FROM evidence_audit_events ORDER BY created_at").map((row) => row.action),
    ["bundle.created", "source.added"],
  );
});

test("production external registration persists every metadata field and deduplicates by URL or hash", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const metadata = {
    origin: "external_web" as const,
    canonicalUrl: "https://fifa.com/guidance/width?a=1&z=2",
    publisher: "FIFA",
    publishedAt: "2026-08-20",
    retrievedAt: 1_777_000_000_000,
    searchCandidateId: "candidate-1",
  };
  const bytes = new TextEncoder().encode("Use the wide lane.");

  const source = await context.fileStore.putValidatedFile({
    bundleId: bundle.id,
    name: "ignored-user-name.txt",
    type: "text/plain",
    bytes,
    externalMetadata: metadata,
  });
  const row = context.database.first<Record<string, unknown>>(
    `SELECT origin,canonical_url AS canonicalUrl,publisher,published_at AS publishedAt,
      retrieved_at AS retrievedAt,search_candidate_id AS searchCandidateId,external_text_hash AS externalTextHash
      FROM evidence_sources WHERE id=?`,
    source.id,
  );
  assert.deepEqual({ ...row }, {
    origin: "external_web",
    canonicalUrl: metadata.canonicalUrl,
    publisher: metadata.publisher,
    publishedAt: metadata.publishedAt,
    retrievedAt: metadata.retrievedAt,
    searchCandidateId: metadata.searchCandidateId,
    externalTextHash: source.externalTextHash,
  });
  assert.match(String(row.externalTextHash), /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...await context.repository.findSource(source.id) }, source);

  const objectCount = context.bucket.objects.size;
  const sameUrl = await context.fileStore.putValidatedFile({
    bundleId: bundle.id,
    name: "changed.txt",
    type: "text/plain",
    bytes: new TextEncoder().encode("Changed upstream body."),
    externalMetadata: { ...metadata, searchCandidateId: "candidate-2" },
  });
  const sameHash = await context.fileStore.putValidatedFile({
    bundleId: bundle.id,
    name: "mirror.txt",
    type: "text/plain",
    bytes,
    externalMetadata: { ...metadata, canonicalUrl: "https://fifa.com/guidance/mirror", searchCandidateId: "candidate-3" },
  });

  assert.equal(sameUrl.id, source.id);
  assert.equal(sameHash.id, source.id);
  assert.equal(context.bucket.objects.size, objectCount);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 1);
});

test("production registration retains committed R2 objects when D1 commits and the transport then throws", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  context.database.afterNextBatchCommit = () => { throw new Error("simulated post-commit transport failure"); };

  const source = await uploadText(context, bundle.id);

  assert.equal((await context.repository.findSource(source.id))?.id, source.id);
  assert.equal(context.bucket.objects.has(source.storageKey), true);
  assert.equal(source.extractedTextKey === null ? false : context.bucket.objects.has(source.extractedTextKey), true);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_r2_cleanup_receipts").count, 0);
});

test("production repository keeps cleanup ownership metadata after bundle deletion and reports missing receipts", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  await context.repository.createR2CleanupReceipt({
    id: "cleanup-1",
    bundleId: bundle.id,
    sourceId: "unowned-source",
    storageKey: "unowned-original",
    extractedTextKey: "unowned-extracted",
    createdAt: 2_000,
  });
  assert.deepEqual({ ...context.database.first("SELECT status,error_message AS errorMessage FROM evidence_r2_cleanup_receipts WHERE id='cleanup-1'") }, {
    status: "pending",
    errorMessage: null,
  });

  context.database.run("DELETE FROM evidence_bundles WHERE id=?", bundle.id);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_r2_cleanup_receipts WHERE id='cleanup-1'").count, 1);

  await context.repository.finishR2CleanupReceipt("cleanup-1", {
    storageKey: "unowned-original",
    extractedTextKey: null,
    error: "delete failure",
  }, 2_001);
  assert.deepEqual({ ...context.database.first("SELECT bundle_id AS bundleId,storage_key AS storageKey,extracted_text_key AS extractedTextKey,status,error_message AS errorMessage,updated_at AS updatedAt FROM evidence_r2_cleanup_receipts WHERE id='cleanup-1'") }, {
    bundleId: bundle.id,
    storageKey: "unowned-original",
    extractedTextKey: null,
    status: "pending",
    errorMessage: "delete failure",
    updatedAt: 2_001,
  });

  await context.repository.finishR2CleanupReceipt("cleanup-1", {
    storageKey: null,
    extractedTextKey: null,
    error: null,
  }, 2_002);
  assert.deepEqual({ ...context.database.first("SELECT storage_key AS storageKey,extracted_text_key AS extractedTextKey,status,error_message AS errorMessage,updated_at AS updatedAt FROM evidence_r2_cleanup_receipts WHERE id='cleanup-1'") }, {
    storageKey: null,
    extractedTextKey: null,
    status: "completed",
    errorMessage: null,
    updatedAt: 2_002,
  });

  await assert.rejects(
    () => context.repository.finishR2CleanupReceipt("missing-cleanup", {
      storageKey: "still-unowned",
      extractedTextKey: null,
      error: "delete failure",
    }, 2_003),
    /정리 영수증.*찾을 수 없습니다/,
  );
});

test("missing-bundle registration leaves a durable pending receipt with only the undeleted R2 key", async () => {
  const context = createContext();
  context.bucket.failDelete = (key) => key === context.bucket.putKeys[0];

  await assert.rejects(() => uploadText(context, "missing-bundle"), /정리/);

  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_bundles").count, 0);
  assert.equal(context.bucket.objects.has(context.bucket.putKeys[0]!), true);
  assert.equal(context.bucket.objects.has(context.bucket.putKeys[1]!), false);
  assert.deepEqual({ ...context.database.first(
    "SELECT bundle_id AS bundleId,storage_key AS storageKey,extracted_text_key AS extractedTextKey,status,error_message AS errorMessage FROM evidence_r2_cleanup_receipts",
  ) }, {
    bundleId: "missing-bundle",
    storageKey: context.bucket.putKeys[0],
    extractedTextKey: null,
    status: "pending",
    errorMessage: `permanent delete failure for ${context.bucket.putKeys[0]}`,
  });
});

test("production URL-race cleanup never restores a deleted loser object and leaves a pending receipt on failure", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const canonicalUrl = "https://fifa.com/guidance/race";
  context.bucket.afterPutCount = {
    count: 2,
    callback: () => context.database.run(
      `INSERT INTO evidence_sources
        (id,bundle_id,origin,original_file_name,media_type,byte_size,content_hash,storage_key,canonical_url,
          publisher,published_at,retrieved_at,search_candidate_id,external_text_hash,extracted_text_key,
          extraction_status,extraction_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      "winner-source", bundle.id, "external_web", "winner.txt", "text/plain", 6, "winner-hash", "winner-original",
      canonicalUrl, "FIFA", "2026-08-20", 1_777_000_000_000, "winner-candidate", "winner-text-hash",
      "winner-extracted", "completed", null, 2_000, 2_000,
    ),
  };
  context.bucket.failDelete = (key) => key === context.bucket.putKeys[0];

  await assert.rejects(() => context.fileStore.putValidatedFile({
    bundleId: bundle.id,
    name: "loser.txt",
    type: "text/plain",
    bytes: new TextEncoder().encode("loser body"),
    externalMetadata: {
      origin: "external_web",
      canonicalUrl,
      publisher: "FIFA",
      publishedAt: "2026-08-20",
      retrievedAt: 1_777_000_000_001,
      searchCandidateId: "loser-candidate",
    },
  }), /정리/);

  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 1);
  assert.equal((await context.repository.findSourceByHash(bundle.id, "unmatched", canonicalUrl))?.id, "winner-source");
  assert.equal(context.bucket.objects.has(context.bucket.putKeys[0]!), true);
  assert.equal(context.bucket.objects.has(context.bucket.putKeys[1]!), false);
  assert.equal(context.bucket.putKeys.length, 2, "loser cleanup must not restore the deleted extracted object");
  assert.deepEqual({ ...context.database.first(
    "SELECT storage_key AS storageKey,extracted_text_key AS extractedTextKey,status,error_message AS errorMessage FROM evidence_r2_cleanup_receipts",
  ) }, {
    storageKey: context.bucket.putKeys[0],
    extractedTextKey: null,
    status: "pending",
    errorMessage: `permanent delete failure for ${context.bucket.putKeys[0]}`,
  });
});

test("a lost bundle CAS changes none of the guarded source, work, or audit rows", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  seedApprovedWork(context.database, bundle);
  context.database.beforeNextBatch = () => {
    context.database.run(
      "UPDATE evidence_bundles SET version=7,content_version='winner-version',updated_at=777 WHERE id=?",
      bundle.id,
    );
  };

  await assert.rejects(() => context.service.addSource(sourceFor(bundle.id), admin), EvidenceConflictError);

  assert.deepEqual(
    { ...context.database.first("SELECT version,content_version AS contentVersion,updated_at AS updatedAt FROM evidence_bundles WHERE id=?", bundle.id) },
    { version: 7, contentVersion: "winner-version", updatedAt: 777 },
  );
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_sources").count, 0);
  assert.deepEqual(
    { ...context.database.first("SELECT status,is_stale AS isStale,error_message AS errorMessage FROM evidence_analysis_jobs WHERE id='job-1'") },
    { status: "queued", isStale: 0, errorMessage: null },
  );
  assert.deepEqual(
    { ...context.database.first("SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='card-1'") },
    { status: "coach_reviewed", isStale: 0 },
  );
  assert.deepEqual(
    context.database.all<{ action: string }>("SELECT action FROM evidence_audit_events").map((row) => row.action),
    ["bundle.created"],
  );
});

test("a missing required source makes the mutation and final CAS affect zero rows", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  seedApprovedWork(context.database, bundle);
  const next = {
    ...bundle,
    version: bundle.version + 1,
    contentVersion: "missing-target-version",
    updatedAt: bundle.updatedAt + 1,
  };

  const applied = await context.repository.applyMutation({
    current: bundle,
    next,
    sourceToDelete: "missing-source",
    audit: {
      id: "missing-source-audit",
      bundleId: bundle.id,
      actorUserId: admin.userId,
      action: "source.removed",
      targetType: "source",
      targetId: "missing-source",
      detailsJson: "{}",
      createdAt: next.updatedAt,
    },
  });

  assert.equal(applied, false);
  assert.deepEqual({ ...await context.repository.getBundle(bundle.id) }, bundle);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events WHERE action='source.removed'").count, 0);
  assert.deepEqual(
    { ...context.database.first("SELECT status,is_stale AS isStale,error_message AS errorMessage FROM evidence_analysis_jobs WHERE id='job-1'") },
    { status: "queued", isStale: 0, errorMessage: null },
  );
  assert.deepEqual(
    { ...context.database.first("SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='card-1'") },
    { status: "coach_reviewed", isStale: 0 },
  );
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_mutation_receipts").count, 0);
});

test("a card link created after impact checks aborts D1 deletion and restores both R2 objects", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  const beforeDelete = await context.repository.getBundle(bundle.id);
  assert.ok(beforeDelete);
  context.database.beforeNextBatch = () => {
    context.database.run(
      `INSERT INTO evidence_analysis_jobs
        (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      "race-job", bundle.id, "race-input", "completed", "model-1", "prompt-1", "schema-1", "done", 0, 1, 1,
    );
    context.database.run(
      `INSERT INTO tactic_cards
        (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      "race-card", bundle.id, "race-job", beforeDelete.contentVersion, "coach_reviewed", "{}", "{}", 0, 1, 1,
    );
    context.database.run(
      `INSERT INTO evidence_chunks
        (id,bundle_id,input_version,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      "race-chunk", bundle.id, beforeDelete.contentVersion, source.id, null, 0, "p1", "근거", "chunk-hash", 1,
    );
    context.database.run(
      "INSERT INTO tactic_card_citations (id,bundle_id,card_id,chunk_id,created_at) VALUES (?,?,?,?,?)",
      "race-citation", bundle.id, "race-card", "race-chunk", 1,
    );
  };

  await assert.rejects(() => context.service.removeSource(source.id, admin), /연결/);

  assert.ok(await context.repository.findSource(source.id));
  assert.ok(context.bucket.objects.has(source.storageKey));
  assert.ok(source.extractedTextKey !== null && context.bucket.objects.has(source.extractedTextKey));
  assert.deepEqual(await context.repository.getBundle(bundle.id), beforeDelete);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events WHERE action='source.removed'").count, 0);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_mutation_receipts").count, 0);
});

test("an exact draft-scenario relation created after impact checks aborts deletion", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  const beforeDelete = await context.repository.getBundle(bundle.id);
  assert.ok(beforeDelete);
  context.database.beforeNextBatch = () => {
    insertDraftScenario(context.database, "race-scenario", JSON.stringify({ narrative: "unrelated" }));
    linkScenarioSource(context.database, "race-scenario", source.id);
  };

  await assert.rejects(() => context.service.removeSource(source.id, admin), /연결/);

  assert.ok(await context.repository.findSource(source.id));
  assert.ok(context.bucket.objects.has(source.storageKey));
  assert.ok(source.extractedTextKey !== null && context.bucket.objects.has(source.extractedTextKey));
  assert.deepEqual(await context.repository.getBundle(bundle.id), beforeDelete);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_mutation_receipts").count, 0);
});

test("an exact scenario/source relation is reported and blocks deletion before R2", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  insertDraftScenario(context.database, "linked-scenario", JSON.stringify({ narrative: "no source id here" }));
  linkScenarioSource(context.database, "linked-scenario", source.id);

  assert.deepEqual(await context.service.describeDeleteImpact(source.id), {
    sourceId: source.id,
    cardIds: [],
    scenarioDraftIds: ["linked-scenario"],
  });
  await assert.rejects(() => context.service.removeSource(source.id, admin), /연결/);
  assert.ok(context.bucket.objects.has(source.storageKey));
  assert.ok(source.extractedTextKey !== null && context.bucket.objects.has(source.extractedTextKey));
});

test("unrelated scenario narrative text containing a source id does not block deletion", async () => {
  const context = createContext();
  assert.equal(
    context.database.first<{ count: number }>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name='trg_evidence_sources_block_linked_delete'",
    ).count,
    0,
  );
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  insertDraftScenario(
    context.database,
    "narrative-scenario",
    JSON.stringify({ narrative: `The identifier ${source.id} is only quoted text.` }),
  );

  await context.service.removeSource(source.id, admin);

  assert.equal(await context.repository.findSource(source.id), null);
  assert.equal(context.bucket.objects.size, 0);
});

test("deleting a scenario cascades its exact evidence relations", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  insertDraftScenario(context.database, "cascade-scenario", "{}");
  linkScenarioSource(context.database, "cascade-scenario", source.id);

  context.database.run("DELETE FROM scenarios WHERE id=?", "cascade-scenario");

  assert.equal(
    context.database.first<{ count: number }>(
      "SELECT count(*) AS count FROM scenario_evidence_sources WHERE scenario_id=?",
      "cascade-scenario",
    ).count,
    0,
  );
  assert.ok(await context.repository.findSource(source.id));
});

test("a scenario relation cannot be inserted after its source was deleted", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  await context.service.removeSource(source.id, admin);
  insertDraftScenario(context.database, "late-scenario", "{}");

  assert.throws(
    () => linkScenarioSource(context.database, "late-scenario", source.id),
    /FOREIGN KEY/,
  );
});

test("a competing removal that wins before the loser rereads D1 does not double-version or restore R2", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  const beforeDelete = await context.repository.getBundle(bundle.id);
  assert.ok(beforeDelete);
  context.bucket.afterObjectsDeleted = () => removeSourceAsCompetingWinner(context, source.id);

  await assert.rejects(() => context.service.removeSource(source.id, admin), EvidenceConflictError);

  const afterDelete = await context.repository.getBundle(bundle.id);
  assert.ok(afterDelete);
  assert.equal(afterDelete.version, beforeDelete.version + 1);
  assert.equal(await context.repository.findSource(source.id), null);
  assert.equal(context.bucket.objects.size, 0);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events WHERE action='source.removed'").count, 1);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_mutation_receipts").count, 1);
});

test("a competing removal that wins after the loser reads old state leaves loser R2 deleted", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  const beforeDelete = await context.repository.getBundle(bundle.id);
  assert.ok(beforeDelete);
  context.database.beforeNextBatch = () => removeSourceAsCompetingWinner(context, source.id);

  await assert.rejects(() => context.service.removeSource(source.id, admin), EvidenceConflictError);

  const afterDelete = await context.repository.getBundle(bundle.id);
  assert.ok(afterDelete);
  assert.equal(afterDelete.version, beforeDelete.version + 1);
  assert.equal(await context.repository.findSource(source.id), null);
  assert.equal(context.bucket.objects.size, 0);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events WHERE action='source.removed'").count, 1);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_mutation_receipts").count, 1);
});

test("an unlinked source removal deletes D1 and both R2 objects in one compensated workflow", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  const beforeDelete = await context.repository.getBundle(bundle.id);
  assert.ok(beforeDelete);

  const changed = await context.service.removeSource(source.id, admin);

  assert.equal(changed.version, beforeDelete.version + 1);
  assert.equal(await context.repository.findSource(source.id), null);
  assert.equal(context.bucket.objects.has(source.storageKey), false);
  assert.equal(source.extractedTextKey === null ? true : context.bucket.objects.has(source.extractedTextKey), false);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events WHERE action='source.removed'").count, 1);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_mutation_receipts").count, 1);
});
