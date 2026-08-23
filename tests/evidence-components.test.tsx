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

test("analysis remains disabled until the operator explicitly confirms the evidence inventory", async () => {
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId="bundle-1" />);
  await act(async () => button(container, "분석 확인").click());
  assert.equal(button(container, "분석 시작").disabled, true);
  const confirmation = container.querySelector<HTMLInputElement>('input[name="analysis-confirmation"]');
  assert.ok(confirmation);
  await act(async () => confirmation.click());
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
    if (path.endsWith("/impact")) return { impact: { cardCount: 1, scenarioDraftCount: 1, cardIds: ["card-1"], scenarioDraftIds: ["scenario-1"] } };
    throw new Error(`unexpected ${path}`);
  };
  const container = await render(<EvidenceWizard initialBundles={[bundle]} initialBundleId="bundle-1" request={api} />);
  await act(async () => button(container, "근거 추가").click());
  await act(async () => button(container, "삭제").click());
  assert.match(container.textContent ?? "", /카드 1개/);
  assert.match(container.textContent ?? "", /시나리오 초안 1개/);
  assert.equal(button(container, "삭제 확인").disabled, true);
});
