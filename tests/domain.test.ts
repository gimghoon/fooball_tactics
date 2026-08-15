import assert from "node:assert/strict";
import test from "node:test";

import { isPointInZone, normalizeClientPoint, segmentIntersectsCircle } from "../lib/domain/geometry.ts";
import { calculateMastery } from "../lib/domain/mastery.ts";
import {
  adaptLegacyPassScenario,
  isScenarioPublishable,
  parseScenarioContent,
  playableScenarios,
  toPublicScenarioContent,
  type ScenarioContent,
} from "../lib/domain/content.ts";
import { mergePendingEvents } from "../lib/domain/offline-queue.ts";
import { advanceRole, evaluateAttempt } from "../lib/domain/session.ts";
import { createRecoveryToken, hashRecoveryToken, normalizeNickname } from "../lib/domain/identity.ts";
import { evaluateScenarioAction } from "../lib/domain/scenario-judging.ts";

const reviewedScenarioContent: ScenarioContent = {
  defenseType: "front_press",
  actorId: "fixo-1",
  allowedActions: ["pass", "dribble", "move"],
  pitch: {
    players: [
      { id: "fixo-1", x: 50, y: 72, team: "us" },
      { id: "ala-left", x: 24, y: 52, team: "us" },
      { id: "defender-1", x: 50, y: 58, team: "them" },
    ],
    ball: { x: 50, y: 72 },
    zones: [{ id: "weak-side", zone: { kind: "circle", cx: 24, cy: 52, radius: 9 } }],
  },
  answer: {
    preferred: { actionType: "pass", target: { kind: "player", playerId: "ala-left" } },
    alternatives: [],
    hazards: [],
  },
  timeline: {
    durationMs: 2400,
    keyframes: [
      { atMs: 0, players: {}, ball: { x: 50, y: 72 } },
      { atMs: 2400, players: { "defender-1": { x: 50, y: 65 } }, ball: { x: 24, y: 52 } },
    ],
  },
  explanations: [
    { kind: "observe", text: "압박 방향을 확인하세요.", fromMs: 0, toMs: 800, highlights: [{ kind: "player", id: "defender-1" }] },
    { kind: "benefit", text: "열린 동료를 활용합니다.", fromMs: 800, toMs: 1600, highlights: [{ kind: "player", id: "ala-left" }] },
    { kind: "risk", text: "중앙 전진은 압박에 갇힙니다.", fromMs: 800, toMs: 1600, highlights: [{ kind: "path", id: "selected-path" }] },
    { kind: "remember", text: "압박 반대편을 먼저 본다.", fromMs: 1600, toMs: 2400, highlights: [{ kind: "zone", id: "weak-side" }] },
  ],
  review: { sourceReviewed: true, timelineReviewed: true, explanationsReviewed: true },
};

test("publishes only complete coach-reviewed scenario content", () => {
  assert.equal(isScenarioPublishable(reviewedScenarioContent), true);
  assert.equal(isScenarioPublishable({
    ...reviewedScenarioContent,
    review: { ...reviewedScenarioContent.review, timelineReviewed: false },
  }), false);
  assert.equal(isScenarioPublishable({
    ...reviewedScenarioContent,
    explanations: reviewedScenarioContent.explanations.slice(0, 3),
  }), false);
});

test("rejects scenario content with unknown references or malformed JSON", () => {
  assert.throws(() => parseScenarioContent("{"), /시나리오/);
  assert.throws(() => parseScenarioContent(JSON.stringify({
    ...reviewedScenarioContent,
    explanations: [{ ...reviewedScenarioContent.explanations[0], highlights: [{ kind: "player", id: "missing-player" }] }],
  })), /강조 대상/);
});

test("adapts legacy pitch and circle answer JSON to a pass scenario without coach explanations", () => {
  const adapted = adaptLegacyPassScenario({
    pitchJson: JSON.stringify({
      players: [{ x: 50, y: 80, team: "us" }, { x: 30, y: 50, team: "us" }],
      ball: { x: 50, y: 80 },
    }),
    answerJson: JSON.stringify({ kind: "circle", cx: 30, cy: 50, radius: 8 }),
  });

  assert.equal(adapted.allowedActions[0], "pass");
  assert.equal(adapted.answer.preferred.actionType, "pass");
  assert.deepEqual(adapted.answer.preferred.target, { kind: "zone", zone: { kind: "circle", cx: 30, cy: 50, radius: 8 } });
  assert.deepEqual(adapted.explanations, []);
  assert.equal(adapted.review.explanationsReviewed, false);
});

test("projects only pre-decision content for a reviewed scenario", () => {
  const publicContent = toPublicScenarioContent(reviewedScenarioContent);

  assert.deepEqual(publicContent, {
    defenseType: reviewedScenarioContent.defenseType,
    actorId: reviewedScenarioContent.actorId,
    allowedActions: reviewedScenarioContent.allowedActions,
    pitch: reviewedScenarioContent.pitch,
    setupTimeline: {
      durationMs: reviewedScenarioContent.timeline.durationMs,
      keyframes: [reviewedScenarioContent.timeline.keyframes[0]],
    },
  });
  assert.equal("answer" in publicContent, false);
  assert.equal("review" in publicContent, false);
});

