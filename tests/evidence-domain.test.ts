import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCardReviewTransition,
  computeEvidenceVersion,
  parseBundleInput,
  parseTacticCardContent,
  parseVideoClip,
  type TacticCardContent,
} from "../lib/domain/evidence.ts";

function validCard(overrides: Partial<TacticCardContent> = {}): TacticCardContent {
  return {
    situation: "중앙 압박을 받는 알라",
    conditions: ["측면 지원 가능"],
    defenseType: "front_press",
    cues: ["수비수가 공 쪽으로 전진"],
    preferred: [{ action: "pass", reason: "측면 지원", citationIds: ["chunk-1"] }],
    alternatives: [],
    risky: [],
    confidence: "high",
    uncertainties: [],
    conflicts: [],
    scenarioSuitable: true,
    animationSuitable: true,
    ...overrides,
  };
}

test("video clips require HTTPS and increasing timecodes", () => {
  assert.throws(() => parseVideoClip({ url: "http://x.test/v", startMs: 0, endMs: 10, observation: "압박" }));
  assert.throws(() => parseVideoClip({ url: "https://x.test/v", startMs: 10, endMs: 10, observation: "압박" }));
  assert.deepEqual(parseVideoClip({ url: "https://x.test/v", startMs: 0, endMs: 10, observation: "압박" }).startMs, 0);
});

test("a reviewable card requires supported actions and reasons", () => {
  const card = validCard({ preferred: [{ action: "pass", reason: "측면 지원", citationIds: [] }] });
  assert.throws(() => assertCardReviewTransition("owner_reviewed", card, new Set(["chunk-1"])));
});

test("bundle inputs require a title and analysis purpose", () => {
  assert.throws(() => parseBundleInput({ title: "", purpose: "압박 대응 분석" }));
  assert.deepEqual(parseBundleInput({ title: "코치 노트", purpose: "압박 대응 분석" }), {
    title: "코치 노트",
    purpose: "압박 대응 분석",
  });
});

test("tactic card content rejects an unsupported defense type", () => {
  assert.throws(() => parseTacticCardContent({ ...validCard(), defenseType: "unknown" }));
});

test("evidence versions are stable across source and clip ordering", async () => {
  const first = await computeEvidenceVersion({
    sourceHashes: ["source-b", "source-a"],
    clips: [
      { url: "https://x.test/b", startMs: 100, endMs: 200, observation: "두 번째" },
      { url: "https://x.test/a", startMs: 0, endMs: 50, observation: "첫 번째" },
    ],
    analyzerModel: "model-1",
    promptVersion: "prompt-1",
    schemaVersion: "schema-1",
  });
  const second = await computeEvidenceVersion({
    sourceHashes: ["source-a", "source-b"],
    clips: [
      { url: "https://x.test/a", startMs: 0, endMs: 50, observation: "첫 번째" },
      { url: "https://x.test/b", startMs: 100, endMs: 200, observation: "두 번째" },
    ],
    analyzerModel: "model-1",
    promptVersion: "prompt-1",
    schemaVersion: "schema-1",
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
});
