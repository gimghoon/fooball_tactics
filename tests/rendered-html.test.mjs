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

async function renderedStyles() {
  const clientRoot = new URL("../dist/client/", import.meta.url);
  const entries = await readdir(clientRoot, { recursive: true, withFileTypes: true });
  const styles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".css"));
  return Promise.all(styles.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
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

test("renders the five-step evidence search controls with accessible external links", async () => {
  const assets = (await renderedClientAssets()).join("\n");

  assert.match(assets, /외부 출처 찾기/);
  assert.match(assets, /선택 출처 가져오기/);
  assert.match(assets, /실패한 출처 다시 시도/);
  assert.match(assets, /외부 출처 없이 분석 확인/);
  assert.match(assets, /최대 5개/);
  assert.match(assets, /noreferrer noopener/);
  assert.match(assets, /candidate-list/);
  assert.match(assets, /min-height:44px/);
  assert.match(assets, /영상 관찰만 분석한다는/);
});

test("keeps responsive Coach Desk candidate styling and 44px candidate actions", async () => {
  const css = (await renderedStyles()).join("\n");

  const candidateListRule = css.match(/\.candidate-list\{([^}]*)\}/)?.[1];
  assert.ok(candidateListRule, "candidate list CSS rule is emitted");
  assert.match(candidateListRule, /display:grid/);
  assert.match(candidateListRule, /grid-template-columns:1fr/);
  assert.match(css, /@media ?\(min-width:768px\)\{\.candidate-list\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(css, /\.candidate-card \.quote-toggle,\.candidate-card \.candidate-exclude,\.candidate-card \.candidate-retry\{[^}]*min-height:44px/);
  assert.match(css, /\.candidate-card a\{overflow-wrap:anywhere\}/);
});
