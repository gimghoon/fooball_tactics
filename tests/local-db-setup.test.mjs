import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectDir = process.cwd();
const wrangler = join(projectDir, "node_modules", ".bin", "wrangler");
const migrations = [
  "0000_sweet_pet_avengers.sql",
  "0001_chunky_talon.sql",
  "0002_slippery_giant_man.sql",
  "0003_perfect_orphan.sql",
  "0004_confused_tony_stark.sql",
  "0005_broken_firedrake.sql",
  "0006_overrated_leo.sql",
  "0007_amazing_barracuda.sql",
  "0008_lyrical_daredevil.sql",
  "0009_smiling_synch.sql",
  "0010_external_evidence_search.sql",
  "0011_evidence_r2_cleanup_receipts.sql",
  "0012_evidence_r2_cleanup_without_bundle_fk.sql",
  "0013_quick_layla_miller.sql",
];

function runWrangler(persistTo, args, expectJson = false) {
  const result = spawnSync(wrangler, [
    "d1", "execute", "site-creator-d1", "--config", "wrangler.local.jsonc", "--local",
    "--persist-to", persistTo, ...args,
  ], { cwd: projectDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return expectJson ? JSON.parse(result.stdout) : undefined;
}

function applyMigrations(persistTo, through, from = migrations[0]) {
  const start = migrations.indexOf(from);
  const end = migrations.indexOf(through);
  assert.ok(start >= 0 && end >= start, `invalid migration range: ${from}..${through}`);
  for (const migration of migrations.slice(start, end + 1)) {
    runWrangler(persistTo, ["--file", join("drizzle", migration), "--yes"]);
  }
}

function query(persistTo, command) {
  return runWrangler(persistTo, ["--command", command, "--json"], true);
}

function createPersistTo() {
  return mkdtempSync(join(tmpdir(), "tactiq-local-db-test-"));
}

function runLocalSetup(persistTo) {
  return spawnSync(process.execPath, ["scripts/setup-local-db.mjs", "--persist-to", persistTo], {
    cwd: projectDir,
    encoding: "utf8",
  });
}

function seed0009EvidenceHistory(persistTo) {
  query(persistTo, `
    INSERT INTO evidence_bundles (id, title, purpose, version, content_version, created_at, updated_at)
    VALUES ('upgrade-bundle', '기존 근거', '업그레이드 보존', 1, 'v1', 1, 1);
    INSERT INTO evidence_sources (id, bundle_id, original_file_name, media_type, byte_size, content_hash, storage_key, extraction_status, created_at, updated_at)
    VALUES ('upgrade-source', 'upgrade-bundle', 'legacy.txt', 'text/plain', 12, 'source-hash', 'evidence/legacy.txt', 'completed', 1, 1);
    INSERT INTO evidence_analysis_jobs (id, bundle_id, input_version, status, analyzer_model, prompt_version, schema_version, stage, attempt_count, is_stale, created_at, updated_at)
    VALUES ('upgrade-job', 'upgrade-bundle', 'v1', 'completed', 'legacy-model', 'p1', 's1', 'done', 1, false, 1, 1);
    INSERT INTO evidence_chunks (id, bundle_id, input_version, source_id, video_clip_id, ordinal, location_label, content, content_hash, created_at)
    VALUES ('upgrade-chunk', 'upgrade-bundle', 'v1', 'upgrade-source', NULL, 0, 'p.1', '기존 근거 문장', 'chunk-hash', 1);
    INSERT INTO tactic_cards (id, bundle_id, job_id, bundle_version, status, draft_content_json, current_content_json, is_stale, created_at, updated_at)
    VALUES ('upgrade-card', 'upgrade-bundle', 'upgrade-job', 'v1', 'owner_reviewed', '{"citations":["upgrade-chunk"]}', '{"citations":["upgrade-chunk"]}', false, 1, 1);
    INSERT INTO tactic_card_citations (id, bundle_id, card_id, chunk_id, created_at)
    VALUES ('upgrade-citation', 'upgrade-bundle', 'upgrade-card', 'upgrade-chunk', 1);
    INSERT INTO tactic_card_reviews (id, card_id, actor_user_id, status, version_kind, producer_job_id, producer_model, content_json, citation_snapshot_json, bundle_version, created_at)
    VALUES ('upgrade-review', 'upgrade-card', 'operator-1', 'owner_reviewed', 'status_change', NULL, NULL, '{"cardId":"upgrade-card"}', '[{"chunkId":"upgrade-chunk"}]', 'v1', 1);
  `);
}

test("local setup verifies external search tables and foreign keys on each clean reset", (t) => {
  const persistTo = createPersistTo();
  t.after(() => rmSync(persistTo, { recursive: true, force: true }));

  const firstSetup = runLocalSetup(persistTo);
  assert.equal(firstSetup.status, 0, firstSetup.stderr || firstSetup.stdout);
  assert.match(firstSetup.stdout, /외부 검색 테이블 확인/);
  assert.match(firstSetup.stdout, /외래키 검사 통과/);

  const secondSetup = runLocalSetup(persistTo);
  assert.equal(secondSetup.status, 0, secondSetup.stderr || secondSetup.stdout);
  assert.match(secondSetup.stdout, /외부 검색 테이블 확인/);

  const result = query(persistTo, `
    SELECT id, review_status FROM campaigns WHERE id='diamond-121-intro';
    SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('evidence_search_runs', 'evidence_search_candidates') ORDER BY name;
    SELECT name FROM pragma_table_info('evidence_search_runs')
      WHERE name IN ('lease_token', 'lease_expires_at') ORDER BY name;
    SELECT name FROM pragma_table_info('evidence_search_candidates')
      WHERE name IN ('lease_token', 'lease_expires_at') ORDER BY name;
    SELECT name FROM sqlite_master WHERE type='index'
      AND name IN ('idx_evidence_search_runs_recovery', 'idx_search_candidate_run_recovery') ORDER BY name;
    PRAGMA foreign_key_check;
  `);
  assert.deepEqual(result[0].results, [{ id: "diamond-121-intro", review_status: "pending" }]);
  assert.deepEqual(result[1].results, [
    { name: "evidence_search_candidates" },
    { name: "evidence_search_runs" },
  ]);
  assert.deepEqual(result[2].results, [{ name: "lease_expires_at" }, { name: "lease_token" }]);
  assert.deepEqual(result[3].results, [{ name: "lease_expires_at" }, { name: "lease_token" }]);
  assert.deepEqual(result[4].results, [
    { name: "idx_evidence_search_runs_recovery" },
    { name: "idx_search_candidate_run_recovery" },
  ]);
  assert.deepEqual(result[5].results, []);
});

test("0009 upgrade preserves uploaded evidence, card citation, and review history", (t) => {
  const persistTo = createPersistTo();
  t.after(() => rmSync(persistTo, { recursive: true, force: true }));

  applyMigrations(persistTo, "0009_smiling_synch.sql");
  seed0009EvidenceHistory(persistTo);
  applyMigrations(persistTo, "0013_quick_layla_miller.sql", "0010_external_evidence_search.sql");

  const result = query(persistTo, `
    SELECT id, bundle_id FROM evidence_sources WHERE id='upgrade-source';
    SELECT id, bundle_id, status FROM evidence_analysis_jobs WHERE id='upgrade-job';
    SELECT id, job_id, current_content_json FROM tactic_cards WHERE id='upgrade-card';
    SELECT id, card_id, chunk_id FROM tactic_card_citations WHERE id='upgrade-citation';
    SELECT id, card_id, citation_snapshot_json FROM tactic_card_reviews WHERE id='upgrade-review';
    SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('evidence_search_runs', 'evidence_search_candidates') ORDER BY name;
    PRAGMA foreign_key_check;
  `);

  assert.deepEqual(result[0].results, [{ id: "upgrade-source", bundle_id: "upgrade-bundle" }]);
  assert.deepEqual(result[1].results, [{ id: "upgrade-job", bundle_id: "upgrade-bundle", status: "completed" }]);
  assert.deepEqual(result[2].results, [{
    id: "upgrade-card",
    job_id: "upgrade-job",
    current_content_json: '{"citations":["upgrade-chunk"]}',
  }]);
  assert.deepEqual(result[3].results, [{
    id: "upgrade-citation",
    card_id: "upgrade-card",
    chunk_id: "upgrade-chunk",
  }]);
  assert.deepEqual(result[4].results, [{
    id: "upgrade-review",
    card_id: "upgrade-card",
    citation_snapshot_json: '[{"chunkId":"upgrade-chunk"}]',
  }]);
  assert.deepEqual(result[5].results, [
    { name: "evidence_search_candidates" },
    { name: "evidence_search_runs" },
  ]);
  assert.deepEqual(result[6].results, []);
});
