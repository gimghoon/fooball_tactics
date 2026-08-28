import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { EvidenceWizard, type EvidenceWizardBundle } from "../app/admin/evidence/EvidenceWizard.tsx";

const window = new Window({ url: "http://localhost/admin/evidence" });
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  File: window.File,
  FormData: window.FormData,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  assert.ok(found, `button ${label} not found`);
  return found as HTMLButtonElement;
}

afterEach(async () => {
  while (roots.length) await act(async () => roots.pop()!.unmount());
  document.body.replaceChildren();
});

test("loads the administrator bundle list when the server page starts empty", async () => {
  const api = async (path: string) => path === "/api/admin/evidence" ? { bundles: [bundle] } : { bundle };
  const container = await render(<EvidenceWizard initialBundles={[]} request={api} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(container.textContent ?? "", /다이아몬드 전방 압박/);
});

const bundle: EvidenceWizardBundle = {
  id: "bundle-1", title: "다이아몬드 전방 압박", purpose: "압박 탈출 판단", version: 1,
  contentVersion: "v1", createdAt: 1, updatedAt: 1,
  sources: [{ id: "source-1", bundleId: "bundle-1", originalFileName: "coach.pdf", mediaType: "application/pdf", byteSize: 1200, contentHash: "hash", extractionStatus: "completed", extractionError: null }],
  videoClips: [],
};

const spatialValue = {
  source: { title: "압박", url: "https://coach.example/video", startTime: "00:00:00", endTime: "00:00:10", coachName: "코치" },
  coordinateSystem: { width: 100, height: 136, attackDirection: "negative_y", normalized: true },
  scene: {
    title: "픽소 판단", decisionTime: "00:00:05", userRole: "fixo", ballOwnerId: "F1",
    defense: { primaryType: "front_press", description: "D1 압박" },
    players: [
      { id: "F1", team: "attack", role: "fixo", position: { x: 50, y: 100 }, hasBall: true, confidence: "exact" },
      { id: "D1", team: "defense", role: "defender", position: { x: 50, y: 80 }, hasBall: false, confidence: "estimated" },
    ],
    openSpaces: [], decisionCues: ["D1 위치"],
    preferredSequence: [{ order: 1, type: "dribble", actorId: "F1", path: [{ x: 50, y: 100 }, { x: 70, y: 90 }], durationMs: 1000, reason: "바깥 공간 사용" }],
    alternatives: [], riskyActions: [], expectedOutcome: "압박 회피",
    evidence: [{ timeRange: "00:00:00-00:00:06", type: "observation", statement: "D1이 접근" }], uncertainties: [],
  },
};

test("analysis remains disabled until the operator explicitly confirms the evidence inventory", async () => {
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId="bundle-1" />);
  await act(async () => button(container, "분석 확인").click());
  assert.equal(button(container, "분석 시작").disabled, true);
  const confirmation = container.querySelector<HTMLInputElement>('input[name="analysis-confirmation"]');
  assert.ok(confirmation);
  await act(async () => confirmation.click());
  assert.equal(button(container, "분석 시작").disabled, false);
});

test("external search only starts after the explicit button", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const api = async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    if (path.endsWith("/search")) return { search: { id: "search-1", bundleId: bundle.id, status: "queued" } };
    throw new Error(`unexpected ${path}`);
  };
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId={bundle.id} request={api} />);
  assert.deepEqual(requests, []);
  await act(async () => button(container, "외부 검색").click());
  await act(async () => button(container, "외부 출처 찾기").click());
  assert.deepEqual(requests.map((item) => item.path), [`/api/admin/evidence/${bundle.id}/search`]);
  assert.equal(requests[0]?.init?.method, "POST");
});

test("operator selects at most five and imports only the checked candidates", async () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    id: `candidate-${index + 1}`, title: `외부 출처 ${index + 1}`, publisher: "협회", publishedAt: "2026-01-02",
    canonicalUrl: `https://example.com/${index + 1}`, documentType: "web_page", quote: "핵심 인용", relevance: "관련성", trustTier: 1,
    rank: index + 1, status: "candidate", failureReason: null,
  }));
  const search = { run: { id: "search-1", bundleId: bundle.id, bundleVersion: bundle.version, status: "ready", errorMessage: null, isStale: false, startedAt: 1, completedAt: null, createdAt: 1, updatedAt: 1 }, candidates };
  const container = await render(<EvidenceWizard initialBundles={[{ ...bundle, latestSearch: search }]} initialBundleId={bundle.id} request={async () => ({ search })} />);
  await act(async () => button(container, "외부 검색").click());
  for (const candidate of candidates.slice(0, 5)) {
    const input = container.querySelector<HTMLInputElement>(`input[value="${candidate.id}"]`);
    assert.ok(input); await act(async () => input.click());
  }
  assert.equal(button(container, "선택 출처 가져오기").disabled, false);
  const sixth = container.querySelector<HTMLInputElement>('input[value="candidate-6"]');
  assert.ok(sixth); await act(async () => sixth.click());
  assert.match(container.textContent ?? "", /최대 5개/);
});

test("direct-only analysis remains available", async () => {
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId={bundle.id} />);
  await act(async () => button(container, "외부 검색").click());
  await act(async () => button(container, "외부 출처 없이 분석 확인").click());
  assert.match(container.textContent ?? "", /직접 등록 1개 · 외부 보충 0개 · 영상 관찰 0개/);
  const confirmation = container.querySelector<HTMLInputElement>('input[name="analysis-confirmation"]');
  assert.ok(confirmation); await act(async () => confirmation.click());
  assert.equal(button(container, "분석 시작").disabled, false);
});

