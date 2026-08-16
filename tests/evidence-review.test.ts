import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import type { ScenarioContent } from "../lib/domain/content.ts";
import type { TacticCardContent } from "../lib/domain/evidence.ts";
import type { EvidenceAdmin } from "../lib/server/evidence-auth.ts";
import {
  D1EvidenceServiceRepository,
  EvidenceConflictError,
  EvidenceService,
  type EvidenceD1Database,
  type EvidenceD1Statement,
} from "../lib/server/evidence-service.ts";

const admin: EvidenceAdmin = {
  userId: "admin-1",
  email: "admin@example.test",
  displayName: "Admin",
  fullName: "Admin User",
};

class SQLiteD1Statement implements EvidenceD1Statement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly query: string) {}

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
  beforeNextBatch: (() => void | Promise<void>) | null = null;

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

function card(overrides: Partial<TacticCardContent> = {}): TacticCardContent {
  return {
    situation: "전방 압박을 받는 빌드업",
    conditions: ["중앙 수비수가 공을 소유"],
    defenseType: "front_press",
    cues: ["압박 방향"],
    preferred: [{ action: "pass", reason: "반대편을 연다", citationIds: ["chunk-1"] }],
    alternatives: [],
    risky: [{ action: "dribble", reason: "중앙 압박에 갇힌다", citationIds: ["chunk-2"] }],
    confidence: "high",
    uncertainties: [],
    conflicts: [],
    scenarioSuitable: true,
    animationSuitable: true,
    ...overrides,
  };
}

const scenarioContent: ScenarioContent = {
  defenseType: "front_press",
  actorId: "fixo-1",
  allowedActions: ["pass", "dribble"],
  pitch: {
    players: [
      { id: "fixo-1", x: 50, y: 72, team: "us" },
      { id: "ala-left", x: 24, y: 52, team: "us" },
      { id: "defender-1", x: 50, y: 58, team: "them" },
    ],
    ball: { x: 50, y: 72 },
    zones: [{ id: "weak-side", zone: { kind: "circle", cx: 24, cy: 52, radius: 9 } }],
  },
  answer: {
    preferred: { actionType: "pass", target: { kind: "player", playerId: "ala-left" } },
    alternatives: [],
    hazards: [],
  },
  timeline: {
    durationMs: 2400,
    decisionAtMs: 1200,
    keyframes: [
      { atMs: 0, players: {}, ball: { x: 50, y: 72 } },
      { atMs: 1200, players: { "defender-1": { x: 50, y: 65 } }, ball: { x: 50, y: 72 } },
      { atMs: 2400, players: {}, ball: { x: 24, y: 52 } },
    ],
  },
  explanations: [
    { kind: "observe", text: "압박 방향", fromMs: 0, toMs: 800, highlights: [{ kind: "player", id: "defender-1" }] },
    { kind: "benefit", text: "반대편 활용", fromMs: 800, toMs: 1600, highlights: [{ kind: "player", id: "ala-left" }] },
    { kind: "risk", text: "중앙 위험", fromMs: 800, toMs: 1600, highlights: [{ kind: "path", id: "selected-path" }] },
    { kind: "remember", text: "반대편 먼저", fromMs: 1600, toMs: 2400, highlights: [{ kind: "zone", id: "weak-side" }] },
  ],
  review: { sourceReviewed: true, timelineReviewed: true, explanationsReviewed: true },
};

const draftInput = {
  expectedUpdatedAt: 100,
  campaignId: "diamond-121-intro",
  role: "ala" as const,
  principle: "width" as const,
  prompt: "압박 반대편을 찾으세요.",
  hint: "수비수의 몸 방향을 보세요.",
  explanation: "반대편 패스로 압박을 벗어납니다.",
  orderIndex: 99,
  content: scenarioContent,
};

function createContext() {
  const database = new SQLiteD1Database();
  const repository = new D1EvidenceServiceRepository(database);
  let generatedId = 0;
  let now = 1_000;
  const service = new EvidenceService({
    repository,
    settings: { analyzerModel: "model-1", promptVersion: "prompt-1", schemaVersion: "schema-1" },
    now: () => ++now,
    newId: () => `generated-${++generatedId}`,
  });
  return { database, service };
}

