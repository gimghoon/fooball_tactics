import assert from "node:assert/strict";
import test from "node:test";

import { isPointInZone, normalizeClientPoint, segmentIntersectsCircle } from "../lib/domain/geometry.ts";
import { calculateMastery } from "../lib/domain/mastery.ts";
import {
  adaptLegacyPassScenario,
  assertReviewTransition,
  isScenarioPublishable,
  mapAttemptInputError,
  parseAttemptInput,
  parseScenarioContent,
  playableScenarios,
  reconstructAttemptInput,
  serializePublicScenarioContent,
  serializePublicTrainingScenario,
  toPublicScenarioContent,
  type ScenarioContent,
} from "../lib/domain/content.ts";
import { mergePendingEvents } from "../lib/domain/offline-queue.ts";
import { advanceRole, evaluateAttempt } from "../lib/domain/session.ts";
import { createRecoveryToken, hashRecoveryToken, normalizeNickname } from "../lib/domain/identity.ts";
import { evaluateScenarioAction } from "../lib/domain/scenario-judging.ts";
import { classifyPlayerTap, playerAriaLabel } from "../lib/domain/tactical-pitch.ts";
import {
  beginInitialPlayback,
  completePlayback,
  explanationStage,
  frameAt,
  initialExplanationIndex,
  restartPlayback,
  snapToKeyframe,
} from "../lib/domain/timeline.ts";

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
    decisionAtMs: 1200,
    keyframes: [
      { atMs: 0, players: {}, ball: { x: 50, y: 72 } },
      { atMs: 1200, players: { "defender-1": { x: 50, y: 65 } }, ball: { x: 50, y: 72 } },
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

test("returns exact reviewed timeline endpoints", () => {
  const timeline = {
    durationMs: 1000,
    decisionAtMs: 400,
    keyframes: [
      { atMs: 0, players: { d1: { x: 20, y: 20 } }, ball: { x: 50, y: 70 } },
      { atMs: 1000, players: { d1: { x: 40, y: 20 } }, ball: { x: 30, y: 50 } },
    ],
  };

  assert.deepEqual(frameAt(timeline, 0), timeline.keyframes[0]);
  assert.deepEqual(frameAt(timeline, 1000), timeline.keyframes[1]);
});

test("interpolates reviewed player and ball positions at a deterministic midpoint", () => {
  const timeline = {
    durationMs: 1000,
    decisionAtMs: 400,
    keyframes: [
      { atMs: 0, players: { d1: { x: 20, y: 20 } }, ball: { x: 50, y: 70 } },
      { atMs: 1000, players: { d1: { x: 40, y: 20 } }, ball: { x: 30, y: 50 } },
    ],
  };

  assert.deepEqual(frameAt(timeline, 500), {
    atMs: 500,
    players: { d1: { x: 30, y: 20 } },
    ball: { x: 40, y: 60 },
  });
});

test("carries the nearest defined player position between sparse keyframes", () => {
  const timeline = {
    durationMs: 1000,
    decisionAtMs: 400,
    keyframes: [
      { atMs: 0, players: { d1: { x: 20, y: 20 } }, ball: { x: 50, y: 70 } },
      { atMs: 1000, players: { d2: { x: 80, y: 20 } }, ball: { x: 30, y: 50 } },
    ],
  };

  assert.deepEqual(frameAt(timeline, 500).players, {
    d1: { x: 20, y: 20 },
    d2: { x: 80, y: 20 },
  });
});

test("materializes carried players at an exact sparse keyframe", () => {
  const timeline = {
    durationMs: 1000,
    decisionAtMs: 400,
    keyframes: [
      { atMs: 0, players: { d1: { x: 20, y: 20 } }, ball: { x: 50, y: 70 } },
      { atMs: 500, players: {}, ball: { x: 40, y: 60 } },
      { atMs: 1000, players: { d1: { x: 40, y: 20 } }, ball: { x: 30, y: 50 } },
    ],
  };

  assert.deepEqual(frameAt(timeline, 500).players, { d1: { x: 20, y: 20 } });
});

test("interpolates from carried positions across multiple sparse keyframes", () => {
  const timeline = {
    durationMs: 1000,
    decisionAtMs: 400,
    keyframes: [
      { atMs: 0, players: { d1: { x: 20, y: 20 } }, ball: { x: 50, y: 70 } },
      { atMs: 250, players: {}, ball: { x: 45, y: 65 } },
      { atMs: 750, players: {}, ball: { x: 35, y: 55 } },
      { atMs: 1000, players: { d1: { x: 40, y: 20 } }, ball: { x: 30, y: 50 } },
    ],
  };

  assert.deepEqual(frameAt(timeline, 875).players.d1, { x: 30, y: 20 });
});

test("clamps timeline playback to its duration without mutating keyframe order", () => {
  const later = { atMs: 1000, players: { d1: { x: 40, y: 20 } }, ball: { x: 30, y: 50 } };
  const earlier = { atMs: 0, players: { d1: { x: 20, y: 20 } }, ball: { x: 50, y: 70 } };
  const timeline = { durationMs: 1000, decisionAtMs: 400, keyframes: [later, earlier] };

  assert.deepEqual(frameAt(timeline, -100), earlier);
  assert.deepEqual(frameAt(timeline, 1500), later);
  assert.deepEqual(timeline.keyframes, [later, earlier]);
});

test("maps every reviewed explanation kind to its intended Korean review stage", () => {
  assert.deepEqual(
    ["observe", "benefit", "risk", "remember"].map((kind) => explanationStage(kind as "observe" | "benefit" | "risk" | "remember")),
    ["상황", "판단", "판단", "결과"],
  );
});

test("starts explanation review with the observe block regardless of authored order", () => {
  const reordered = [
    reviewedScenarioContent.explanations[2],
    reviewedScenarioContent.explanations[3],
    reviewedScenarioContent.explanations[0],
    reviewedScenarioContent.explanations[1],
  ];

  assert.equal(initialExplanationIndex(reordered), 2);
});

test("restarts an active playback with a new generation without relocking completed review", () => {
  const restarted = restartPlayback({
    currentMs: 700,
    playing: true,
    generation: 4,
    initialPlaybackComplete: true,
  });

  assert.deepEqual(restarted, {
    currentMs: 0,
    playing: true,
    generation: 5,
    initialPlaybackComplete: true,
  });
});

test("locks review controls until the initial playback completes and keeps them unlocked on replay", () => {
  const begun = beginInitialPlayback({
    currentMs: 900,
    playing: false,
    generation: 2,
    initialPlaybackComplete: true,
  });
  assert.equal(begun.initialPlaybackComplete, false);

  const completed = completePlayback(begun);
  assert.equal(completed.initialPlaybackComplete, true);
  assert.equal(restartPlayback(completed).initialPlaybackComplete, true);
});

test("snaps reduced-motion playback to the nearest authored keyframe", () => {
  const timeline = {
    durationMs: 1000,
    decisionAtMs: 400,
    keyframes: [
      { atMs: 0, players: {}, ball: { x: 50, y: 70 } },
      { atMs: 400, players: {}, ball: { x: 40, y: 60 } },
      { atMs: 900, players: {}, ball: { x: 30, y: 50 } },
    ],
  };

  assert.equal(snapToKeyframe(timeline, -100), 0);
  assert.equal(snapToKeyframe(timeline, 520), 400);
  assert.equal(snapToKeyframe(timeline, 800), 900);
  assert.equal(snapToKeyframe(timeline, 1200), 900);
});

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

test("rejects semantically unsafe reviewed answers and unusable decision state", () => {
  const invalidContents: unknown[] = [
    {
      ...reviewedScenarioContent,
      allowedActions: ["dribble"],
    },
    {
      ...reviewedScenarioContent,
      answer: {
        ...reviewedScenarioContent.answer,
        preferred: { actionType: "pass", target: { kind: "player", playerId: "defender-1" } },
      },
    },
    {
      ...reviewedScenarioContent,
      answer: {
        ...reviewedScenarioContent.answer,
        preferred: { actionType: "pass", target: { kind: "player", playerId: "fixo-1" } },
      },
    },
    {
      ...reviewedScenarioContent,
      allowedActions: ["dribble"],
      answer: {
        ...reviewedScenarioContent.answer,
        preferred: { actionType: "dribble", target: { kind: "player", playerId: "ala-left" } },
      },
    },
    {
      ...reviewedScenarioContent,
      answer: {
        ...reviewedScenarioContent.answer,
        alternatives: [{ actionType: "pass", target: { kind: "player", playerId: "ala-left" } }],
      },
    },
    {
      ...reviewedScenarioContent,
      explanations: reviewedScenarioContent.explanations.map((explanation, index) => (
        index === 0 ? { ...explanation, highlights: [] } : explanation
      )),
    },
    {
      ...reviewedScenarioContent,
      timeline: {
        ...reviewedScenarioContent.timeline,
        keyframes: reviewedScenarioContent.timeline.keyframes.filter(({ atMs }) => atMs !== reviewedScenarioContent.timeline.decisionAtMs),
      },
    },
  ];

  for (const content of invalidContents) {
    assert.equal(isScenarioPublishable(content), false);
    assert.throws(() => assertReviewTransition("reviewed", content));
  }
});

test("blocks publication until content and all review dimensions are complete", () => {
  assert.doesNotThrow(() => assertReviewTransition("pending", {
    ...reviewedScenarioContent,
    review: { sourceReviewed: false, timelineReviewed: false, explanationsReviewed: false },
  }));
  assert.doesNotThrow(() => assertReviewTransition("draft", {}));

  assert.throws(() => assertReviewTransition("reviewed", {
    ...reviewedScenarioContent,
    review: { ...reviewedScenarioContent.review, sourceReviewed: false },
  }), /출처/);
  assert.throws(() => assertReviewTransition("reviewed", {
    ...reviewedScenarioContent,
    review: { ...reviewedScenarioContent.review, timelineReviewed: false },
  }), /타임라인/);
  assert.throws(() => assertReviewTransition("reviewed", {
    ...reviewedScenarioContent,
    review: { ...reviewedScenarioContent.review, explanationsReviewed: false },
  }), /설명/);
  assert.throws(() => assertReviewTransition("reviewed", {
    ...reviewedScenarioContent,
    explanations: reviewedScenarioContent.explanations.slice(0, 3),
  }), /설명은 네 종류/);
  assert.throws(() => assertReviewTransition("reviewed", {
    ...reviewedScenarioContent,
    explanations: [{ ...reviewedScenarioContent.explanations[0], fromMs: 1800, toMs: 1200 }],
  }), /시간 범위/);
  assert.throws(() => assertReviewTransition("reviewed", {
    ...reviewedScenarioContent,
    explanations: [{
      ...reviewedScenarioContent.explanations[0],
      highlights: [{ kind: "player", id: "missing-player" }],
    }],
  }), /강조 대상/);
  assert.throws(() => assertReviewTransition("reviewed", ""), /콘텐츠 객체|JSON/);
});

test("rejects scenario content with unknown references or malformed JSON", () => {
  assert.throws(() => parseScenarioContent("{"), /시나리오/);
  assert.throws(() => parseScenarioContent(JSON.stringify({
    ...reviewedScenarioContent,
    explanations: [{ ...reviewedScenarioContent.explanations[0], highlights: [{ kind: "player", id: "missing-player" }] }],
  })), /강조 대상/);
  assert.throws(() => parseScenarioContent({
    ...reviewedScenarioContent,
    timeline: { ...reviewedScenarioContent.timeline, decisionAtMs: 2401 },
  }), /decisionAtMs/);
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
  assert.equal(toPublicScenarioContent(adapted).defenseType, null);
});

test("validates action-specific attempt payloads", () => {
  assert.throws(
    () => parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "dribble" }),
    /도착/,
  );
  assert.throws(
    () => parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "move", destination: { x: Infinity, y: 50 } }),
    /유한/,
  );
  assert.throws(
    () => parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "shoot" }),
    /행동/,
  );
  assert.throws(
    () => parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "pass" }),
    /대상|도착/,
  );
  assert.throws(
    () => parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "pass", targetPlayerId: "ala-left", destination: { x: 30, y: 50 } }),
    /하나만/,
  );
  assert.equal(
    parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "move", destination: { x: 40, y: 50 } }).actionType,
    "move",
  );
  assert.deepEqual(
    parseAttemptInput({ eventId: "e", scenarioId: "s", x: 40, y: 50 }),
    { eventId: "e", scenarioId: "s", x: 40, y: 50 },
  );
});

