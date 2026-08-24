import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function render({ path = "/" } = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the evidence upload UI while keeping its data APIs protected", async () => {
  const response = await render({ path: "/admin/evidence" });
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /근거 묶음/);
  assert.match(html, /묶음 만들고 근거 추가/);
});

test("renders the coach management entry point on the home page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /코치 자료 관리/);
});

async function renderedClientBundles() {
  const clientRoot = new URL("../dist/client/", import.meta.url);
  const entries = await readdir(clientRoot, { recursive: true, withFileTypes: true });
  const bundles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".js"));
  return Promise.all(bundles.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
}

async function renderedClientAssets() {
  const clientRoot = new URL("../dist/client/", import.meta.url);
  const entries = await readdir(clientRoot, { recursive: true, withFileTypes: true });
  const assets = entries.filter((entry) => entry.isFile() && /\.(?:css|js)$/.test(entry.name));
  return Promise.all(assets.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
}

test("renders the mobile futsal training product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /TACTIQ/);
  assert.match(html, /다이아몬드 1-2-1/);
  assert.match(html, /오늘의 팀 훈련/);
  assert.match(html, /코치 자료 검수 대기/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/);
});

test("renders action-first tactical controls in the client bundle", async () => {
  const bundle = (await renderedClientBundles()).join("\n");

  assert.match(bundle, /패스/);
  assert.match(bundle, /드리블/);
  assert.match(bundle, /이동/);
  assert.match(bundle, /행동을 먼저 고르세요/);
});

test("renders the three-stage reviewed explanation controls in the client bundle", async () => {
  const assets = (await renderedClientAssets()).join("\n");

  assert.match(assets, /상황/);
  assert.match(assets, /판단/);
  assert.match(assets, /결과/);
  assert.match(assets, /다시 보기/);
  assert.match(assets, /일시정지/);
  assert.match(assets, /playback-seek/);
  assert.match(assets, /reduced-motion-arrow/);
  assert.match(assets, /path-endpoint/);
  assert.match(assets, /playback-keyframe-seek/);
});
