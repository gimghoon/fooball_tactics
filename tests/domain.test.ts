import assert from "node:assert/strict";
import test from "node:test";

import { isPointInZone, normalizeClientPoint } from "../lib/domain/geometry.ts";
import { calculateMastery } from "../lib/domain/mastery.ts";
import { playableScenarios } from "../lib/domain/content.ts";
import { mergePendingEvents } from "../lib/domain/offline-queue.ts";
import { advanceRole, evaluateAttempt } from "../lib/domain/session.ts";
import { createRecoveryToken, hashRecoveryToken, normalizeNickname } from "../lib/domain/identity.ts";

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