test("maps invalid attempt payloads to a bad-request response", () => {
  let invalid: unknown;
  try {
    parseAttemptInput({ eventId: "", scenarioId: "s", actionType: "move", destination: { x: 40, y: 50 } });
  } catch (error) {
    invalid = error;
  }

  assert.deepEqual(mapAttemptInputError(invalid), { error: "답안 eventId이 필요해요.", status: 400 });
  assert.equal(mapAttemptInputError(new Error("database failed")), null);
});

test("projects only pre-decision content for a reviewed scenario", () => {
  const publicContent = toPublicScenarioContent(reviewedScenarioContent);

  assert.deepEqual(publicContent, {
    defenseType: reviewedScenarioContent.defenseType,
    actorId: reviewedScenarioContent.actorId,
    allowedActions: reviewedScenarioContent.allowedActions,
    pitch: reviewedScenarioContent.pitch,
    setupTimeline: {
      durationMs: reviewedScenarioContent.timeline.decisionAtMs,
      decisionAtMs: reviewedScenarioContent.timeline.decisionAtMs,
      keyframes: [reviewedScenarioContent.timeline.keyframes[0], reviewedScenarioContent.timeline.keyframes[1]],
    },
  });
  assert.equal("answer" in publicContent, false);
  assert.equal("review" in publicContent, false);
});

