import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import type { TacticCardContent } from "../lib/domain/evidence.ts";
import {
  EvidenceAnalyzerError,
  type EvidenceAnalyzer,
  type EvidenceChunkInput,
  type ExtractedEvidence,
} from "../lib/server/evidence-analyzer.ts";
import type { EvidenceAdmin } from "../lib/server/evidence-auth.ts";
import {
  EvidenceAnalysisJobs,
  type EvidenceAnalysisJobRecord,
} from "../lib/server/evidence-jobs.ts";
import type { EvidenceD1Database, EvidenceD1Statement } from "../lib/server/evidence-service.ts";

const admin: EvidenceAdmin = {
  userId: "admin-1",
  email: "admin@example.test",
  displayName: "Admin",
  fullName: "Admin User",
};
const settings = { analyzerModel: "model-1", promptVersion: "prompt-1", schemaVersion: "schema-1" };

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

class SQLiteD1Database implements EvidenceD1Database {
  readonly database = new DatabaseSync(":memory:");

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

class MemoryFiles {
  readonly objects = new Map<string, unknown>();

  async getFile(key: string): Promise<unknown | null> {
    return this.objects.get(key) ?? null;
  }
}

type AnalyzerBehavior = {
  extract?: (input: { chunks: EvidenceChunkInput[]; promptVersion: string }) => Promise<ExtractedEvidence[]>;
  cards?: (input: {
    extracted: ExtractedEvidence[];
    allowedCitationIds: string[];
    promptVersion: string;
    schemaVersion: string;
  }) => Promise<TacticCardContent[]>;
};

class RecordingAnalyzer implements EvidenceAnalyzer {
  readonly modelId = settings.analyzerModel;
  readonly calls: string[] = [];

  constructor(private readonly behavior: AnalyzerBehavior = {}) {}

  async analyzeExtraction(
    input: { chunks: EvidenceChunkInput[]; promptVersion: string },
  ): Promise<ExtractedEvidence[]> {
    this.calls.push("extract");
    if (this.behavior.extract) return this.behavior.extract(input);
    const citationId = input.chunks[0]?.id ?? "missing";
    return [{
      citationIds: [citationId],
      situation: "압박을 받는 상황",
      conditions: ["전방 압박"],
      cues: ["측면 공간"],
      actions: [{ action: "pass", reason: "압박 회피", citationIds: [citationId] }],
      outcomes: ["전진"],
      exceptions: [],
    }];
  }

