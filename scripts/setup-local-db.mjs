import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const persistFlagIndex = process.argv.indexOf("--persist-to");
const requestedPersistPath = persistFlagIndex >= 0 ? process.argv[persistFlagIndex + 1] : ".wrangler/state";

if (!requestedPersistPath) throw new Error("--persist-to 뒤에 로컬 저장 경로가 필요합니다.");

const persistTo = resolve(projectDir, requestedPersistPath);
if ([resolve("/"), resolve(homedir()), projectDir].includes(persistTo)) {
  throw new Error("안전하지 않은 로컬 데이터베이스 초기화 경로입니다.");
}

const d1StatePath = join(persistTo, "v3", "d1");
rmSync(d1StatePath, { recursive: true, force: true });

const wrangler = join(projectDir, "node_modules", ".bin", "wrangler");
const migrations = readdirSync(join(projectDir, "drizzle"))
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort();

for (const migration of migrations) {
  const result = spawnSync(wrangler, [
    "d1", "execute", "site-creator-d1",
    "--config", "wrangler.local.jsonc",
    "--local",
    "--persist-to", persistTo,
    "--file", join("drizzle", migration),
    "--yes",
  ], { cwd: projectDir, encoding: "utf8" });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

const integrity = spawnSync(wrangler, [
  "d1", "execute", "site-creator-d1",
  "--config", "wrangler.local.jsonc",
  "--local",
  "--persist-to", persistTo,
  "--command", `
    PRAGMA foreign_key_check;
    SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('evidence_search_runs', 'evidence_search_candidates')
    ORDER BY name;
  `,
  "--json",
], { cwd: projectDir, encoding: "utf8" });

if (integrity.status !== 0) {
  process.stderr.write(integrity.stderr || integrity.stdout);
  process.exit(integrity.status ?? 1);
}

const integrityResult = JSON.parse(integrity.stdout);
const foreignKeyViolations = integrityResult[0]?.results ?? [];
if (foreignKeyViolations.length > 0) {
  process.stderr.write("로컬 데이터베이스 외래키 검사에 실패했습니다.\n");
  process.exit(1);
}

const expectedSearchTables = ["evidence_search_candidates", "evidence_search_runs"];
const actualSearchTables = (integrityResult[1]?.results ?? []).map((row) => row.name);
if (JSON.stringify(actualSearchTables) !== JSON.stringify(expectedSearchTables)) {
  process.stderr.write("외부 검색 테이블이 모두 생성되지 않았습니다.\n");
  process.exit(1);
}

process.stdout.write(`외부 검색 테이블 확인 (${actualSearchTables.join(", ")})\n`);
process.stdout.write("외래키 검사 통과\n");
process.stdout.write(`로컬 데이터베이스 준비 완료 (${migrations.length}개 마이그레이션)\n`);
