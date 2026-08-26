import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCardReviewTransition,
  computeEvidenceVersion,
  parseBundleInput,
  parseSpatialEvidenceJson,
  parseTacticCardContent,
  parseVideoClip,
  type TacticCardContent,
} from "../lib/domain/evidence.ts";

const spatialEvidence = {
  source: { title: "전방 압박", url: "https://coach.example/video", startTime: "00:00:10.000", endTime: "00:00:20.000", coachName: "코치" },
  coordinateSystem: { width: 100, height: 136, attackDirection: "negative_y", normalized: true },
  scene: {
    title: "픽소의 판단", decisionTime: "00:00:14.000", userRole: "fixo", ballOwnerId: "F1",
    defense: { primaryType: "front_press", description: "D1이 중앙을 막으며 압박" },
    players: [
      { id: "F1", team: "attack", role: "fixo", position: { x: 50, y: 108 }, hasBall: true, confidence: "estimated" },
      { id: "A2", team: "attack", role: "ala", position: { x: 78, y: 80 }, hasBall: false, confidence: "estimated" },
      { id: "D1", team: "defense", role: "defender", position: { x: 50, y: 92 }, hasBall: false, confidence: "estimated" },
    ],
    openSpaces: [{ id: "RIGHT", xMin: 70, xMax: 88, yMin: 88, yMax: 104 }],
    decisionCues: ["D1의 몸 방향", "오른쪽 공간"],
    preferredSequence: [
      { order: 1, type: "dribble", actorId: "F1", path: [{ x: 50, y: 108 }, { x: 72, y: 96 }], durationMs: 1800, reason: "D1을 이동시킨다" },
      { order: 2, type: "pass", actorId: "F1", targetId: "A2", trigger: "D1이 따라온다", reason: "열린 알라에게 연결" },
    ],
    alternatives: [],
    riskyActions: [{ type: "pass", actorId: "F1", targetId: "A2", reason: "수비가 길을 닫으면 위험" }],
    expectedOutcome: "오른쪽 전진 공간 확보",
    evidence: [{ timeRange: "00:00:10.000-00:00:16.000", type: "observation", statement: "D1이 중앙을 막는다" }],
    uncertainties: ["A2의 출발 시점은 추정"],
  },
};

function validCard(overrides: Partial<TacticCardContent> = {}): TacticCardContent {
  return {
    situation: "중앙 압박을 받는 알라",
    conditions: ["측면 지원 가능"],
    defenseType: "front_press",
    cues: ["수비수가 공 쪽으로 전진"],
    preferred: [{ action: "pass", reason: "측면 지원", citationIds: ["chunk-1"] }],
    alternatives: [],
    risky: [],
    confidence: "high",
    uncertainties: [],
    conflicts: [],
    scenarioSuitable: true,
    animationSuitable: true,
    ...overrides,
  };
}