  async generateCards(
    input: {
      extracted: ExtractedEvidence[];
      allowedCitationIds: string[];
      promptVersion: string;
      schemaVersion: string;
    },
  ): Promise<TacticCardContent[]> {
    this.calls.push("cards");
    if (this.behavior.cards) return this.behavior.cards(input);
    const citationId = input.allowedCitationIds[0] ?? "missing";
    return [card(citationId)];
  }
}

function card(citationId: string): TacticCardContent {
  return {
    situation: "압박을 받는 상황",
    conditions: ["전방 압박"],
    defenseType: "front_press",
    cues: ["측면 공간"],
    preferred: [{ action: "pass", reason: "압박 회피", citationIds: [citationId] }],
    alternatives: [],
    risky: [],
    confidence: "high",
    uncertainties: [],
    conflicts: [],
    scenarioSuitable: true,
    animationSuitable: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function seedBundle(database: SQLiteD1Database, id = "bundle-1", contentVersion = "input-1"): void {
  database.run(
    "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    id, "드리블 대응", "전방 압박 대응", 1, contentVersion, 1, 1,
  );
}

function seedSource(
  database: SQLiteD1Database,
  files: MemoryFiles,
  input: { id: string; bundleId?: string; failed?: boolean; text?: string },
): void {
  const bundleId = input.bundleId ?? "bundle-1";
  const failed = input.failed ?? false;
  const originalKey = `${input.id}-original`;
  const extractedKey = failed ? null : `${input.id}-extracted`;
  files.objects.set(originalKey, new TextEncoder().encode(input.text ?? "압박 대응"));
  if (extractedKey) {
    files.objects.set(extractedKey, JSON.stringify([{ locator: "paragraph:1", text: input.text ?? "압박 대응" }]));
  }
  database.run(
    `INSERT INTO evidence_sources
      (id,bundle_id,original_file_name,media_type,byte_size,content_hash,storage_key,extracted_text_key,extraction_status,extraction_error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id, bundleId, `${input.id}.md`, "text/markdown", 12, `${input.id}-hash`, originalKey, extractedKey,
    failed ? "failed" : "completed", failed ? "스캔 PDF는 OCR을 지원하지 않습니다." : null, 1, 1,
  );
}

function seedChunk(database: SQLiteD1Database, input: {
  id: string;
  bundleId?: string;
  inputVersion?: string;
  sourceId: string;
}): void {
  database.run(
    `INSERT INTO evidence_chunks
      (id,bundle_id,input_version,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    input.id, input.bundleId ?? "bundle-1", input.inputVersion ?? "input-1", input.sourceId,
    null, 0, "paragraph:1", "압박 대응", `${input.id}-hash`, 1,
  );
}

function seedJob(database: SQLiteD1Database, input: {
  id?: string;
  bundleId?: string;
  inputVersion?: string;
  status?: EvidenceAnalysisJobRecord["status"];
  stage?: EvidenceAnalysisJobRecord["stage"];
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  attemptCount?: number;
  extractedEvidenceJson?: string | null;
  generatedCardsJson?: string | null;
} = {}): void {
  database.run(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,lease_owner,lease_token,lease_expires_at,
       error_message,attempt_count,extracted_evidence_json,generated_cards_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id ?? "job-1", input.bundleId ?? "bundle-1", input.inputVersion ?? "input-1", input.status ?? "queued",
    settings.analyzerModel, settings.promptVersion, settings.schemaVersion, input.stage ?? "validate_sources",
    input.leaseOwner ?? null, null, input.leaseExpiresAt ?? null, null, input.attemptCount ?? 0,
    input.extractedEvidenceJson ?? null, input.generatedCardsJson ?? null, 0, 1, 1,
  );
}

function createContext(input: {
  analyzer?: RecordingAnalyzer;
  now?: () => number;
  runnerId?: string;
} = {}) {
  const database = new SQLiteD1Database();
  const files = new MemoryFiles();
  const analyzer = input.analyzer ?? new RecordingAnalyzer();
  const scheduled: Promise<unknown>[] = [];
  const stagesAtSchedule: string[] = [];
  let id = 0;
  const jobs = new EvidenceAnalysisJobs({
    db: database,
    files,
    analyzer,
    settings,
    runnerId: input.runnerId ?? "runner-1",
    now: input.now ?? (() => 100_000),
    newId: () => `generated-${++id}`,
    schedule(promise) {
      stagesAtSchedule.push(database.first<{ stage: string }>("SELECT stage FROM evidence_analysis_jobs ORDER BY created_at LIMIT 1").stage);
      scheduled.push(promise);
    },
  });
  return { analyzer, database, files, jobs, scheduled, stagesAtSchedule };
}

async function drainScheduled(scheduled: Promise<unknown>[]): Promise<void> {
  for (let index = 0; index < scheduled.length; index += 1) await scheduled[index];
}

test("migration preserves legacy resume progress while adding durable checkpoints", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync("drizzle").filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort();
  for (const name of migrations.slice(0, -1)) database.exec(readFileSync(`drizzle/${name}`, "utf8"));
  database.prepare(
    "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("legacy-bundle", "Legacy", "Resume", 1, "legacy-input", 1, 1);
  database.prepare(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,lease_owner,lease_expires_at,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "legacy-job", "legacy-bundle", "legacy-input", "running", "model-1", "prompt-1", "schema-1",
    "chunks_ready", "dead-runner", 10, 0, 1, 1,
  );
  database.prepare(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,lease_owner,lease_expires_at,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "legacy-generated", "legacy-bundle", "legacy-generated-input", "running", "model-1", "prompt-1", "schema-1",
    "cards_generated", "dead-runner", 10, 0, 1, 1,
  );

  database.exec(readFileSync(`drizzle/${migrations.at(-1)}`, "utf8"));

  assert.deepEqual({ ...database.prepare(
    `SELECT stage,attempt_count AS attemptCount,extracted_evidence_json AS extractedEvidenceJson,
      generated_cards_json AS generatedCardsJson FROM evidence_analysis_jobs WHERE id='legacy-job'`,
  ).get() }, {
    stage: "extract_evidence",
    attemptCount: 0,
    extractedEvidenceJson: null,
    generatedCardsJson: null,
  });
  assert.equal(database.prepare(
    "SELECT stage FROM evidence_analysis_jobs WHERE id='legacy-generated'",
  ).get()?.stage, "extract_evidence");
});

test("same input version deduplicates analysis jobs", async () => {
  const context = createContext();
  seedBundle(context.database);

  const first = await context.jobs.startAnalysis("bundle-1", admin);
  const second = await context.jobs.startAnalysis("bundle-1", admin);

  assert.equal(second.id, first.id);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_analysis_jobs").count, 1);
  await drainScheduled(context.scheduled);
});

test("identical input versions in different bundles create bundle-owned jobs", async () => {
  const context = createContext();
  seedBundle(context.database, "bundle-1", "shared-input");
  seedBundle(context.database, "bundle-2", "shared-input");

  const first = await context.jobs.startAnalysis("bundle-1", admin);
  const second = await context.jobs.startAnalysis("bundle-2", admin);

  assert.notEqual(second.id, first.id);
  assert.equal(first.bundleId, "bundle-1");
  assert.equal(second.bundleId, "bundle-2");
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_analysis_jobs").count, 2);
  await drainScheduled(context.scheduled);
});

test("expired lease resumes from its exact persisted stage and uses a 60 second CAS lease", async () => {
  let leaseAtExtraction: number | null = null;
  let leaseDatabase: SQLiteD1Database | null = null;
  const analyzer = new RecordingAnalyzer({
    extract: async (input) => {
      leaseAtExtraction = leaseDatabase?.first<{ lease: number }>(
        "SELECT lease_expires_at AS lease FROM evidence_analysis_jobs WHERE id='job-1'",
      ).lease ?? null;
      const citationId = input.chunks[0]?.id ?? "missing";
      return [{
        citationIds: [citationId], situation: "상황", conditions: [], cues: [],
        actions: [{ action: "pass", reason: "이유", citationIds: [citationId] }], outcomes: [], exceptions: [],
      }];
    },
  });
  const context = createContext({ analyzer, now: () => 100_000 });
  leaseDatabase = context.database;
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
  seedJob(context.database, { stage: "extract_evidence", status: "running", leaseOwner: "dead-runner", leaseExpiresAt: 99_999 });

  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  assert.deepEqual(context.analyzer.calls, ["extract", "cards"]);
  assert.equal(leaseAtExtraction, 160_000);
  assert.deepEqual(context.stagesAtSchedule, ["generate_cards", "persist_cards", "done"]);
  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, "review_ready");
  assert.deepEqual({ ...context.database.first(
    `SELECT card.bundle_id AS bundleId,card.bundle_version AS bundleVersion,citation.chunk_id AS chunkId
      FROM tactic_cards AS card JOIN tactic_card_citations AS citation ON citation.card_id=card.id`,
  ) }, { bundleId: "bundle-1", bundleVersion: "input-1", chunkId: "chunk-1" });
});

test("an unexpired lease owned by another runner blocks execution", async () => {
  const context = createContext({ now: () => 100_000 });
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
  seedJob(context.database, { stage: "extract_evidence", status: "running", leaseOwner: "runner-2", leaseExpiresAt: 160_001 });

  await context.jobs.runAnalysisStep("job-1");

  assert.deepEqual(context.analyzer.calls, []);
  assert.equal(context.scheduled.length, 0);
  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.stage, "extract_evidence");
});

test("one runner cannot execute the same leased stage concurrently", async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  let calls = 0;
  const analyzer = new RecordingAnalyzer({
    extract: async (input) => {
      calls += 1;
      started.resolve();
      await gate.promise;
      const citationId = input.chunks[0]?.id ?? "missing";
      return [{
        citationIds: [citationId], situation: "상황", conditions: [], cues: [],
        actions: [{ action: "pass", reason: "이유", citationIds: [citationId] }], outcomes: [], exceptions: [],
      }];
    },
  });
  const context = createContext({ analyzer });
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
  seedJob(context.database, { stage: "extract_evidence" });

  const first = context.jobs.runAnalysisStep("job-1");
  await started.promise;
  const second = context.jobs.runAnalysisStep("job-1");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  gate.resolve();
  await Promise.all([first, second]);
  await drainScheduled(context.scheduled);
});

test("every statement in one checkpoint batch shares the same lease boundary", async () => {
  const times = [100_000, 159_999, 159_999, 160_000];
  const context = createContext({ now: () => times.shift() ?? 160_000 });
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedJob(context.database, { stage: "extract_text" });

  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_chunks").count, 1);
  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, "review_ready");
});

