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
      "SELECT id, review_status FROM campaigns WHERE id='diamond-121-intro'; PRAGMA foreign_key_check;",
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(query.status, 0, query.stderr || query.stdout);
  const result = JSON.parse(query.stdout);
  assert.deepEqual(result[0].results, [{ id: "diamond-121-intro", review_status: "pending" }]);
  assert.deepEqual(result[1].results, []);
});
