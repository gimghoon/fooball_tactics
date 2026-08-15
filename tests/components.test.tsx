import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { CoachExplanationPanel } from "../app/train/[campaignId]/CoachExplanationPanel.tsx";
import { TacticalPitch, type TacticalChoice } from "../app/train/[campaignId]/TacticalPitch.tsx";
import type { CoachExplanation, HighlightRef, PublicScenarioContent } from "../lib/domain/content.ts";

const browser = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  SVGElement: browser.SVGElement,
  Event: browser.Event,
  PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: browser.navigator });

const mountedRoots = new Set<Root>();

async function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.add(root);
  await act(async () => { root.render(element); });
  return { container, root };
}

afterEach(async () => {
  for (const root of mountedRoots) await act(async () => { root.unmount(); });
  mountedRoots.clear();
  document.body.replaceChildren();
});

function setupMatchMedia(reducedMotion: boolean) {
  window.matchMedia = (() => ({
    matches: reducedMotion,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function setupRaf() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  window.requestAnimationFrame = (callback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    cancelled.push(id);
    callbacks.delete(id);
  };
  return { callbacks, cancelled };
}

function content(overrides: Partial<PublicScenarioContent> = {}): PublicScenarioContent {
  return {
    defenseType: "front_press",
    actorId: "actor",
    allowedActions: ["pass", "dribble", "move"],
    passInputMode: "player",
    pitch: {
      players: [
        { id: "actor", x: 50, y: 70, team: "us" },
        { id: "teammate", x: 30, y: 50, team: "us" },
        { id: "defender", x: 50, y: 40, team: "them" },
      ],
      ball: { x: 50, y: 70 },
      zones: [{ id: "space", zone: { kind: "circle", cx: 30, cy: 50, radius: 6 } }],
    },
    setupTimeline: {
      durationMs: 500,
      decisionAtMs: 500,
      keyframes: [
        { atMs: 0, players: { defender: { x: 50, y: 40 } }, ball: { x: 50, y: 70 } },
        { atMs: 500, players: { defender: { x: 50, y: 55 } }, ball: { x: 50, y: 70 } },
      ],
    },
    ...overrides,
  };
}

function button(container: Element, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  assert.ok(match, `missing button ${label}`);
  return match as HTMLButtonElement;
}

test("setup timeline autoplays before enabling actions", async () => {
  setupMatchMedia(false);
  const raf = setupRaf();
  const { container } = await render(<TacticalPitch content={content()} onSubmit={() => {}} />);
  const pass = button(container, "패스");
  assert.equal(pass.disabled, true);
  assert.equal(container.querySelector('circle[data-player-id="defender"]')?.getAttribute("cy"), "40");

  const first = [...raf.callbacks.entries()][0];
  assert.ok(first);
  raf.callbacks.delete(first[0]);
  await act(async () => { first[1](0); });
  const second = [...raf.callbacks.entries()][0];
  assert.ok(second);
  raf.callbacks.delete(second[0]);
  await act(async () => { second[1](500); });

  assert.equal(pass.disabled, false);
  assert.equal(container.querySelector('circle[data-player-id="defender"]')?.getAttribute("cy"), "55");
});

test("setup replay cancels the active frame and unmount cancels its replacement", async () => {
  setupMatchMedia(false);
  const raf = setupRaf();
  const mounted = await render(<TacticalPitch content={content()} onSubmit={() => {}} />);
  const initialId = [...raf.callbacks.keys()][0];
  assert.ok(initialId);

  await act(async () => { button(mounted.container, "상황 다시 보기").click(); });
  assert.ok(raf.cancelled.includes(initialId));
  const replacementId = [...raf.callbacks.keys()][0];
  assert.ok(replacementId);

  await act(async () => { mounted.root.unmount(); });
  mountedRoots.delete(mounted.root);
  assert.ok(raf.cancelled.includes(replacementId));
});

test("reduced motion shows reviewed setup endpoints and arrows without RAF", async () => {
  setupMatchMedia(true);
  const raf = setupRaf();
  const { container } = await render(
    <TacticalPitch content={content()} prefersReducedMotion onSubmit={() => {}} />,
  );

  assert.equal(raf.callbacks.size, 0);
  assert.equal(button(container, "패스").disabled, false);
  assert.ok(container.querySelectorAll(".setup-motion-arrow").length > 0);
  assert.ok(container.querySelectorAll(".setup-start-endpoint").length > 0);
});

test("player pass targets stop pitch propagation and work with pointer and keyboard", async () => {
  setupMatchMedia(false);
  setupRaf();
  const choices: TacticalChoice[] = [];
  const noSetup = content({ setupTimeline: { durationMs: 0, decisionAtMs: 0, keyframes: [{ atMs: 0, players: {}, ball: { x: 50, y: 70 } }] } });
  const { container } = await render(<TacticalPitch content={noSetup} onSubmit={(choice) => choices.push(choice)} />);
  await act(async () => { button(container, "패스").click(); });
  const target = container.querySelector('[role="button"][aria-label="동료 선수 teammate"]');
  assert.ok(target);

  await act(async () => { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 })); });
  assert.deepEqual(choices, [{ actionType: "pass", targetPlayerId: "teammate" }]);
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.deepEqual(choices[1], { actionType: "pass", targetPlayerId: "teammate" });
});