test("partial text extraction failure preserves successful source chunks and failure details", async () => {
  const context = createContext();
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "ok" });
  seedSource(context.database, context.files, { id: "bad", failed: true });
  seedJob(context.database, { stage: "extract_text" });

  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  assert.deepEqual(context.database.all<Record<string, unknown>>(
    "SELECT id,extraction_status AS status,extraction_error AS error FROM evidence_sources ORDER BY id",
  ).map((row) => ({ ...row })), [
    { id: "bad", status: "failed", error: "스캔 PDF는 OCR을 지원하지 않습니다." },
    { id: "ok", status: "completed", error: null },
  ]);
  assert.deepEqual(context.database.all<Record<string, unknown>>(
    "SELECT source_id AS sourceId,location_label AS locationLabel FROM evidence_chunks",
  ).map((row) => ({ ...row })), [
    { sourceId: "ok", locationLabel: "paragraph:1" },
  ]);
  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, "review_ready");
});

test("chunks are scoped to one input version and failed sources cannot leak old chunks", async () => {
  const seenInputs: string[][] = [];
  const analyzer = new RecordingAnalyzer({
    extract: async (input) => {
      seenInputs.push(input.chunks.map((chunk) => chunk.id));
      if (input.chunks.length === 0) throw new EvidenceAnalyzerError("no current chunks", false);
      const citationId = input.chunks[0]!.id;
      return [{
        citationIds: [citationId], situation: "상황", conditions: [], cues: [],
        actions: [{ action: "pass", reason: "이유", citationIds: [citationId] }], outcomes: [], exceptions: [],
      }];
    },
  });
  const context = createContext({ analyzer });
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedJob(context.database, { stage: "extract_text" });
  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  context.database.run("UPDATE evidence_bundles SET content_version='input-2' WHERE id='bundle-1'");
  seedJob(context.database, { id: "job-2", inputVersion: "input-2", stage: "extract_text" });
  await context.jobs.runAnalysisStep("job-2");
  await drainScheduled(context.scheduled);
  assert.deepEqual(context.database.all<Record<string, unknown>>(
    "SELECT input_version AS inputVersion,count(*) AS count FROM evidence_chunks GROUP BY input_version ORDER BY input_version",
  ).map((row) => ({ ...row })), [
    { inputVersion: "input-1", count: 1 },
    { inputVersion: "input-2", count: 1 },
  ]);

  context.database.run(
    "UPDATE evidence_sources SET extraction_status='failed',extraction_error='later failure' WHERE id='source-1'",
  );
  context.database.run("UPDATE evidence_bundles SET content_version='input-3' WHERE id='bundle-1'");
  seedJob(context.database, { id: "job-3", inputVersion: "input-3", stage: "extract_evidence" });
  await context.jobs.runAnalysisStep("job-3");

  assert.deepEqual(seenInputs.at(-1), []);
});