function executeMigrationSql(sql: string): string {
  const directory = mkdtempSync(join(tmpdir(), "evidence-schema-"));
  const databasePath = join(directory, "evidence.db");
  const migrationName = readdirSync(join(process.cwd(), "drizzle")).find((name) => /^0004_.*\.sql$/.test(name));
  if (migrationName === undefined) throw new Error("Task 1 evidence migration is missing.");

  try {
    return execFileSync("sqlite3", ["-bail", databasePath], {
      encoding: "utf8",
      input: `PRAGMA foreign_keys = ON;\n${readFileSync(join(process.cwd(), "drizzle", migrationName), "utf8")}\n${sql}`,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const bundlesSql = `
  INSERT INTO evidence_bundles (id, title, purpose, version, content_version, created_at, updated_at)
  VALUES ('bundle-1', '근거 1', '분석', 1, 'version-1', 0, 0);
  INSERT INTO evidence_bundles (id, title, purpose, version, content_version, created_at, updated_at)
  VALUES ('bundle-2', '근거 2', '분석', 1, 'version-2', 0, 0);
`;

const validJobSql = `
  INSERT INTO evidence_analysis_jobs (id, bundle_id, input_version, status, analyzer_model, prompt_version, schema_version, stage, created_at, updated_at)
  VALUES ('job-1', 'bundle-1', 'input-1', 'queued', 'model-1', 'prompt-1', 'schema-1', 'queued', 0, 0);
`;

test("video clips require HTTPS and increasing timecodes", () => {
  assert.throws(() => parseVideoClip({ url: "http://x.test/v", startMs: 0, endMs: 10, observation: "압박" }));
  assert.throws(() => parseVideoClip({ url: "https://x.test/v", startMs: 10, endMs: 10, observation: "압박" }));
  assert.deepEqual(parseVideoClip({ url: "https://x.test/v", startMs: 0, endMs: 10, observation: "압박" }).startMs, 0);
});

test("spatial evidence JSON accepts referenced players and animation paths", () => {
  const parsed = parseSpatialEvidenceJson(JSON.stringify(spatialEvidence));
  assert.equal(parsed.scene.preferredSequence[1]?.targetId, "A2");
  assert.deepEqual(parsed.scene.preferredSequence[0]?.path?.[1], { x: 72, y: 96 });
});

test("spatial evidence JSON reports the exact invalid coordinate and player reference", () => {
  const badCoordinate = structuredClone(spatialEvidence);
  badCoordinate.scene.players[0]!.position.x = 101;
  assert.throws(() => parseSpatialEvidenceJson(badCoordinate), /scene\.players\[0\]\.position\.x/);

  const missingTarget = structuredClone(spatialEvidence);
  missingTarget.scene.preferredSequence[1]!.targetId = "A9";
  assert.throws(() => parseSpatialEvidenceJson(missingTarget), /scene\.preferredSequence\[1\]\.targetId/);
});

test("a reviewable card requires supported actions and reasons", () => {
  const card = validCard({ preferred: [{ action: "pass", reason: "측면 지원", citationIds: [] }] });
  assert.throws(() => assertCardReviewTransition("owner_reviewed", card, new Set(["chunk-1"])));
});

test("a reviewable card requires at least one evidence-backed action", () => {
  const card = validCard({ preferred: [], alternatives: [], risky: [] });
  assert.throws(() => assertCardReviewTransition("coach_reviewed", card, new Set(["chunk-1"])));
});

test("bundle inputs require a title and analysis purpose", () => {
  assert.throws(() => parseBundleInput({ title: "", purpose: "압박 대응 분석" }));
  assert.deepEqual(parseBundleInput({ title: "코치 노트", purpose: "압박 대응 분석" }), {
    title: "코치 노트",
    purpose: "압박 대응 분석",
  });
});

test("tactic card content rejects an unsupported defense type", () => {
  assert.throws(() => parseTacticCardContent({ ...validCard(), defenseType: "unknown" }));
});

test("evidence versions are stable across source and clip ordering", async () => {
  const first = await computeEvidenceVersion({
    sourceHashes: ["source-b", "source-a"],
    clips: [
      { url: "https://x.test/b", startMs: 100, endMs: 200, observation: "두 번째" },
      { url: "https://x.test/a", startMs: 0, endMs: 50, observation: "첫 번째" },
    ],
    analyzerModel: "model-1",
    purpose: "전방 압박 분석",
    promptVersion: "prompt-1",
    schemaVersion: "schema-1",
  });
  const second = await computeEvidenceVersion({
    sourceHashes: ["source-a", "source-b"],
    clips: [
      { url: "https://x.test/a", startMs: 0, endMs: 50, observation: "첫 번째" },
      { url: "https://x.test/b", startMs: 100, endMs: 200, observation: "두 번째" },
    ],
    analyzerModel: "model-1",
    purpose: "전방 압박 분석",
    promptVersion: "prompt-1",
    schemaVersion: "schema-1",
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);

  const changedPurpose = await computeEvidenceVersion({
    sourceHashes: ["source-a", "source-b"],
    clips: [
      { url: "https://x.test/a", startMs: 0, endMs: 50, observation: "첫 번째" },
      { url: "https://x.test/b", startMs: 100, endMs: 200, observation: "두 번째" },
    ],
    analyzerModel: "model-1",
    purpose: "후방 빌드업 분석",
    promptVersion: "prompt-1",
    schemaVersion: "schema-1",
  });
  assert.notEqual(first, changedPurpose);
});

test("the generated migration rejects unsupported and oversized evidence inputs", () => {
  assert.doesNotThrow(() => executeMigrationSql(`${bundlesSql}
    INSERT INTO evidence_sources (id, bundle_id, original_file_name, media_type, byte_size, content_hash, storage_key, created_at, updated_at)
    VALUES ('source-boundary', 'bundle-1', 'notes.md', 'text/markdown', 20971520, 'hash-boundary', 'key-boundary', 0, 0);`));

  const invalidStatements = [
    `INSERT INTO evidence_sources (id, bundle_id, original_file_name, media_type, byte_size, content_hash, storage_key, created_at, updated_at)
      VALUES ('source-1', 'bundle-1', 'notes.zip', 'application/zip', 1, 'hash-1', 'key-1', 0, 0);`,
    `INSERT INTO evidence_sources (id, bundle_id, original_file_name, media_type, byte_size, content_hash, storage_key, created_at, updated_at)
      VALUES ('source-1', 'bundle-1', 'notes.pdf', 'application/pdf', 20971521, 'hash-1', 'key-1', 0, 0);`,
    `INSERT INTO evidence_video_clips (id, bundle_id, url, start_ms, end_ms, observation, created_at, updated_at)
      VALUES ('clip-1', 'bundle-1', 'http://x.test/v', 0, 10, '압박', 0, 0);`,
    `INSERT INTO evidence_video_clips (id, bundle_id, url, start_ms, end_ms, observation, created_at, updated_at)
      VALUES ('clip-1', 'bundle-1', 'https://x.test/v', 10, 10, '압박', 0, 0);`,
    `INSERT INTO evidence_video_clips (id, bundle_id, url, start_ms, end_ms, observation, created_at, updated_at)
      VALUES ('clip-1', 'bundle-1', 'https://x.test/v', -1, 10, '압박', 0, 0);`,
  ];

  for (const statement of invalidStatements) {
    assert.throws(() => executeMigrationSql(`${bundlesSql}${statement}`));
  }
});

test("the generated migration rejects unsupported stored workflow statuses", () => {
  assert.throws(() => executeMigrationSql(`${bundlesSql}
    INSERT INTO evidence_analysis_jobs (id, bundle_id, input_version, status, analyzer_model, prompt_version, schema_version, stage, created_at, updated_at)
    VALUES ('job-1', 'bundle-1', 'input-1', 'invalid', 'model-1', 'prompt-1', 'schema-1', 'queued', 0, 0);`));

  assert.throws(() => executeMigrationSql(`${bundlesSql}${validJobSql}
    INSERT INTO tactic_cards (id, bundle_id, job_id, bundle_version, status, draft_content_json, current_content_json, is_stale, created_at, updated_at)
    VALUES ('card-1', 'bundle-1', 'job-1', 'version-1', 'invalid', '{}', '{}', false, 0, 0);`));

  assert.throws(() => executeMigrationSql(`${bundlesSql}${validJobSql}
    INSERT INTO tactic_cards (id, bundle_id, job_id, bundle_version, status, draft_content_json, current_content_json, is_stale, created_at, updated_at)
    VALUES ('card-1', 'bundle-1', 'job-1', 'version-1', 'analysis_draft', '{}', '{}', false, 0, 0);
    INSERT INTO tactic_card_reviews (id, card_id, actor_user_id, status, content_json, citation_snapshot_json, bundle_version, created_at)
    VALUES ('review-1', 'card-1', 'user-1', 'invalid', '{}', '[]', 'version-1', 0);`));
});

test("the generated migration rejects cross-bundle chunk and citation provenance", () => {
  assert.throws(() => executeMigrationSql(`${bundlesSql}
    INSERT INTO evidence_analysis_jobs (id, bundle_id, input_version, status, analyzer_model, prompt_version, schema_version, stage, created_at, updated_at)
    VALUES ('job-2', 'bundle-2', 'input-2', 'queued', 'model-1', 'prompt-1', 'schema-1', 'queued', 0, 0);
    INSERT INTO tactic_cards (id, bundle_id, job_id, bundle_version, status, draft_content_json, current_content_json, is_stale, created_at, updated_at)
    VALUES ('card-1', 'bundle-1', 'job-2', 'version-1', 'analysis_draft', '{}', '{}', false, 0, 0);`));

  assert.throws(() => executeMigrationSql(`${bundlesSql}
    INSERT INTO evidence_sources (id, bundle_id, original_file_name, media_type, byte_size, content_hash, storage_key, created_at, updated_at)
    VALUES ('source-2', 'bundle-2', 'notes.pdf', 'application/pdf', 1, 'hash-2', 'key-2', 0, 0);
    INSERT INTO evidence_chunks (id, bundle_id, source_id, video_clip_id, ordinal, location_label, content, content_hash, created_at)
    VALUES ('chunk-1', 'bundle-1', 'source-2', NULL, 0, 'p1', '근거', 'chunk-hash-1', 0);`));

  assert.throws(() => executeMigrationSql(`${bundlesSql}${validJobSql}
    INSERT INTO tactic_cards (id, bundle_id, job_id, bundle_version, status, draft_content_json, current_content_json, is_stale, created_at, updated_at)
    VALUES ('card-1', 'bundle-1', 'job-1', 'version-1', 'analysis_draft', '{}', '{}', false, 0, 0);
    INSERT INTO evidence_sources (id, bundle_id, original_file_name, media_type, byte_size, content_hash, storage_key, created_at, updated_at)
    VALUES ('source-2', 'bundle-2', 'notes.pdf', 'application/pdf', 1, 'hash-2', 'key-2', 0, 0);
    INSERT INTO evidence_chunks (id, bundle_id, source_id, video_clip_id, ordinal, location_label, content, content_hash, created_at)
    VALUES ('chunk-2', 'bundle-2', 'source-2', NULL, 0, 'p1', '근거', 'chunk-hash-2', 0);
    INSERT INTO tactic_card_citations (id, bundle_id, card_id, chunk_id, created_at)
    VALUES ('citation-1', 'bundle-1', 'card-1', 'chunk-2', 0);`));
});