function seedCard(
  database: SQLiteD1Database,
  options: {
    id?: string;
    status?: "analysis_draft" | "owner_reviewed" | "coach_reviewed" | "held" | "rejected";
    content?: TacticCardContent;
    stale?: boolean;
    updatedAt?: number;
    bundleVersion?: string;
  } = {},
): void {
  const id = options.id ?? "card-1";
  const content = options.content ?? card();
  const bundleVersion = options.bundleVersion ?? "bundle-v1";
  database.run(
    "INSERT OR IGNORE INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    "bundle-1", "근거 묶음", "전방 압박", 1, "bundle-v1", 1, 1,
  );
  database.run(
    `INSERT OR IGNORE INTO evidence_sources
      (id,bundle_id,original_file_name,media_type,byte_size,content_hash,storage_key,extraction_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "source-1", "bundle-1", "pressing.md", "text/markdown", 10, "source-hash", "source-key", "completed", 1, 1,
  );
  database.run(
    `INSERT OR IGNORE INTO evidence_video_clips
      (id,bundle_id,url,start_ms,end_ms,observation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    "clip-1", "bundle-1", "https://example.test/press", 0, 1000, "압박 방향", 1, 1,
  );
  database.run(
    `INSERT OR IGNORE INTO evidence_analysis_jobs
      (id,bundle_id,input_version,status,analyzer_model,prompt_version,schema_version,stage,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    "job-1", "bundle-1", "bundle-v1", "review_ready", "model-1", "prompt-1", "schema-1", "done", 0, 1, 1,
  );
  database.run(
    `INSERT INTO tactic_cards
      (id,bundle_id,job_id,bundle_version,status,draft_content_json,current_content_json,is_stale,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, "bundle-1", "job-1", bundleVersion, options.status ?? "analysis_draft",
    JSON.stringify(content), JSON.stringify(content), options.stale ? 1 : 0, 1, options.updatedAt ?? 100,
  );
  database.run(
    `INSERT OR IGNORE INTO evidence_chunks
      (id,bundle_id,input_version,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "chunk-1", "bundle-1", "bundle-v1", "source-1", null, 0, "p.1", "반대편 패스", "chunk-hash-1", 1,
  );
  database.run(
    `INSERT OR IGNORE INTO evidence_chunks
      (id,bundle_id,input_version,source_id,video_clip_id,ordinal,location_label,content,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "chunk-2", "bundle-1", "bundle-v1", null, "clip-1", 0, "0-1000ms", "중앙 드리블 위험", "chunk-hash-2", 1,
  );
  for (const chunkId of ["chunk-1", "chunk-2"]) {
    database.run(
      "INSERT INTO tactic_card_citations (id,bundle_id,card_id,chunk_id,created_at) VALUES (?,?,?,?,?)",
      `${id}-${chunkId}`, "bundle-1", id, chunkId, 1,
    );
  }
}

test("owner edits retain the untouched LLM draft and exact immutable review snapshots", async () => {
  const { database, service } = createContext();
  seedCard(database);
  const edited = card({
    situation: "운영자가 다듬은 전방 압박 상황",
    risky: [],
  });

  const reviewed = await service.reviewCard("card-1", {
    status: "owner_reviewed",
    content: edited,
    expectedUpdatedAt: 100,
  }, admin);

  assert.equal(reviewed.status, "owner_reviewed");
  assert.equal(reviewed.updatedAt, 1001);
  const versions = database.all<{
    status: string;
    actorUserId: string;
    contentJson: string;
    citationSnapshotJson: string;
    bundleVersion: string;
    createdAt: number;
  }>(`SELECT status,actor_user_id AS actorUserId,content_json AS contentJson,
      citation_snapshot_json AS citationSnapshotJson,bundle_version AS bundleVersion,created_at AS createdAt
      FROM tactic_card_reviews WHERE card_id='card-1' ORDER BY rowid`);
  assert.deepEqual(versions.map((version) => version.status), ["analysis_draft", "owner_reviewed"]);
  assert.deepEqual(JSON.parse(versions[0].contentJson), card());
  assert.deepEqual(JSON.parse(versions[1].contentJson), edited);
  assert.deepEqual(JSON.parse(versions[1].citationSnapshotJson), [{
    chunkId: "chunk-1",
    sourceId: "source-1",
    videoClipId: null,
    locationLabel: "p.1",
    content: "반대편 패스",
    contentHash: "chunk-hash-1",
  }]);
  assert.deepEqual(versions.map(({ actorUserId, bundleVersion, createdAt }) => ({ actorUserId, bundleVersion, createdAt })), [
    { actorUserId: "admin-1", bundleVersion: "bundle-v1", createdAt: 1001 },
    { actorUserId: "admin-1", bundleVersion: "bundle-v1", createdAt: 1001 },
  ]);
  assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events WHERE action='card.reviewed'").count, 1);
});

test("every subsequent owner edit appends a snapshot without rewriting history", async () => {
  const { database, service } = createContext();
  seedCard(database);
  const first = await service.reviewCard("card-1", {
    status: "owner_reviewed",
    content: card({ situation: "첫 수정" }),
    expectedUpdatedAt: 100,
  }, admin);

  await service.reviewCard("card-1", {
    status: "owner_reviewed",
    content: card({ situation: "두 번째 수정" }),
    expectedUpdatedAt: first.updatedAt,
  }, admin);

  const versions = database.all<{ contentJson: string }>(
    "SELECT content_json AS contentJson FROM tactic_card_reviews WHERE card_id='card-1' ORDER BY rowid",
  );
  assert.deepEqual(versions.map(({ contentJson }) => JSON.parse(contentJson).situation), [
    "전방 압박을 받는 빌드업",
    "첫 수정",
    "두 번째 수정",
  ]);
});

test("review CAS loss stores no card, version, or audit changes", async () => {
  const { database, service } = createContext();
  seedCard(database);
  database.beforeNextBatch = () => {
    database.run("UPDATE tactic_cards SET updated_at=777 WHERE id='card-1'");
  };

  await assert.rejects(() => service.reviewCard("card-1", {
    status: "owner_reviewed",
    content: card({ situation: "잃어버린 수정" }),
    expectedUpdatedAt: 100,
  }, admin), EvidenceConflictError);

  assert.equal(database.first<{ updatedAt: number }>("SELECT updated_at AS updatedAt FROM tactic_cards WHERE id='card-1'").updatedAt, 777);
  assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM tactic_card_reviews").count, 0);
  assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events").count, 0);
});

test("approval blocks low confidence, conflicts, bad citations, and stale bundle versions", async () => {
  for (const [name, options, edited] of [
    ["low", {}, card({ confidence: "low" })],
    ["conflict", {}, card({ conflicts: ["자료 충돌"] })],
    ["citation", {}, card({ preferred: [{ action: "pass", reason: "이유", citationIds: ["unknown"] }] })],
    ["stale", { stale: true }, card()],
    ["version", { bundleVersion: "old-version" }, card()],
  ] as const) {
    const { database, service } = createContext();
    seedCard(database, options);
    await assert.rejects(
      () => service.reviewCard("card-1", { status: "owner_reviewed", content: edited, expectedUpdatedAt: 100 }, admin),
      name === "stale" || name === "version" ? /오래된/ : /승인|근거/,
    );
    assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM tactic_card_reviews").count, 0);
  }
});

test("held and rejected decisions remain reviewable but cannot create scenarios", async () => {
  for (const status of ["held", "rejected"] as const) {
    const { database, service } = createContext();
    seedCard(database);
    const reviewed = await service.reviewCard("card-1", { status, content: card({ confidence: "low" }), expectedUpdatedAt: 100 }, admin);
    assert.equal(reviewed.status, status);
    await assert.rejects(
      () => service.createScenarioDraft("card-1", { ...draftInput, expectedUpdatedAt: reviewed.updatedAt }, admin),
      /승인/,
    );
  }
});

test("a current approved suitable card creates only one unpublished draft with exact provenance", async () => {
  const { database, service } = createContext();
  seedCard(database);
  const reviewed = await service.reviewCard("card-1", {
    status: "owner_reviewed",
    content: card({ risky: [] }),
    expectedUpdatedAt: 100,
  }, admin);

  const first = await service.createScenarioDraft("card-1", { ...draftInput, expectedUpdatedAt: reviewed.updatedAt }, admin);
  const second = await service.createScenarioDraft("card-1", { ...draftInput, expectedUpdatedAt: reviewed.updatedAt }, admin);

  assert.equal(second.id, first.id);
  assert.equal(first.reviewStatus, "draft");
  assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM scenarios WHERE id=?", first.id).count, 1);
  const persisted = database.first<{
    contentJson: string;
    reviewStatus: string;
    reviewedContentJson: string | null;
    reviewerName: string | null;
    reviewedAt: number | null;
  }>(`SELECT content_json AS contentJson,review_status AS reviewStatus,
      reviewed_content_json AS reviewedContentJson,reviewer_name AS reviewerName,reviewed_at AS reviewedAt
      FROM scenarios WHERE id=?`, first.id);
  assert.deepEqual(JSON.parse(persisted.contentJson).review, {
    sourceReviewed: false,
    timelineReviewed: false,
    explanationsReviewed: false,
  });
  assert.deepEqual({
    reviewStatus: persisted.reviewStatus,
    reviewedContentJson: persisted.reviewedContentJson,
    reviewerName: persisted.reviewerName,
    reviewedAt: persisted.reviewedAt,
  }, { reviewStatus: "draft", reviewedContentJson: null, reviewerName: null, reviewedAt: null });
  assert.deepEqual(
    database.all<{ sourceId: string }>("SELECT source_id AS sourceId FROM scenario_evidence_sources WHERE scenario_id=?", first.id)
      .map((row) => ({ ...row })),
    [{ sourceId: "source-1" }],
  );
  const provenance = database.first<{ cardId: string; reviewId: string }>(
    "SELECT card_id AS cardId,card_review_id AS reviewId FROM scenario_tactic_card_reviews WHERE scenario_id=?",
    first.id,
  );
  assert.equal(provenance.cardId, "card-1");
  assert.match(provenance.reviewId, /^generated-/);
  assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM scenarios WHERE review_status='reviewed' AND id=?", first.id).count, 0);
  assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM evidence_audit_events WHERE action='scenario.draft_created'").count, 1);
});

test("scenario conversion blocks stale, unsuitable, and citation provenance mismatches", async () => {
  for (const [name, reviewedCard, mutation, message] of [
    ["scenario", card({ scenarioSuitable: false }), null, /적합/],
    ["animation", card({ animationSuitable: false }), null, /적합/],
    ["stale", card(), "UPDATE tactic_cards SET is_stale=1 WHERE id='card-1'", /오래된/],
    ["bundle", card(), "UPDATE evidence_bundles SET content_version='bundle-v2' WHERE id='bundle-1'", /오래된/],
    ["citation", card(), "DELETE FROM tactic_card_citations WHERE card_id='card-1' AND chunk_id='chunk-1'", /근거/],
  ] as const) {
    const { database, service } = createContext();
    seedCard(database);
    const reviewed = await service.reviewCard("card-1", {
      status: "owner_reviewed",
      content: reviewedCard,
      expectedUpdatedAt: 100,
    }, admin);
    if (mutation) database.run(mutation);
    await assert.rejects(
      () => service.createScenarioDraft("card-1", { ...draftInput, expectedUpdatedAt: reviewed.updatedAt }, admin),
      message,
      name,
    );
    assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM scenarios WHERE id LIKE 'generated-%'").count, 0);
  }
});

test("a competing conversion of the same immutable review wins idempotently", async () => {
  const { database, service } = createContext();
  seedCard(database);
  const reviewed = await service.reviewCard("card-1", {
    status: "owner_reviewed",
    content: card({ risky: [] }),
    expectedUpdatedAt: 100,
  }, admin);
  const reviewId = database.first<{ id: string }>(
    "SELECT id FROM tactic_card_reviews WHERE card_id='card-1' AND status='owner_reviewed'",
  ).id;
  database.beforeNextBatch = () => {
    database.run(
      `INSERT INTO scenarios
        (id,campaign_id,role,principle,prompt,hint,explanation,pitch_json,answer_json,content_json,review_status,order_index)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      "winner-scenario", draftInput.campaignId, draftInput.role, draftInput.principle, draftInput.prompt,
      draftInput.hint, draftInput.explanation, JSON.stringify(scenarioContent.pitch), JSON.stringify(scenarioContent.answer),
      JSON.stringify({ ...scenarioContent, review: { sourceReviewed: false, timelineReviewed: false, explanationsReviewed: false } }),
      "draft", draftInput.orderIndex,
    );
    database.run(
      "INSERT INTO scenario_tactic_card_reviews (scenario_id,card_id,card_review_id,created_at) VALUES (?,?,?,?)",
      "winner-scenario", "card-1", reviewId, 999,
    );
  };

  const result = await service.createScenarioDraft("card-1", { ...draftInput, expectedUpdatedAt: reviewed.updatedAt }, admin);

  assert.equal(result.id, "winner-scenario");
  assert.equal(database.first<{ count: number }>("SELECT count(*) AS count FROM scenario_tactic_card_reviews WHERE card_review_id=?", reviewId).count, 1);
});