test("card review places cited source context beside action reasons and shows animation memory labels", async () => {
  const reviewBundle: EvidenceWizardBundle = {
    ...bundle,
    latestJob: { id: "job-1", bundleId: "bundle-1", inputVersion: "v1", status: "review_ready", stage: "review", errorMessage: null, startedAt: 1, completedAt: null, attemptCount: 1, isStale: false, createdAt: 1, updatedAt: 1 },
    cards: [{
      id: "card-1", bundleId: "bundle-1", jobId: "job-1", bundleVersion: 1, status: "analysis_draft", isStale: false, createdAt: 1, updatedAt: 1,
      content: { situation: "전방 압박을 받는 픽소", conditions: ["중앙 패스길 차단"], defenseType: "front_press", cues: ["수비 발 방향"], preferred: [{ action: "dribble", reason: "압박수비 바깥 어깨를 넘어 전진", citationIds: ["chunk-2"] }], alternatives: [], risky: [], confidence: "high", uncertainties: [], conflicts: [], scenarioSuitable: true, animationSuitable: true },
      citationCount: 1,
      citations: [{ chunkId: "chunk-2", sourceId: "source-1", videoClipId: null, locationLabel: "문서 3쪽", excerpt: "수비가 중앙을 닫으면 바깥쪽으로 운반한다." }],
    }],
  };
  const container = await render(<EvidenceWizard initialBundles={[reviewBundle]} initialBundleId="bundle-1" />);
  await act(async () => button(container, "카드 검수").click());
  assert.match(container.textContent ?? "", /근거 C-2 · 문서 3쪽/);
  assert.match(container.textContent ?? "", /드리블 권장 이유/);
  for (const label of ["관찰", "선택", "결과", "기억"]) assert.match(container.textContent ?? "", new RegExp(label));
  assert.equal(button(container, "본인 검수 완료").disabled, false);
});

test("a referenced source cannot be confirmed for deletion", async () => {
  const api = async (path: string) => {
    if (path.endsWith("/impact")) return { impact: { sourceId: "source-1", cardIds: ["card-1"], scenarioDraftIds: ["scenario-1"] } };
    throw new Error(`unexpected ${path}`);
  };
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId="bundle-1" request={api} />);
  await act(async () => button(container, "직접 근거").click());
  await act(async () => button(container, "삭제").click());
  assert.match(container.textContent ?? "", /카드 1개/);
  assert.match(container.textContent ?? "", /시나리오 초안 1개/);
  assert.equal(button(container, "삭제 확인").disabled, true);
});

test("pasted spatial JSON is validated and uploaded as a source", async () => {
  let uploadedName = "";
  const api = async (path: string, init?: RequestInit) => {
    if (path.endsWith("/files") && init?.body instanceof FormData) {
      const file = init.body.get("file");
      assert.ok(file instanceof File);
      uploadedName = file.name;
      return { source: { id: "json-1", bundleId: "bundle-1", originalFileName: file.name, mediaType: "text/plain", byteSize: file.size, contentHash: "json-hash", extractionStatus: "completed", extractionError: null } };
    }
    throw new Error(`unexpected ${path}`);
  };
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId="bundle-1" request={api} />);
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[name="spatial-json"]');
  assert.ok(textarea);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    assert.ok(setter);
    setter.call(textarea, JSON.stringify(spatialValue));
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.match(uploadedName, /^spatial-evidence-.*\.json$/);
  assert.match(container.textContent ?? "", /JSON 근거를 등록했습니다/);
});

test("multi-file upload reloads and displays every stored JSON source", async () => {
  const stored = [...bundle.sources!];
  const api = async (path: string, init?: RequestInit) => {
    if (path.endsWith("/files") && init?.body instanceof FormData) {
      const file = init.body.get("file");
      assert.ok(file instanceof File);
      const source = { id: `source-${stored.length + 1}`, bundleId: bundle.id, originalFileName: file.name, mediaType: "text/plain", byteSize: file.size, contentHash: `hash-${stored.length + 1}`, extractionStatus: "completed", extractionError: null };
      stored.push(source);
      return { source };
    }
    if (path === `/api/admin/evidence/${bundle.id}`) return { bundle: { ...bundle, sources: stored }, latestJob: null };
    throw new Error(`unexpected ${path}`);
  };
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId={bundle.id} request={api} />);
  const input = container.querySelector<HTMLInputElement>("#evidence-files");
  assert.ok(input);
  Object.defineProperty(input, "files", { configurable: true, value: [
    new File([JSON.stringify(spatialValue)], "one.json", { type: "application/json" }),
    new File([JSON.stringify({ ...spatialValue, source: { ...spatialValue.source, title: "두 번째" } })], "two.json", { type: "application/json" }),
  ] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(container.textContent ?? "", /one\.json/);
  assert.match(container.textContent ?? "", /two\.json/);
  assert.match(container.textContent ?? "", /2개 파일을 등록했습니다/);
});

test("unsupported combined JSON reports its file name before uploading anything", async () => {
  let requests = 0;
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId={bundle.id} request={async () => { requests += 1; throw new Error("should not upload"); }} />);
  const input = container.querySelector<HTMLInputElement>("#evidence-files");
  assert.ok(input);
  Object.defineProperty(input, "files", { configurable: true, value: [
    new File([JSON.stringify({ datasetId: "draft", sourceOverview: {}, cards: [] })], "combined-draft.json", { type: "application/json" }),
  ] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(requests, 0);
  assert.match(container.textContent ?? "", /combined-draft\.json/);
  assert.match(container.textContent ?? "", /지원하지 않는 공간 전술 JSON 형식/);
});