test("withholds incompletely reviewed structured content while preserving legacy compatibility", () => {
  for (const reviewFlag of ["sourceReviewed", "timelineReviewed", "explanationsReviewed"] as const) {
    const structured = serializePublicScenarioContent({
      contentJson: JSON.stringify({
        ...reviewedScenarioContent,
        review: { ...reviewedScenarioContent.review, [reviewFlag]: false },
      }),
      pitchJson: JSON.stringify(reviewedScenarioContent.pitch),
      answerJson: JSON.stringify(reviewedScenarioContent.answer),
    });
    assert.equal(structured, null);
  }
  const legacy = serializePublicScenarioContent({
    contentJson: "",
    pitchJson: JSON.stringify({ players: [], ball: { x: 50, y: 80 } }),
    answerJson: JSON.stringify({ kind: "circle", cx: 30, cy: 50, radius: 8 }),
  });

  assert.equal(JSON.parse(legacy ?? "{}").defenseType, null);
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

test("normalizes unpadded pitch edges and center to the matching viewBox coordinates", () => {
  const bounds = { left: 10, top: 20, width: 400, height: 400 };

  assert.deepEqual(normalizeClientPoint({ x: 10, y: 20 }, bounds), { x: 0, y: 0 });
  assert.deepEqual(normalizeClientPoint({ x: 210, y: 220 }, bounds), { x: 50, y: 50 });
  assert.deepEqual(normalizeClientPoint({ x: 410, y: 420 }, bounds), { x: 100, y: 100 });
});

test("classifies player taps from the actor's team and keeps dribble and move taps as destinations", () => {
  const actor = { id: "defender-1", x: 50, y: 58, team: "them" as const };
  const teammate = { id: "defender-2", x: 58, y: 60, team: "them" as const };
  const opponent = { id: "ala-left", x: 24, y: 52, team: "us" as const };

  assert.equal(classifyPlayerTap("pass", actor, teammate), "pass-target");
  assert.equal(classifyPlayerTap("pass", actor, opponent), "ignore");
  assert.equal(classifyPlayerTap("pass", actor, actor), "ignore");
  assert.equal(playerAriaLabel(actor, teammate), "동료 선수 defender-2");
  assert.equal(playerAriaLabel(actor, opponent), "상대 선수 ala-left");
  assert.equal(classifyPlayerTap("dribble", actor, opponent), "destination");
  assert.equal(classifyPlayerTap("move", actor, teammate), "destination");
});

test("projects training props without pre-attempt feedback", () => {
  const projected = serializePublicTrainingScenario({
    id: "scenario-1",
    campaignId: "campaign-1",
    role: "fixo",
    principle: "support",
    prompt: "어디로 움직일까요?",
    hint: "수비수의 위치를 보세요.",
    explanation: "정답은 반대편입니다.",
    pitchJson: JSON.stringify(reviewedScenarioContent.pitch),
    answerJson: JSON.stringify(reviewedScenarioContent.answer),
    contentJson: JSON.stringify(reviewedScenarioContent),
    orderIndex: 1,
  });

  assert.deepEqual(projected, {
    id: "scenario-1",
    campaignId: "campaign-1",
    role: "fixo",
    principle: "support",
    prompt: "어디로 움직일까요?",
    contentJson: JSON.stringify(toPublicScenarioContent(reviewedScenarioContent)),
    orderIndex: 1,
  });
  assert.equal("hint" in (projected ?? {}), false);
  assert.equal("explanation" in (projected ?? {}), false);
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

test("judges a pass by destination when the reviewed target is a zone", () => {
  const zonePassContent: ScenarioContent = {
    ...reviewedScenarioContent,
    allowedActions: ["pass"],
    answer: {
      preferred: { actionType: "pass", target: { kind: "zone", zone: { kind: "circle", cx: 30, cy: 50, radius: 5 } } },
      alternatives: [],
      hazards: [],
    },
  };

  assert.deepEqual(
    evaluateScenarioAction(zonePassContent, { actionType: "pass", destination: { x: 30, y: 50 } }),
    {
      correct: true,
      grade: "preferred",
      selectedPath: [{ x: 50, y: 72 }, { x: 30, y: 50 }],
      recommended: zonePassContent.answer.preferred,
      reason: null,
    },
  );
});

test("reconstructs retries from the exact persisted path instead of rounded coordinates", () => {
  const boundaryContent: ScenarioContent = {
    ...reviewedScenarioContent,
    allowedActions: ["dribble"],
    answer: {
      preferred: { actionType: "dribble", target: { kind: "zone", zone: { kind: "circle", cx: 60, cy: 72, radius: 10 } } },
      alternatives: [],
      hazards: [],
    },
  };
  const reconstructed = reconstructAttemptInput(
    { eventId: "event", scenarioId: "scenario" },
    {
      actionType: "dribble",
      targetPlayerId: null,
      pathJson: JSON.stringify([{ x: 50, y: 72 }, { x: 70.004, y: 72 }]),
    },
  );

  assert.deepEqual(reconstructed, {
    eventId: "event",
    scenarioId: "scenario",
    actionType: "dribble",
    destination: { x: 70.004, y: 72 },
  });
  assert.equal(evaluateScenarioAction(boundaryContent, reconstructed).correct, false);
  assert.equal(evaluateScenarioAction(boundaryContent, { ...reconstructed, destination: { x: 70, y: 72 } }).correct, true);
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
