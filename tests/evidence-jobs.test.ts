import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { computeEvidenceVersion, type TacticCardContent } from "../lib/domain/evidence.ts";
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

function applyMigrationsBefore(database: DatabaseSync, targetPrefix: string): string {
  const migrations = readdirSync("drizzle").filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort();
  const targetIndex = migrations.findIndex((name) => name.startsWith(targetPrefix));
  assert.notEqual(targetIndex, -1, `Expected migration ${targetPrefix}`);
  for (const name of migrations.slice(0, targetIndex)) database.exec(readFileSync(`drizzle/${name}`, "utf8"));
  return migrations[targetIndex];
}

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
  readonly database: DatabaseSync;

  constructor(database = new DatabaseSync(":memory:"), applyMigrations = true) {
    this.database = database;
    this.database.exec("PRAGMA foreign_keys = ON");
    if (applyMigrations) {
      for (const name of readdirSync("drizzle").filter((value) => /^\d{4}_.*\.sql$/.test(value)).sort()) {
        this.database.exec(readFileSync(`drizzle/${name}`, "utf8"));
      }
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

class AcquisitionFailingDatabase extends SQLiteD1Database {
  override prepare(query: string): EvidenceD1Statement {
    const statement = super.prepare(query);
    if (!query.includes("SET lease_owner=?,lease_token=?,lease_expires_at=?")) return statement;
    let bound: EvidenceD1Statement = statement;
    return {
      bind(...values: unknown[]): EvidenceD1Statement {
        bound = statement.bind(...values);
        return this;
      },
      first<T>(): Promise<T | null> {
        return bound.first<T>();
      },
      all<T>(): Promise<{ results: T[] }> {
        return bound.all<T>();
      },
      async run(): Promise<{ meta: { changes: number } }> {
        throw new Error("simulated acquisition failure");
      },
    };
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
  readonly calls: string[] = [];

  constructor(
    private readonly behavior: AnalyzerBehavior = {},
    readonly modelId = settings.analyzerModel,
  ) {}

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

const CHUNK_BYTES = 256 * 1024;
const CHECKPOINT_BYTES = 700 * 1024;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function extractedWithSerializedBytes(citationId: string, targetBytes: number): ExtractedEvidence[] {
  const result: ExtractedEvidence[] = [{
    citationIds: [citationId], situation: "x", conditions: [], cues: [],
    actions: [{ action: "pass", reason: "이유", citationIds: [citationId] }], outcomes: [], exceptions: [],
  }];
  const missing = targetBytes - utf8Bytes(JSON.stringify(result));
  assert.ok(missing >= 0);
  result[0]!.situation += "x".repeat(missing);
  assert.equal(utf8Bytes(JSON.stringify(result)), targetBytes);
  return result;
}

function cardWithSerializedBytes(citationId: string, targetBytes: number): TacticCardContent {
  const result = card(citationId);
  result.uncertainties = ["x"];
  const missing = targetBytes - utf8Bytes(JSON.stringify([result]));
  assert.ok(missing >= 0);
  result.uncertainties[0] += "x".repeat(missing);
  assert.equal(utf8Bytes(JSON.stringify([result])), targetBytes);
  return result;
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
  analyzerModel?: string;
  promptVersion?: string;
  schemaVersion?: string;
} = {}): void {
  database.run(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,lease_owner,lease_token,lease_expires_at,
       error_message,attempt_count,extracted_evidence_json,generated_cards_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.id ?? "job-1", input.bundleId ?? "bundle-1", input.inputVersion ?? "input-1", input.status ?? "queued",
    input.analyzerModel ?? settings.analyzerModel, input.promptVersion ?? settings.promptVersion,
    input.schemaVersion ?? settings.schemaVersion, input.stage ?? "validate_sources",
    input.leaseOwner ?? null, null, input.leaseExpiresAt ?? null, null, input.attemptCount ?? 0,
    input.extractedEvidenceJson ?? null, input.generatedCardsJson ?? null, 0, 1, 1,
  );
}

function createContext(input: {
  analyzer?: RecordingAnalyzer;
  now?: () => number;
  runnerId?: string;
  activeSettings?: typeof settings;
  database?: SQLiteD1Database;
  schedule?: (promise: Promise<unknown>) => void;
} = {}) {
  const database = input.database ?? new SQLiteD1Database();
  const files = new MemoryFiles();
  const analyzer = input.analyzer ?? new RecordingAnalyzer();
  const scheduled: Promise<unknown>[] = [];
  const stagesAtSchedule: string[] = [];
  let id = 0;
  const jobs = new EvidenceAnalysisJobs({
    db: database,
    files,
    analyzer,
    settings: input.activeSettings ?? settings,
    runnerId: input.runnerId ?? "runner-1",
    now: input.now ?? (() => 100_000),
    newId: () => `generated-${++id}`,
    schedule(promise) {
      if (input.schedule) return input.schedule(promise);
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
  const migration = applyMigrationsBefore(database, "0007_");
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

  database.exec(readFileSync(`drizzle/${migration}`, "utf8"));

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

test("migration upgrades the exact old queued default and runs validation first", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migration = applyMigrationsBefore(database, "0007_");
  const inputVersion = await computeEvidenceVersion({
    purpose: "Resume", sourceHashes: [], clips: [], ...settings,
  });
  database.prepare(
    "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("queued-bundle", "Legacy", "Resume", 1, inputVersion, 1, 1);
  database.prepare(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,analyzer_model,prompt_version,schema_version,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("queued-job", "queued-bundle", inputVersion, "model-1", "prompt-1", "schema-1", 0, 1, 1);
  database.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  const d1 = new SQLiteD1Database(database, false);
  const scheduled: Promise<unknown>[] = [];
  const scheduledStages: string[] = [];
  const context = createContext({
    database: d1,
    schedule(promise) {
      scheduledStages.push(d1.first<{ stage: string }>(
        "SELECT stage FROM evidence_analysis_jobs WHERE id='queued-job'",
      ).stage);
      scheduled.push(promise);
    },
  });

  await context.jobs.runAnalysisStep("queued-job");
  assert.equal(scheduledStages[0], "extract_text");
  await drainScheduled(scheduled);
});

test("migration preserves durable decisions and quarantines invalid draft-only legacy output before rewind", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migration = applyMigrationsBefore(database, "0007_");
  for (const suffix of ["complete", "incomplete"]) {
    database.prepare(
      "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(`${suffix}-bundle`, suffix, "Resume", 1, `${suffix}-input`, 1, 1);
    database.prepare(
      `INSERT INTO evidence_analysis_jobs
        (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `${suffix}-job`, `${suffix}-bundle`, `${suffix}-input`, suffix === "incomplete" ? "review_ready" : "running",
      "model-1", "prompt-1", "schema-1",
      "cards_generated", 0, 1, 1,
    );
    database.prepare(
      `INSERT INTO tactic_cards
        (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `${suffix}-card`, `${suffix}-bundle`, `${suffix}-job`, `${suffix}-input`,
      suffix === "complete" ? "owner_reviewed" : "analysis_draft",
      suffix === "complete" ? '{"citationIds":["complete-chunk"]}' : "{}",
      suffix === "complete" ? '{"citationIds":["complete-chunk"]}' : "{}", 0, 1, 1,
    );
  }
  database.prepare(
    `INSERT INTO tactic_cards
      (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run("mixed-draft", "complete-bundle", "complete-job", "complete-input", "analysis_draft", "{}", "{}", 0, 1, 1);
  for (const status of ["held", "rejected"] as const) {
    database.prepare(
      "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(`${status}-bundle`, status, "Resume", 1, `${status}-input`, 1, 1);
    database.prepare(
      `INSERT INTO evidence_analysis_jobs
        (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`${status}-job`, `${status}-bundle`, `${status}-input`, "running", "model-1", "prompt-1", "schema-1", "cards_generated", 0, 1, 1);
    database.prepare(
      `INSERT INTO tactic_cards
        (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(`${status}-card`, `${status}-bundle`, `${status}-job`, `${status}-input`, status, "{}", "{}", 0, 1, 1);
  }
  database.prepare(
    `INSERT INTO evidence_sources
      (id,bundle_id,original_file_name,media_type,byte_size,content_hash,storage_key,extraction_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run("complete-source", "complete-bundle", "notes.md", "text/markdown", 1, "hash", "key", "completed", 1, 1);
  database.prepare(
    `INSERT INTO evidence_chunks
      (id,bundle_id,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("complete-chunk", "complete-bundle", "complete-source", null, 0, "p1", "evidence", "chunk-hash", 1);
  database.prepare(
    `INSERT INTO evidence_chunks
      (id,bundle_id,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("historical-only-chunk", "complete-bundle", "complete-source", null, 1, "p2", "old evidence", "old-hash", 1);
  database.prepare(
    "INSERT INTO tactic_card_citations (id,bundle_id,card_id,chunk_id,created_at) VALUES (?,?,?,?,?)",
  ).run("complete-citation", "complete-bundle", "complete-card", "complete-chunk", 1);
  database.prepare(
    `INSERT INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "historical-job", "complete-bundle", "historical-input", "running", "model-1", "prompt-1", "schema-1",
    "cards_generated", 0, 1, 1,
  );
  database.prepare(
    `INSERT INTO tactic_cards
      (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "historical-card", "complete-bundle", "historical-job", "historical-input", "coach_reviewed",
    '{"citationIds":["complete-chunk"]}', '{"citationIds":["complete-chunk"]}', 0, 1, 1,
  );
  database.prepare(
    "INSERT INTO tactic_card_citations (id,bundle_id,card_id,chunk_id,created_at) VALUES (?,?,?,?,?)",
  ).run("historical-citation", "complete-bundle", "historical-card", "complete-chunk", 1);
  database.prepare(
    `INSERT INTO tactic_card_reviews
      (id,card_id,actor_user_id,status,content_json,citation_snapshot_json,bundle_version,created_at)
      VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    "historical-review", "historical-card", "reviewer", "coach_reviewed",
    '{"citationIds":["complete-chunk"]}',
    '{"citationIds":["complete-chunk","historical-only-chunk"]}', "historical-input", 1,
  );

  database.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  assert.deepEqual({ ...database.prepare(
    "SELECT status,stage FROM evidence_analysis_jobs WHERE id='complete-job'",
  ).get() }, { status: "review_ready", stage: "done" });
  assert.equal(database.prepare("SELECT count(*) AS count FROM tactic_cards WHERE job_id='complete-job'").get()?.count, 2);
  assert.deepEqual({ ...database.prepare(
    "SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='mixed-draft'",
  ).get() }, { status: "held", isStale: 1 });
  assert.equal(database.prepare("SELECT count(*) AS count FROM tactic_card_citations WHERE card_id='complete-card'").get()?.count, 1);
  assert.equal(database.prepare(
    `SELECT count(*) AS count FROM tactic_card_citations AS citation
      JOIN tactic_cards AS card ON card.id=citation.card_id
      JOIN evidence_chunks AS chunk ON chunk.id=citation.chunk_id
      WHERE chunk.input_version<>card.bundle_version`,
  ).get()?.count, 0);
  assert.equal(database.prepare(
    "SELECT count(DISTINCT chunk_id) AS count FROM tactic_card_citations WHERE card_id IN ('complete-card','historical-card')",
  ).get()?.count, 2);
  for (const row of database.prepare(
    `SELECT card.current_content_json AS contentJson,citation.chunk_id AS chunkId
      FROM tactic_cards AS card JOIN tactic_card_citations AS citation ON citation.card_id=card.id
      WHERE card.id IN ('complete-card','historical-card')`,
  ).all() as { contentJson: string; chunkId: string }[]) {
    assert.deepEqual(JSON.parse(row.contentJson), { citationIds: [row.chunkId] });
  }
  const reviewRow = database.prepare(
    `SELECT review.content_json AS contentJson,review.citation_snapshot_json AS snapshotJson,citation.chunk_id AS chunkId
      FROM tactic_card_reviews AS review JOIN tactic_card_citations AS citation ON citation.card_id=review.card_id
      WHERE review.id='historical-review'`,
  ).get() as { contentJson: string; snapshotJson: string; chunkId: string };
  assert.deepEqual(JSON.parse(reviewRow.contentJson), { citationIds: [reviewRow.chunkId] });
  const snapshotIds = (JSON.parse(reviewRow.snapshotJson) as { citationIds: string[] }).citationIds;
  assert.equal(snapshotIds[0], reviewRow.chunkId);
  assert.equal(snapshotIds.length, 2);
  assert.equal(database.prepare(
    "SELECT input_version FROM evidence_chunks WHERE id=?",
  ).get(snapshotIds[1]!)?.input_version, "historical-input");
  assert.equal(database.prepare("SELECT count(*) AS count FROM tactic_cards WHERE job_id='incomplete-job'").get()?.count, 1);
  assert.deepEqual({ ...database.prepare(
    "SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='incomplete-card'",
  ).get() }, { status: "held", isStale: 1 });
  assert.deepEqual({ ...database.prepare(
    "SELECT status,stage FROM evidence_analysis_jobs WHERE id='incomplete-job'",
  ).get() }, { status: "queued", stage: "extract_evidence" });
  for (const status of ["held", "rejected"] as const) {
    assert.deepEqual({ ...database.prepare(
      "SELECT status,stage FROM evidence_analysis_jobs WHERE id=?",
    ).get(`${status}-job`) }, { status: "review_ready", stage: "done" });
    assert.deepEqual({ ...database.prepare(
      "SELECT status,is_stale AS isStale FROM tactic_cards WHERE id=?",
    ).get(`${status}-card`) }, { status, isStale: 0 });
  }

  const d1 = new SQLiteD1Database(database, false);
  const context = createContext({ database: d1 });
  await context.jobs.runAnalysisStep("complete-job");
  d1.run(
    `INSERT INTO evidence_sources
      (id,bundle_id,original_file_name,media_type,byte_size,content_hash,storage_key,extraction_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "incomplete-source", "incomplete-bundle", "notes.md", "text/markdown", 1, "hash", "key", "completed", 1, 1,
  );
  d1.run(
    `INSERT INTO evidence_chunks
      (id,bundle_id,input_version,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "incomplete-chunk", "incomplete-bundle", "incomplete-input", "incomplete-source", null, 0, "p1", "evidence", "hash", 1,
  );
  await context.jobs.runAnalysisStep("incomplete-job");
  await drainScheduled(context.scheduled);
  assert.equal(d1.first<{ count: number }>("SELECT count(*) AS count FROM tactic_cards WHERE job_id='complete-job'").count, 2);
  assert.equal(d1.first<{ count: number }>(
    "SELECT count(*) AS count FROM tactic_cards WHERE job_id='complete-job' AND status='owner_reviewed' AND is_stale=0",
  ).count, 1);
  assert.equal(d1.first<{ count: number }>(
    "SELECT count(*) AS count FROM tactic_cards WHERE job_id='incomplete-job' AND status='analysis_draft' AND is_stale=0",
  ).count, 1);
  assert.equal(d1.first<{ count: number }>(
    "SELECT count(*) AS count FROM tactic_cards WHERE job_id='incomplete-job' AND status='held' AND is_stale=1",
  ).count, 1);
  assert.deepEqual(context.analyzer.calls, ["extract", "cards"]);
});

test("migration rewinds done draft-only jobs and quarantines current drafts despite durable review history", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migration = applyMigrationsBefore(database, "0007_");
  const cases = [
    { id: "review-ready", status: "review_ready", review: null },
    { id: "completed", status: "completed", review: null },
    { id: "owner-history", status: "review_ready", review: "owner_reviewed" },
    { id: "held-history", status: "review_ready", review: "held" },
    { id: "rejected-history", status: "review_ready", review: "rejected" },
  ] as const;
  for (const item of cases) {
    database.prepare(
      "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(`${item.id}-bundle`, item.id, "Resume", 1, `${item.id}-input`, 1, 1);
    database.prepare(
      `INSERT INTO evidence_analysis_jobs
        (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `${item.id}-job`, `${item.id}-bundle`, `${item.id}-input`, item.status,
      "model-1", "prompt-1", "schema-1", "done", 0, 1, 1,
    );
    database.prepare(
      `INSERT INTO tactic_cards
        (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `${item.id}-card`, `${item.id}-bundle`, `${item.id}-job`, `${item.id}-input`,
      "analysis_draft", "{}", "{}", 0, 1, 1,
    );
    database.prepare(
      `INSERT INTO evidence_sources
        (id,bundle_id,original_file_name,media_type,byte_size,content_hash,storage_key,extraction_status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(`${item.id}-source`, `${item.id}-bundle`, "notes.md", "text/markdown", 1, "hash", "key", "completed", 1, 1);
    database.prepare(
      `INSERT INTO evidence_chunks
        (id,bundle_id,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(`${item.id}-chunk`, `${item.id}-bundle`, `${item.id}-source`, null, 0, "p1", "evidence", "hash", 1);
    if (item.review !== null) {
      database.prepare(
        `INSERT INTO tactic_card_reviews
          (id,card_id,actor_user_id,status,content_json,citation_snapshot_json,bundle_version,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        `${item.id}-review`, `${item.id}-card`, "reviewer", item.review, "{}", "[]", `${item.id}-input`, 1,
      );
    }
  }

  database.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  for (const item of cases) {
    assert.deepEqual({ ...database.prepare(
      "SELECT status,is_stale AS isStale FROM tactic_cards WHERE id=?",
    ).get(`${item.id}-card`) }, { status: "held", isStale: 1 });
    if (item.review === null) {
      assert.deepEqual({ ...database.prepare(
        "SELECT status,stage,completed_at AS completedAt,error_message AS errorMessage,lease_owner AS leaseOwner FROM evidence_analysis_jobs WHERE id=?",
      ).get(`${item.id}-job`) }, {
        status: "queued", stage: "extract_evidence", completedAt: null, errorMessage: null, leaseOwner: null,
      });
    } else {
      assert.deepEqual({ ...database.prepare(
        "SELECT status,stage FROM evidence_analysis_jobs WHERE id=?",
      ).get(`${item.id}-job`) }, { status: "review_ready", stage: "done" });
      assert.equal(database.prepare(
        "SELECT status FROM tactic_card_reviews WHERE id=?",
      ).get(`${item.id}-review`)?.status, item.review);
    }
  }

  const d1 = new SQLiteD1Database(database, false);
  const context = createContext({ database: d1 });
  for (const id of ["review-ready", "completed"] as const) {
    await context.jobs.runAnalysisStep(`${id}-job`);
    await drainScheduled(context.scheduled);
    assert.equal(d1.first<{ count: number }>(
      `SELECT count(*) AS count FROM tactic_cards
        WHERE job_id=? AND status='analysis_draft' AND is_stale=0`, `${id}-job`,
    ).count, 1);
    assert.equal(d1.first<{ count: number }>(
      `SELECT count(*) AS count FROM tactic_cards
        WHERE job_id=? AND status='held' AND is_stale=1`, `${id}-job`,
    ).count, 1);
  }
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

test("start recomputes a settings-derived bundle version before creating a job", async () => {
  const context = createContext();
  const oldVersion = await computeEvidenceVersion({
    purpose: "전방 압박 대응", sourceHashes: [], clips: [],
    analyzerModel: "model-old", promptVersion: "prompt-old", schemaVersion: "schema-old",
  });
  const activeVersion = await computeEvidenceVersion({
    purpose: "전방 압박 대응", sourceHashes: [], clips: [], ...settings,
  });
  seedBundle(context.database, "bundle-1", oldVersion);
  seedJob(context.database, { id: "old-job", inputVersion: oldVersion, status: "completed", stage: "done" });
  context.database.run(
    `INSERT INTO tactic_cards
      (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "old-card", "bundle-1", "old-job", oldVersion, "coach_reviewed", "{}", "{}", 0, 1, 1,
  );

  const job = await context.jobs.startAnalysis("bundle-1", admin);

  assert.equal(job.inputVersion, activeVersion);
  assert.deepEqual({ ...context.database.first(
    "SELECT content_version AS contentVersion,version FROM evidence_bundles WHERE id='bundle-1'",
  ) }, { contentVersion: activeVersion, version: 2 });
  assert.deepEqual({ ...context.database.first(
    "SELECT status,is_stale AS isStale FROM tactic_cards WHERE id='old-card'",
  ) }, { status: "held", isStale: 1 });
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

test("persisted model, prompt, and schema mismatches fail before lease acquisition or analyzer execution", async () => {
  for (const mismatch of [
    { analyzerModel: "model-old" },
    { promptVersion: "prompt-old" },
    { schemaVersion: "schema-old" },
  ]) {
    const context = createContext();
    seedBundle(context.database);
    seedSource(context.database, context.files, { id: "source-1" });
    seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
    seedJob(context.database, { stage: "extract_evidence", ...mismatch });

    await context.jobs.runAnalysisStep("job-1");

    const job = await context.jobs.getAnalysisStatus("job-1");
    assert.equal(job?.status, "failed");
    assert.equal(job?.leaseOwner, null);
    assert.match(job?.errorMessage ?? "", /설정|버전/);
    assert.deepEqual(context.analyzer.calls, []);
    assert.equal(context.database.first<{ count: number }>("SELECT count(*) AS count FROM tactic_cards").count, 0);
  }
});

test("retrying a job with incompatible active settings is a typed conflict and is not scheduled", async () => {
  const context = createContext();
  seedBundle(context.database);
  seedJob(context.database, { status: "failed", analyzerModel: "model-old" });

  await assert.rejects(
    () => context.jobs.retryAnalysis("job-1", admin),
    (error: unknown) => error instanceof Error && error.name === "EvidenceJobConfigurationConflictError",
  );

  assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, "failed");
  assert.equal(context.scheduled.length, 0);
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

test("extracted pages split deterministically at the 256 KiB UTF-8 D1 boundary", async () => {
  for (const [length, expectedChunks] of [[CHUNK_BYTES, 1], [CHUNK_BYTES + 1, 2]] as const) {
    const context = createContext();
    seedBundle(context.database);
    seedSource(context.database, context.files, { id: "source-1", text: "a".repeat(length) });
    seedJob(context.database, { stage: "extract_text" });

    await context.jobs.runAnalysisStep("job-1");
    await drainScheduled(context.scheduled);

    const chunks = context.database.all<{ ordinal: number; locationLabel: string; content: string }>(
      "SELECT ordinal,location_label AS locationLabel,content FROM evidence_chunks ORDER BY ordinal",
    );
    assert.equal(chunks.length, expectedChunks);
    assert.equal(chunks.map((chunk) => chunk.content).join(""), "a".repeat(length));
    assert.ok(chunks.every((chunk) => utf8Bytes(chunk.content) <= CHUNK_BYTES));
    assert.ok(chunks.every((chunk) => chunk.locationLabel === "paragraph:1"));
    assert.deepEqual(chunks.map((chunk) => chunk.ordinal), Array.from({ length: expectedChunks }, (_, index) => index));
  }
});

test("video observations split deterministically at the 256 KiB UTF-8 D1 boundary", async () => {
  const context = createContext();
  seedBundle(context.database);
  const observation = "축".repeat(Math.ceil((CHUNK_BYTES + 1) / 3));
  context.database.run(
    `INSERT INTO evidence_video_clips
      (id,bundle_id,url,start_ms,end_ms,observation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    "clip-1", "bundle-1", "https://example.test/video", 0, 1_000, observation, 1, 1,
  );
  seedJob(context.database, { stage: "normalize_clips" });

  await context.jobs.runAnalysisStep("job-1");
  await drainScheduled(context.scheduled);

  const chunks = context.database.all<{ ordinal: number; content: string }>(
    "SELECT ordinal,content FROM evidence_chunks WHERE video_clip_id='clip-1' ORDER BY ordinal",
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks.map((chunk) => chunk.content).join(""), observation);
  assert.ok(chunks.every((chunk) => utf8Bytes(chunk.content) <= CHUNK_BYTES));
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), [0, 1]);
});

test("extraction checkpoints enforce the exact 700 KiB row budget with bounded retry", async () => {
  for (const [bytes, expectedStatus, expectedCalls] of [
    [CHECKPOINT_BYTES, "review_ready", 1],
    [CHECKPOINT_BYTES + 1, "failed", 3],
  ] as const) {
    const analyzer = new RecordingAnalyzer({ extract: async () => extractedWithSerializedBytes("chunk-1", bytes) });
    const context = createContext({ analyzer });
    seedBundle(context.database);
    seedSource(context.database, context.files, { id: "source-1" });
    seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
    seedJob(context.database, { stage: "extract_evidence" });

    await context.jobs.runAnalysisStep("job-1");
    await drainScheduled(context.scheduled);

    const job = await context.jobs.getAnalysisStatus("job-1");
    assert.equal(job?.status, expectedStatus);
    assert.equal(analyzer.calls.filter((call) => call === "extract").length, expectedCalls);
    if (bytes === CHECKPOINT_BYTES) assert.equal(utf8Bytes(job?.extractedEvidenceJson ?? ""), CHECKPOINT_BYTES);
    else assert.equal(job?.extractedEvidenceJson, null);
  }
});

test("generated checkpoints and duplicated card columns enforce the exact 700 KiB row budget", async () => {
  const extracted = extractedWithSerializedBytes("chunk-1", 256);
  for (const [bytes, expectedStatus, expectedCalls] of [
    [CHECKPOINT_BYTES, "review_ready", 1],
    [CHECKPOINT_BYTES + 1, "failed", 3],
  ] as const) {
    const analyzer = new RecordingAnalyzer({ cards: async () => [cardWithSerializedBytes("chunk-1", bytes)] });
    const context = createContext({ analyzer });
    seedBundle(context.database);
    seedSource(context.database, context.files, { id: "source-1" });
    seedChunk(context.database, { id: "chunk-1", sourceId: "source-1" });
    seedJob(context.database, { stage: "generate_cards", extractedEvidenceJson: JSON.stringify(extracted) });

    await context.jobs.runAnalysisStep("job-1");
    await drainScheduled(context.scheduled);

    assert.equal((await context.jobs.getAnalysisStatus("job-1"))?.status, expectedStatus);
    assert.equal(analyzer.calls.filter((call) => call === "cards").length, expectedCalls);
    const rows = context.database.all<{ draft: string; current: string }>(
      "SELECT draft_content_json AS draft,current_content_json AS current FROM tactic_cards",
    );
    if (bytes === CHECKPOINT_BYTES) {
      assert.equal(rows.length, 1);
      assert.equal(utf8Bytes(rows[0]!.draft), CHECKPOINT_BYTES - 2);
      assert.equal(rows[0]!.draft, rows[0]!.current);
      assert.ok(utf8Bytes(rows[0]!.draft) + utf8Bytes(rows[0]!.current) < 2_000_000);
    } else {
      assert.equal(rows.length, 0);
    }
  }
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

test("a synchronous scheduler throw leaves a durable checkpoint and observes the continuation", async () => {
  let continuation: Promise<unknown> | null = null;
  const inputVersion = await computeEvidenceVersion({
    purpose: "테스트 목적", sourceHashes: [], clips: [], ...settings,
  });
  const context = createContext({
    schedule(promise) {
      continuation = promise;
      throw new Error("simulated scheduler failure");
    },
  });
  seedBundle(context.database, "bundle-1", inputVersion);

  await assert.rejects(context.jobs.startAnalysis("bundle-1", admin), /simulated scheduler failure/);
  assert.deepEqual({ ...context.database.first(
    "SELECT status,stage FROM evidence_analysis_jobs WHERE bundle_id='bundle-1'",
  ) }, { status: "queued", stage: "validate_sources" });

  assert.notEqual(continuation, null);
  await assert.rejects(continuation, /simulated scheduler failure/);
  const durable = context.database.first<{ status: string; stage: string }>(
    "SELECT status,stage FROM evidence_analysis_jobs WHERE bundle_id='bundle-1'",
  );
  assert.equal(durable.status, "queued");
  assert.equal(durable.stage, "validate_sources");
});

test("scheduled lease acquisition database failures reject safely without analyzer execution", async () => {
  const database = new AcquisitionFailingDatabase();
  const context = createContext({ database });
  seedBundle(database);

  const job = await context.jobs.startAnalysis("bundle-1", admin);
  assert.equal(context.scheduled.length, 1);
  await assert.rejects(context.scheduled[0], /simulated acquisition failure/);

  assert.deepEqual(context.analyzer.calls, []);
  assert.deepEqual({ ...database.first(
    "SELECT status,stage,lease_owner AS leaseOwner FROM evidence_analysis_jobs WHERE id=?", job.id,
  ) }, { status: "queued", stage: "validate_sources", leaseOwner: null });
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