test("retryable and malformed analyzer output gets at most three persisted attempts", async () => {
  for (const malformed of [false, true]) {
    let calls = 0;
    const analyzer = new RecordingAnalyzer({
      extract: async () => {
        calls += 1;
        if (malformed) return [{ unexpected: true }] as unknown as ExtractedEvidence[];
        throw new EvidenceAnalyzerError("temporary", true);
      },
    });
    const context = createContext({ analyzer });
    seedBundle(context.database);
    seedSource(context.database, context.files, { id: "source-1" });
    seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
    seedJob(context.database, { stage: "extract_evidence" });

    await context.jobs.runAnalysisStep("job-1");
    await drainScheduled(context.scheduled);

    const job = await context.jobs.getAnalysisStatus("job-1");
    assert.equal(calls, 3);
    assert.equal(job?.attemptCount, 3);
    assert.equal(job?.status, "failed");
    assert.equal(job?.stage, "extract_evidence");
  }
});

test("terminal configuration errors fail immediately", async () => {
  let calls = 0;
  const context = createContext({
    analyzer: new RecordingAnalyzer({
      extract: async () => {
        calls += 1;
        throw new EvidenceAnalyzerError("configuration missing", false);
      },
    }),
  });
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
  seedJob(context.database, { stage: "extract_evidence" });

  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  assert.equal(calls, 1);
  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, "failed");
});

