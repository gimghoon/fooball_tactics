import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
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