test("zone pass teammate taps use the exact canonical player coordinate", async () => {
  setupMatchMedia(false);
  setupRaf();
  const choices: TacticalChoice[] = [];
  const zonePass = content({
    passInputMode: "destination",
    setupTimeline: { durationMs: 0, decisionAtMs: 0, keyframes: [{ atMs: 0, players: {}, ball: { x: 50, y: 70 } }] },
  });
  const { container } = await render(<TacticalPitch content={zonePass} onSubmit={(choice) => choices.push(choice)} />);
  await act(async () => { button(container, "패스").click(); });
  const target = container.querySelector('[role="button"][aria-label="동료 선수 teammate"]');
  assert.ok(target);
  await act(async () => { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });

  assert.deepEqual(choices, [{ actionType: "pass", destination: { x: 30, y: 50 } }]);
});

test("destination actions expose labeled keyboard-operable coordinate controls", async () => {
  setupMatchMedia(false);
  setupRaf();
  const choices: TacticalChoice[] = [];
  const noSetup = content({ setupTimeline: { durationMs: 0, decisionAtMs: 0, keyframes: [{ atMs: 0, players: {}, ball: { x: 50, y: 70 } }] } });
  const { container } = await render(<TacticalPitch content={noSetup} onSubmit={(choice) => choices.push(choice)} />);
  await act(async () => { button(container, "드리블").click(); });

  assert.ok(container.querySelector('input[type="range"][aria-label="도착 X 좌표"]'));
  assert.ok(container.querySelector('input[type="range"][aria-label="도착 Y 좌표"]'));
  await act(async () => { button(container, "좌표로 제출").click(); });
  assert.deepEqual(choices, [{ actionType: "dribble", destination: { x: 50, y: 50 } }]);
});

test("first miss renders only authored observe text and safe setup highlights", async () => {
  setupMatchMedia(true);
  setupRaf();
  const highlights: HighlightRef[] = [
    { kind: "player", id: "defender" },
    { kind: "zone", id: "space" },
    { kind: "path", id: "selected-path" },
  ];
  const { container } = await render(
    <TacticalPitch
      content={content()}
      observeText="검수된 관찰 단서"
      highlights={highlights}
      selectedPath={[{ x: 50, y: 70 }, { x: 40, y: 60 }]}
      prefersReducedMotion
      onSubmit={() => {}}
    />,
  );

  assert.match(container.textContent ?? "", /검수된 관찰 단서/);
  assert.ok(container.querySelector(".setup-player-highlight"));
  assert.ok(container.querySelector(".setup-zone-highlight"));
  assert.ok(container.querySelector(".selected-path.is-highlighted"));
  assert.equal(container.querySelector(".scenario-playback"), null);
  assert.equal(container.querySelector(".recommended-playback-path"), null);
});

test("explanation tabs use stable relationships and roving arrow-key focus", async () => {
  const explanations: CoachExplanation[] = [
    { kind: "observe", text: "관찰", fromMs: 0, toMs: 1, highlights: [{ kind: "player", id: "defender" }] },
    { kind: "benefit", text: "이점", fromMs: 1, toMs: 2, highlights: [{ kind: "zone", id: "space" }] },
    { kind: "risk", text: "위험", fromMs: 2, toMs: 3, highlights: [{ kind: "path", id: "selected-path" }] },
    { kind: "remember", text: "기억", fromMs: 3, toMs: 4, highlights: [{ kind: "path", id: "recommended-path" }] },
  ];
  const { container } = await render(
    <CoachExplanationPanel explanations={explanations} onSeek={() => {}} onHighlightsChange={() => {}} />,
  );
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  assert.equal(tabs[0].id, "explanation-tab-situation");
  assert.equal(tabs[0].getAttribute("aria-controls"), "explanation-panel-situation");
  assert.equal(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), tabs[0].id);
  assert.deepEqual(tabs.map((tab) => tab.tabIndex), [0, -1, -1]);

  tabs[0].focus();
  await act(async () => { tabs[0].dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })); });
  assert.equal(document.activeElement?.textContent, "판단");
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
});