test("explicit retry resumes a failed job from its last incomplete stage", async () => {
  let calls = 0;
  const context = createContext({
    analyzer: new RecordingAnalyzer({
      extract: async (input) => {
        calls += 1;
        if (calls === 1) throw new EvidenceAnalyzerError("configuration missing", false);
        const citationId = input.chunks[0]?.id ?? "missing";
        return [{
          citationIds: [citationId], situation: "상황", conditions: [], cues: [],
          actions: [{ action: "pass", reason: "이유", citationIds: [citationId] }], outcomes: [], exceptions: [],
        }];
      },
    }),
  });
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
  seedJob(context.database, { stage: "extract_evidence" });
  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  await context.jobs.retryAnalysis("job-1", admin);
  await drainScheduled(context.scheduled);

  assert.equal(calls, 2);
  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, "review_ready");
});

test("status polling is read-only and never schedules execution", async () => {
  const context = createContext();
  seedBundle(context.database);
  seedJob(context.database, { stage: "validate_sources" });

  const before = context.database.first<{ updatedAt: number }>("SELECT updated_at AS updatedAt FROM evidence_analysis_jobs WHERE id='job-1'");
  const status = await context.jobs.getAnalysisStatus("job-1");
  const after = context.database.first<{ updatedAt: number }>("SELECT updated_at AS updatedAt FROM evidence_analysis_jobs WHERE id='job-1'");

  assert.equal(status?.stage, "validate_sources");
  assert.deepEqual(after, before);
  assert.equal(context.scheduled.length, 0);
});

test("a stale bundle version cannot persist generated cards", async () => {
  const context = createContext();
  seedBundle(context.database, "bundle-1", "input-2");
  seedSource(context.database, context.files, { id: "source-1" });
  seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
  seedJob(context.database, {
    inputVersion: "input-1",
    stage: "persist_cards",
    extractedEvidenceJson: JSON.stringify([{
      citationIds: ["chunk-1"], situation: "상황", conditions: [], cues: [],
      actions: [{ action: "pass", reason: "이유", citationIds: ["chunk-1"] }], outcomes: [], exceptions: [],
    }]),
    generatedCardsJson: JSON.stringify([card("chunk-1")]),
  });

  await context.jobs.runAnalysisStep("job-1");

  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM tactic_cards").count, 0);
  assert.deepEqual(
    { ...(await context.jobs.getAnalysisStatus("job-1")) },
    { ...(await context.jobs.getAnalysisStatus("job-1")), status: "failed", isStale: true },
  );
});

test("card citations are rejected unless they belong to the job bundle and extracted provenance", async () => {
  const context = createContext({
    analyzer: new RecordingAnalyzer({ cards: async () => [card("foreign-chunk")] }),
  });
  seedBundle(context.database);
  seedSource(context.database, context.files, { id: "source-1" });
  seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
  seedJob(context.database, {
    stage: "generate_cards",
    extractedEvidenceJson: JSON.stringify([{
      citationIds: ["chunk-1"], situation: "상황", conditions: [], cues: [],
      actions: [{ action: "pass", reason: "이유", citationIds: ["chunk-1"] }], outcomes: [], exceptions: [],
    }]),
  });

  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  assert.equal(context.analyzer.calls.filter((call) => call === "cards").length, 3);
  assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM tactic_cards").count, 0);
  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, "failed");
});
