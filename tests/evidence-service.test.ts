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
  beforeNextBatch: (() => void) | null = null;

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
    before?.();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SQLiteD1Statement)) throw new Error("Unexpected D1 statement implementation.");
        return statement.execute();
      });
      this.database.exec("COMMIT");
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

  async put(key: string, value: Uint8Array | string): Promise<void> {
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
    "job-1", bundle.id, bundle.contentVersion, "queued", "model-1", "prompt-1", "schema-1", "queued", 0, 1, 1,
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
      "race-job", bundle.id, "race-input", "completed", "model-1", "prompt-1", "schema-1", "completed", 0, 1, 1,
    );
    context.database.run(
      `INSERT INTO tactic_cards
        (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      "race-card", bundle.id, "race-job", beforeDelete.contentVersion, "coach_reviewed", "{}", "{}", 0, 1, 1,
    );
    context.database.run(
      `INSERT INTO evidence_chunks
        (id,bundle_id,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      "race-chunk", bundle.id, source.id, null, 0, "p1", "근거", "chunk-hash", 1,
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
});

test("a draft scenario link created after impact checks aborts deletion", async () => {
  const context = createContext();
  const bundle = await context.service.createBundle(bundleInput, admin);
  const source = await uploadText(context, bundle.id);
  const beforeDelete = await context.repository.getBundle(bundle.id);
  assert.ok(beforeDelete);
  context.database.beforeNextBatch = () => {
    context.database.run(
      `INSERT INTO scenarios
        (id,campaign_id,role,principle,prompt,hint,explanation,pitch_json,answer_json,content_json,review_status,order_index)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      "race-scenario", "diamond-121-intro", "ala", "width", "p", "h", "e", "{}", "{}",
      JSON.stringify({ sourceIds: [source.id] }), "draft", 99,
    );
  };

  await assert.rejects(() => context.service.removeSource(source.id, admin), /연결/);

  assert.ok(await context.repository.findSource(source.id));
  assert.ok(context.bucket.objects.has(source.storageKey));
  assert.ok(source.extractedTextKey !== null && context.bucket.objects.has(source.extractedTextKey));
  assert.deepEqual(await context.repository.getBundle(bundle.id), beforeDelete);
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
});