test("accepts points inside and on the boundary of a circular answer zone", () => {
  const zone = { kind: "circle" as const, cx: 60, cy: 35, radius: 10 };

  assert.equal(isPointInZone({ x: 60, y: 35 }, zone), true);
  assert.equal(isPointInZone({ x: 70, y: 35 }, zone), true);
  assert.equal(isPointInZone({ x: 70.01, y: 35 }, zone), false);
});

test("normalizes client touches into the pitch viewBox", () => {
  assert.deepEqual(
    normalizeClientPoint({ x: 210, y: 310 }, { left: 10, top: 10, width: 400, height: 600 }),
    { x: 50, y: 50 },
  );
});

test("counts a path touching a hazard boundary as unsafe", () => {
  assert.equal(
    segmentIntersectsCircle({ x: 10, y: 20 }, { x: 90, y: 20 }, { kind: "circle", cx: 50, cy: 30, radius: 10 }),
    true,
  );
});

test("judges a pass by action type and teammate target", () => {
  const result = evaluateScenarioAction(reviewedScenarioContent, {
    actionType: "pass",
    targetPlayerId: "ala-left",
  });

  assert.deepEqual(result, {
    correct: true,
    grade: "preferred",
    selectedPath: [{ x: 50, y: 72 }, { x: 24, y: 52 }],
    recommended: reviewedScenarioContent.answer.preferred,
    reason: null,
  });
});

test("requires a pass target to share the actor's team", () => {
  const themActorContent: ScenarioContent = {
    ...reviewedScenarioContent,
    actorId: "defender-1",
    pitch: {
      ...reviewedScenarioContent.pitch,
      players: [
        ...reviewedScenarioContent.pitch.players,
        { id: "defender-2", x: 58, y: 60, team: "them" },
      ],
    },
    answer: {
      ...reviewedScenarioContent.answer,
      preferred: { actionType: "pass", target: { kind: "player", playerId: "ala-left" } },
    },
  };

  assert.equal(
    evaluateScenarioAction(themActorContent, { actionType: "pass", targetPlayerId: "ala-left" }).correct,
    false,
  );

  const sameTeamContent: ScenarioContent = {
    ...themActorContent,
    answer: {
      ...themActorContent.answer,
      preferred: { actionType: "pass", target: { kind: "player", playerId: "defender-2" } },
    },
  };
  assert.equal(
    evaluateScenarioAction(sameTeamContent, { actionType: "pass", targetPlayerId: "defender-2" }).correct,
    true,
  );
});

test("judges action type, target, and path together", () => {
  const dribbleContent: ScenarioContent = {
    ...reviewedScenarioContent,
    allowedActions: ["dribble", "pass"],
    answer: {
      preferred: { actionType: "dribble", target: { kind: "zone", zone: { kind: "circle", cx: 70, cy: 70, radius: 8 } } },
      alternatives: [],
      hazards: [{ kind: "circle", cx: 60, cy: 58, radius: 5 }],
    },
  };
  assert.equal(evaluateScenarioAction(dribbleContent, { actionType: "dribble", destination: { x: 70, y: 70 } }).correct, true);
  assert.equal(evaluateScenarioAction(dribbleContent, { actionType: "pass", targetPlayerId: "ala-left" }).correct, false);
});

test("calculates mastery from correct attempts without rewarding duplicate retries", () => {
  const mastery = calculateMastery([
    { principle: "width", correct: false, eventId: "a" },
    { principle: "width", correct: true, eventId: "b" },
    { principle: "width", correct: true, eventId: "b" },
    { principle: "transition", correct: true, eventId: "c" },
  ]);

  assert.deepEqual(mastery, { width: 50, transition: 100 });
});

test("only exposes coach-reviewed scenarios", () => {
  const scenarios = playableScenarios([
    { id: "reviewed", reviewStatus: "reviewed" as const },
    { id: "draft", reviewStatus: "draft" as const },
    { id: "pending", reviewStatus: "pending" as const },
  ]);

  assert.deepEqual(scenarios.map((scenario) => scenario.id), ["reviewed"]);
});

test("merges offline events idempotently and preserves order", () => {
  const merged = mergePendingEvents(
    [{ eventId: "a", answer: "move" }],
    [
      { eventId: "a", answer: "move" },
      { eventId: "b", answer: "pass" },
    ],
  );

  assert.deepEqual(merged.map((event) => event.eventId), ["a", "b"]);
});

test("rotates through fixo, ala, and pivo before the team recap", () => {
  assert.equal(advanceRole("fixo"), "ala");
  assert.equal(advanceRole("ala"), "pivo");
  assert.equal(advanceRole("pivo"), "recap");
});

test("reveals a hint after one miss and the answer after two misses", () => {
  assert.deepEqual(evaluateAttempt(false, 0), { misses: 1, feedback: "hint" });
  assert.deepEqual(evaluateAttempt(false, 1), { misses: 2, feedback: "answer" });
  assert.deepEqual(evaluateAttempt(true, 1), { misses: 1, feedback: "correct" });
});

test("normalizes room nicknames and rejects unsafe lengths", () => {
  assert.equal(normalizeNickname("  킥오프   민수  "), "킥오프 민수");
  assert.throws(() => normalizeNickname(" "), /닉네임/);
  assert.throws(() => normalizeNickname("12345678901234567"), /16자/);
});

test("stores a one-way recovery token hash", async () => {
  const token = createRecoveryToken();
  const hash = await hashRecoveryToken(token);

  assert.ok(token.length >= 32);
  assert.notEqual(hash, token);
  assert.equal(hash, await hashRecoveryToken(token));
});
