import assert from "node:assert/strict";
import test from "node:test";

import { handleReviewRequest } from "../lib/server/scenario-review-route.ts";

const reviewedContent = JSON.stringify({
  defenseType: "front_press",
  actorId: "actor",
  allowedActions: ["pass"],
  pitch: {
    players: [
      { id: "actor", x: 50, y: 70, team: "us" },
      { id: "teammate", x: 30, y: 50, team: "us" },
    ],
    ball: { x: 50, y: 70 },
    zones: [{ id: "space", zone: { kind: "circle", cx: 30, cy: 50, radius: 5 } }],
  },
  answer: {
    preferred: { actionType: "pass", target: { kind: "player", playerId: "teammate" } },
    alternatives: [],
    hazards: [],
  },
  timeline: {
    durationMs: 1000,
    decisionAtMs: 500,
    keyframes: [
      { atMs: 0, players: {}, ball: { x: 50, y: 70 } },
      { atMs: 500, players: {}, ball: { x: 50, y: 70 } },
      { atMs: 1000, players: {}, ball: { x: 30, y: 50 } },
    ],
  },
  explanations: [
    { kind: "observe", text: "관찰", fromMs: 0, toMs: 250, highlights: [{ kind: "player", id: "teammate" }] },
    { kind: "benefit", text: "이점", fromMs: 250, toMs: 500, highlights: [{ kind: "zone", id: "space" }] },
    { kind: "risk", text: "위험", fromMs: 500, toMs: 750, highlights: [{ kind: "path", id: "selected-path" }] },
    { kind: "remember", text: "기억", fromMs: 750, toMs: 1000, highlights: [{ kind: "path", id: "recommended-path" }] },
  ],
  review: { sourceReviewed: true, timelineReviewed: true, explanationsReviewed: true },
});

type Update = Record<string, unknown>;

function request(status: string, extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/content/scenarios/scenario-1/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-review-key": "secret" },
    body: JSON.stringify({ status, ...extra }),
  });
}

function dependencies(options: { found?: boolean } = {}) {
  const updates: { id: string; values: Update }[] = [];
  return {
    updates,
    dependencies: {
      env: { CONTENT_REVIEW_KEY: "secret", CONTENT_REVIEWER_NAME: "서버 검수자" },
      now: () => new Date("2026-08-16T01:02:03.000Z"),
      findScenario: async () => options.found === false ? undefined : { contentJson: reviewedContent },
      updateScenario: async (id: string, values: Update) => { updates.push({ id, values }); },
    },
  };
}

test("reviewed transition atomically records server reviewer and required source provenance", async () => {
  const harness = dependencies();
  const response = await handleReviewRequest(
    request("reviewed", {
      sourceTitle: "  코치 원문  ",
      sourceUrl: " https://example.com/source ",
      reviewerName: "클라이언트 위조자",
    }),
    { params: Promise.resolve({ id: "scenario-1" }) },
    harness.dependencies,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(harness.updates, [{
    id: "scenario-1",
    values: {
      reviewStatus: "reviewed",
      sourceTitle: "코치 원문",
      sourceUrl: "https://example.com/source",
      reviewerName: "서버 검수자",
      reviewedAt: new Date("2026-08-16T01:02:03.000Z"),
    },
  }]);
});

test("review authority requires a server-configured reviewer name paired with the key", async () => {
  const harness = dependencies();
  const response = await handleReviewRequest(
    request("pending"),
    { params: Promise.resolve({ id: "scenario-1" }) },
    { ...harness.dependencies, env: { CONTENT_REVIEW_KEY: "secret", CONTENT_REVIEWER_NAME: "" } },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(harness.updates, []);
});

test("reviewed transition rejects empty source provenance without updating", async () => {
  const harness = dependencies();
  const response = await handleReviewRequest(
    request("reviewed", { sourceTitle: " ", sourceUrl: "" }),
    { params: Promise.resolve({ id: "scenario-1" }) },
    harness.dependencies,
  );

  assert.equal(response.status, 409);
  assert.deepEqual(harness.updates, []);
});

test("draft and pending transitions invalidate every review audit field", async () => {
  for (const status of ["draft", "pending"] as const) {
    const harness = dependencies();
    const response = await handleReviewRequest(
      request(status),
      { params: Promise.resolve({ id: "scenario-1" }) },
      harness.dependencies,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(harness.updates[0]?.values, {
      reviewStatus: status,
      sourceTitle: null,
      sourceUrl: null,
      reviewerName: null,
      reviewedAt: null,
    });
  }
});

test("every review status returns 404 for a nonexistent scenario", async () => {
  for (const status of ["draft", "pending", "reviewed"] as const) {
    const harness = dependencies({ found: false });
    const response = await handleReviewRequest(
      request(status, { sourceTitle: "출처", sourceUrl: "https://example.com/source" }),
      { params: Promise.resolve({ id: "missing" }) },
      harness.dependencies,
    );

    assert.equal(response.status, 404);
    assert.deepEqual(harness.updates, []);
  }
});
