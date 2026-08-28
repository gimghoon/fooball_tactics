import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("local database setup applies every migration to an isolated D1 database", () => {
  const persistTo = mkdtempSync(join(tmpdir(), "tactiq-local-db-test-"));
  const setup = spawnSync(process.execPath, ["scripts/setup-local-db.mjs", "--persist-to", persistTo], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(setup.status, 0, setup.stderr || setup.stdout);

  const query = spawnSync(
    join(process.cwd(), "node_modules", ".bin", "wrangler"),
    [
      "d1", "execute", "site-creator-d1", "--config", "wrangler.local.jsonc", "--local",
      "--persist-to", persistTo, "--command",
      `SELECT id, review_status FROM campaigns WHERE id='diamond-121-intro';
       SELECT name FROM pragma_table_info('evidence_search_runs')
         WHERE name IN ('lease_token','lease_expires_at') ORDER BY name;
       SELECT name FROM pragma_table_info('evidence_search_candidates')
         WHERE name IN ('lease_token','lease_expires_at') ORDER BY name;
       SELECT name FROM sqlite_master WHERE type='index'
         AND name IN ('idx_evidence_search_runs_recovery','idx_search_candidate_run_recovery') ORDER BY name;
       PRAGMA foreign_key_check;`,
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(query.status, 0, query.stderr || query.stdout);
  const result = JSON.parse(query.stdout);
  assert.deepEqual(result[0].results, [{ id: "diamond-121-intro", review_status: "pending" }]);
  assert.deepEqual(result[1].results, [{ name: "lease_expires_at" }, { name: "lease_token" }]);
  assert.deepEqual(result[2].results, [{ name: "lease_expires_at" }, { name: "lease_token" }]);
  assert.deepEqual(result[3].results, [
    { name: "idx_evidence_search_runs_recovery" },
    { name: "idx_search_candidate_run_recovery" },
  ]);
  assert.deepEqual(result[4].results, []);
});
