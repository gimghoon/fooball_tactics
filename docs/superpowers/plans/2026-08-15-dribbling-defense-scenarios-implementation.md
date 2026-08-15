# Dribbling and Defense Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend TACTIQ scenarios so players choose pass, dribble, or off-ball movement against six structured defensive situations and learn from coach-reviewed, deterministic animation and explanations.

**Architecture:** Shared TypeScript content contracts describe pitch state, action answers, defensive context, keyframe timelines, and linked coach explanations. Pure domain functions validate content and judge targets and paths; route handlers persist the selected action and return safe reviewed feedback. The client keeps orchestration in `CampaignPlayer` while focused pitch and result-review components render the interactive action and deterministic timeline.

**Tech Stack:** React 19, TypeScript 5.9, SVG, vinext/Next-compatible route handlers, Cloudflare D1, Drizzle ORM, Node test runner.

## Global Constraints

- Only content whose source, explanation blocks, and animation timeline have all passed coach review may be published.
- Do not create or publish tactical answers before coach material is supplied and reviewed.
- Supported action types are exactly `pass`, `dribble`, and `move`.
- Supported defense types are exactly `front_press`, `central_block`, `wide_funnel`, `one_v_one`, `numerical_advantage`, and `numerical_disadvantage`.
- Dribble and movement paths use a deterministic straight segment from the actor's start point to the touched destination; touching a hazard boundary counts as entering the hazard.
- Feedback playback is deterministic structured keyframes, not AI-generated animation or a physics simulation.
- Reduced-motion users see keyframe endpoints and arrows without interpolated movement.
- Existing reviewed pass-only scenarios remain playable after migration.
- Real-time free control, coach video upload, goalkeeper decisions, and user-authored tactics remain out of scope.

---

### Task 0: Preserve and preview the existing Site

**Files:**
- Inspect: `app/page.tsx`
- Inspect: `app/layout.tsx`
- Inspect: `app/globals.css`
- Inspect: `.openai/hosting.json`

**Interfaces:**
- Consumes: the existing TACTIQ product surface and its current Sites project binding.
- Produces: one retained local development process and one stable Codex browser tab reused through implementation and publishing.

- [ ] **Step 1: Verify the existing Site before product edits**

Run: `npm run build`

Expected: the current TACTIQ app builds successfully without changing source files.

- [ ] **Step 2: Start and retain the local development process**

Run: `npm run dev`

Expected: vinext prints a Local URL and remains running. Keep this process alive through implementation and the final build.

- [ ] **Step 3: Hand off the current meaningful preview**

Make one lightweight request to the exact Local URL and require a non-error response, then use the Sites browser handoff to open that URL once. Record and reuse the returned browser-tab ID; do not open additional tabs or replace the working TACTIQ page with starter content.

---

### Task 1: Shared scenario contracts and publication validation

**Files:**
- Modify: `lib/domain/content.ts`
- Modify: `tests/domain.test.ts`

**Interfaces:**
- Produces: `ActionType`, `DefenseType`, `PitchState`, `ScenarioAnswer`, `ScenarioTimeline`, `CoachExplanation`, and `ScenarioContent` types.
- Produces: `parseScenarioContent(input): ScenarioContent` and `isScenarioPublishable(input): boolean`.
- Consumes: no application modules; this task is the contract used by every later task.

- [ ] **Step 1: Write failing contract and publication-gate tests**

Add imports and fixtures to `tests/domain.test.ts` that cover a complete reviewed scenario and malformed JSON. The complete fixture must contain all four explanation kinds and valid highlight references:

```ts
import {
  isScenarioPublishable,
  parseScenarioContent,
  type ScenarioContent,
} from "../lib/domain/content.ts";

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
```

- [ ] **Step 2: Run the tests and verify the new imports fail**

Run: `node --experimental-strip-types --test tests/domain.test.ts`

Expected: FAIL because the new types and validation functions are not exported.

- [ ] **Step 3: Implement exact content contracts and runtime validation**

In `lib/domain/content.ts`, retain `ReviewStatus` and `playableScenarios`, then add discriminated unions for player and zone targets, named visual references, `TimelineKeyframe`, and the four explanation kinds. Implement `parseScenarioContent` to parse a string or accept an object, assert coordinate and time values are finite, require exactly one non-empty explanation per kind, verify every player/zone/path highlight against its corresponding visual ID, verify `0 <= fromMs <= toMs <= durationMs`, and return the typed value. Implement `isScenarioPublishable` as a catch-safe wrapper that additionally requires all three review flags to be `true`.

```ts
export type ActionType = "pass" | "dribble" | "move";
export type DefenseType = "front_press" | "central_block" | "wide_funnel" | "one_v_one" | "numerical_advantage" | "numerical_disadvantage";
export type ExplanationKind = "observe" | "benefit" | "risk" | "remember";
export type HighlightRef =
  | { kind: "player"; id: string }
  | { kind: "zone"; id: string }
  | { kind: "path"; id: "selected-path" | "recommended-path" };

export type ScenarioTarget =
  | { kind: "player"; playerId: string }
  | { kind: "zone"; zone: { kind: "circle"; cx: number; cy: number; radius: number } };

export type ScenarioContent = {
  defenseType: DefenseType;
  actorId: string;
  allowedActions: ActionType[];
  pitch: PitchState;
  answer: ScenarioAnswer;
  timeline: ScenarioTimeline;
  explanations: CoachExplanation[];
  review: { sourceReviewed: boolean; timelineReviewed: boolean; explanationsReviewed: boolean };
};
```

`PitchState` includes `zones: { id: string; zone: CircleZone }[]`, and `CoachExplanation.highlights` is `HighlightRef[]`. The fixture's `weak-side` zone must therefore also be present in `pitch.zones`; the parser rejects duplicate visual IDs.

- [ ] **Step 4: Run domain tests and verify they pass**

Run: `node --experimental-strip-types --test tests/domain.test.ts`

Expected: all domain tests PASS, including incomplete review and bad-reference cases.

- [ ] **Step 5: Commit the shared contracts**

```bash
git add lib/domain/content.ts tests/domain.test.ts
git commit -m "feat: define reviewed tactical scenario content"
```

---

### Task 2: Target and path judging domain

**Files:**
- Modify: `lib/domain/geometry.ts`
- Create: `lib/domain/scenario-judging.ts`
- Modify: `tests/domain.test.ts`

**Interfaces:**
- Consumes: `ActionType`, `PitchState`, and `ScenarioAnswer` from `lib/domain/content.ts`.
- Produces: `segmentIntersectsCircle(start, end, zone): boolean`.
- Produces: `evaluateScenarioAction(content, input): ActionEvaluation`, where `input` is `{ actionType: ActionType; targetPlayerId?: string; destination?: Point }` and the result is `{ correct: boolean; grade: "preferred" | "alternative" | "incorrect"; selectedPath: Point[] | null; recommended: ScenarioAction; reason: string | null }`.

- [ ] **Step 1: Write failing judging tests**

Add tests for matching a pass target, matching a dribble destination, rejecting an action type mismatch, and treating hazard tangency as unsafe:

```ts
import { segmentIntersectsCircle } from "../lib/domain/geometry.ts";
import { evaluateScenarioAction } from "../lib/domain/scenario-judging.ts";

test("counts a path touching a hazard boundary as unsafe", () => {
  assert.equal(
    segmentIntersectsCircle({ x: 10, y: 20 }, { x: 90, y: 20 }, { kind: "circle", cx: 50, cy: 30, radius: 10 }),
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
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --experimental-strip-types --test --test-name-pattern="path|judges action" tests/domain.test.ts`

Expected: FAIL because the geometry and judging exports do not exist.

- [ ] **Step 3: Implement segment collision and action evaluation**

Implement segment-to-circle distance using a clamped projection. Use `distance <= radius`, so boundary contact returns `true`. In `evaluateScenarioAction`, resolve the actor's start point from `content.pitch.players`, require a teammate target for pass, require a destination for dribble/move, match the preferred action before alternatives, and reject any matching dribble/move whose straight selected path intersects a hazard.

```ts
const t = Math.max(0, Math.min(1, dot / lengthSquared));
const closest = { x: start.x + t * dx, y: start.y + t * dy };
return Math.hypot(closest.x - zone.cx, closest.y - zone.cy) <= zone.radius;
```

For an accepted alternative, set `correct: true`, `grade: "alternative"`, and return that alternative's coach-authored reason. Never invent a tactical reason in this function.

- [ ] **Step 4: Run all domain tests**

Run: `node --experimental-strip-types --test tests/domain.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit the judging domain**

```bash
git add lib/domain/geometry.ts lib/domain/scenario-judging.ts tests/domain.test.ts
git commit -m "feat: judge pass dribble and movement actions"
```

---

### Task 3: Persist structured scenario content and selected actions

**Files:**
- Modify: `db/schema.ts`
- Create: `drizzle/0001_dribbling_defense_scenarios.sql` (generated; use the actual generated filename if Drizzle assigns a different slug)
- Modify: `app/api/campaigns/[id]/route.ts`
- Modify: `app/train/[campaignId]/page.tsx`

**Interfaces:**
- Consumes: serialized `ScenarioContent` validated by `parseScenarioContent`.
- Produces: `scenarios.contentJson`, `attempts.actionType`, `attempts.targetPlayerId`, and nullable `attempts.pathJson` columns.
- Produces: campaign scenario payload with `contentJson`; `answerJson` remains server-only.

- [ ] **Step 1: Extend the Drizzle schema**

Add `contentJson` to `scenarios` with a non-null default compatible with existing rows, and action details to `attempts`:

```ts
contentJson: text("content_json").notNull().default(""),
// attempts
actionType: text("action_type", { enum: ["pass", "dribble", "move"] }).notNull().default("pass"),
targetPlayerId: text("target_player_id"),
pathJson: text("path_json"),
```

Existing rows with empty `contentJson` are interpreted through the compatibility adapter in Task 4; do not mark them coach-reviewed on the basis of the empty field.

- [ ] **Step 2: Generate and inspect the migration**

Run: `npm run db:generate`

Expected: a new migration adds the four columns without dropping existing tables or data. Open the generated SQL and confirm all additions use `ALTER TABLE ... ADD`.

- [ ] **Step 3: Expose reviewed content without leaking answers**

In both campaign serializers, include a public content projection containing defense type, actor, allowed actions, pitch, and pre-decision timeline keyframes. Do not send `answer`, hazards, explanation blocks, review flags, or post-decision result keyframes before an attempt is evaluated. When `contentJson === ""`, explicitly call `adaptLegacyPassScenario` before projecting so existing reviewed pass-only rows remain playable; keep the existing pass-only fields during this compatibility period.

Define the projection in `lib/domain/content.ts` as:

```ts
export type PublicScenarioContent = Pick<ScenarioContent, "defenseType" | "actorId" | "allowedActions" | "pitch"> & {
  setupTimeline: ScenarioTimeline;
};

export function toPublicScenarioContent(content: ScenarioContent): PublicScenarioContent;
```

- [ ] **Step 4: Verify type-checking through a production build**

Run: `npm run build`

Expected: build succeeds and the training page can serialize the new public content shape.

- [ ] **Step 5: Commit schema and read-model changes**

```bash
git add db/schema.ts drizzle app/api/campaigns/'[id]'/route.ts app/train/'[campaignId]'/page.tsx lib/domain/content.ts
git commit -m "feat: store structured defensive scenarios"
```

---

### Task 4: Submit and return structured action feedback

**Files:**
- Modify: `app/api/attempts/route.ts`
- Modify: `lib/server/training.ts`
- Modify: `lib/domain/content.ts`
- Modify: `tests/domain.test.ts`

**Interfaces:**
- Consumes: `AttemptInput = { eventId: string; scenarioId: string; actionType: ActionType; targetPlayerId?: string; destination?: Point }`.
- Produces: `AttemptFeedback = { correct; grade; hint; explanation; selectedPath; recommendedAction; recommendedPath; timeline; explanations; mastery }`.
- Consumes: existing legacy `answerJson` through `adaptLegacyPassScenario(row)` only when `contentJson === ""`.

- [ ] **Step 1: Add validation and legacy-adapter tests**

Add pure tests proving that pass requires `targetPlayerId` or a destination, dribble/move require a finite destination, unknown action types fail, and a legacy circle answer becomes a pass scenario with no fabricated coach explanations:

```ts
import { parseAttemptInput, adaptLegacyPassScenario } from "../lib/domain/content.ts";

test("validates action-specific attempt payloads", () => {
  assert.throws(() => parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "dribble" }), /도착/);
  assert.equal(parseAttemptInput({ eventId: "e", scenarioId: "s", actionType: "move", destination: { x: 40, y: 50 } }).actionType, "move");
});

test("adapts legacy circle answers without inventing reviewed explanations", () => {
  const adapted = adaptLegacyPassScenario({
    pitchJson: JSON.stringify({ players: [], ball: { x: 50, y: 80 } }),
    answerJson: JSON.stringify({ kind: "circle", cx: 30, cy: 50, radius: 8 }),
  });
  assert.equal(adapted.answer.preferred.actionType, "pass");
  assert.deepEqual(adapted.explanations, []);
});
```

- [ ] **Step 2: Run domain tests and verify failure**

Run: `node --experimental-strip-types --test --test-name-pattern="attempt payloads|legacy circle" tests/domain.test.ts`

Expected: FAIL because the parsers do not exist.

- [ ] **Step 3: Implement request validation, evaluation, and persistence**

Change `POST /api/attempts` to call `parseAttemptInput`. Change `recordAttempt` to load and validate structured content, call `evaluateScenarioAction`, and persist action details. Serialize `selectedPath` only when present. Preserve event-ID idempotency and mastery calculation.

Only return full result timeline, recommended action/path, and the four explanation blocks when the attempt is correct or the participant has reached the second miss. On the first miss, return the existing hint plus a safe setup highlight derived from the reviewed `observe` block. Legacy rows continue returning their existing plain explanation and circle answer.

- [ ] **Step 4: Run domain, build, and lint checks**

Run: `node --experimental-strip-types --test tests/domain.test.ts`

Expected: all domain tests PASS.

Run: `npm run build && npm run lint`

Expected: both commands exit 0.

- [ ] **Step 5: Commit the structured attempt API**

```bash
git add app/api/attempts/route.ts lib/server/training.ts lib/domain/content.ts tests/domain.test.ts
git commit -m "feat: submit tactical action choices"
```

---

### Task 5: Action-first pitch interaction

**Files:**
- Create: `app/train/[campaignId]/TacticalPitch.tsx`
- Modify: `app/train/[campaignId]/CampaignPlayer.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `PublicScenarioContent` and `ActionType`.
- Produces: `TacticalPitch` callback `onSubmit(input: { actionType: ActionType; targetPlayerId?: string; destination?: Point }): void`.
- Produces: queued offline event with the same fields as `AttemptInput`, preserving `eventId` idempotency.

- [ ] **Step 1: Add rendered-output assertions for action controls**

In `tests/rendered-html.test.mjs`, add assertions that the built training page/client bundle includes the accessible labels `패스`, `드리블`, `이동`, and instruction copy `행동을 먼저 고르세요`. Keep the test independent of unpublished tactical fixtures.

- [ ] **Step 2: Run the rendered test and verify failure**

Run: `npm run build && node --test tests/rendered-html.test.mjs`

Expected: FAIL because the three action controls are not rendered yet.

- [ ] **Step 3: Build the focused interactive pitch component**

Move SVG pitch rendering into `TacticalPitch.tsx`. Render three 44px-minimum toggle buttons from `allowedActions`; disable pitch submission until one is selected. For pass, tapping a teammate circle submits its stable player ID; tapping open pitch submits a destination for legacy zone-pass compatibility. For dribble/move, tapping pitch submits the normalized destination. Mark the selected toggle with `aria-pressed`, give player circles accessible labels through sibling SVG `<title>` elements, and prevent opponent taps from submitting a pass target.

```tsx
<button
  type="button"
  aria-pressed={selectedAction === action}
  onClick={() => setSelectedAction(action)}
>
  {ACTION_LABELS[action]}
</button>
```

- [ ] **Step 4: Update campaign orchestration and offline queue shape**

Replace `submit(x, y)` with `submit(choice)`, attach `eventId` and `scenarioId`, and store the complete event on network failure. The online flush must resend action type, target, and destination unchanged and remove only the acknowledged event ID.

- [ ] **Step 5: Add mobile and state styling**

Add `.action-picker`, `.action-button`, `.action-button[aria-pressed="true"]`, `.pitch-instruction`, `.selected-path`, and `.hazard-highlight` rules. Keep each action button at least 44px high and preserve `touch-action:none` on the SVG.

- [ ] **Step 6: Run test, build, and lint checks**

Run: `npm test && npm run lint`

Expected: all tests, production build, rendered assertions, and lint PASS.

- [ ] **Step 7: Commit the action-first interaction**

```bash
git add app/train/'[campaignId]'/TacticalPitch.tsx app/train/'[campaignId]'/CampaignPlayer.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "feat: add action-first tactical controls"
```

---

### Task 6: Deterministic result playback and intuitive explanation review

**Files:**
- Create: `lib/domain/timeline.ts`
- Create: `app/train/[campaignId]/ScenarioPlayback.tsx`
- Create: `app/train/[campaignId]/CoachExplanationPanel.tsx`
- Modify: `app/train/[campaignId]/CampaignPlayer.tsx`
- Modify: `app/globals.css`
- Modify: `tests/domain.test.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `ScenarioTimeline`, `CoachExplanation[]`, selected/recommended paths, and `prefersReducedMotion`.
- Produces: `frameAt(timeline, atMs): PitchFrame` with linear interpolation for players and ball.
- Produces: `ScenarioPlayback` controls `playing`, `currentMs`, and `seek(ms)` through props/callbacks.
- Produces: explanation selection that seeks to `fromMs` and highlights the referenced IDs or paths.

- [ ] **Step 1: Write failing deterministic timeline tests**

Add tests for exact endpoints, midpoint interpolation, missing-player carry-forward, and clamping beyond duration:

```ts
import { frameAt } from "../lib/domain/timeline.ts";

test("interpolates a reviewed timeline deterministically", () => {
  const timeline = {
    durationMs: 1000,
    keyframes: [
      { atMs: 0, players: { d1: { x: 20, y: 20 } }, ball: { x: 50, y: 70 } },
      { atMs: 1000, players: { d1: { x: 40, y: 20 } }, ball: { x: 30, y: 50 } },
    ],
  };
  assert.deepEqual(frameAt(timeline, 500).players.d1, { x: 30, y: 20 });
  assert.deepEqual(frameAt(timeline, 1500).ball, { x: 30, y: 50 });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --experimental-strip-types --test --test-name-pattern="timeline" tests/domain.test.ts`

Expected: FAIL because `frameAt` does not exist.

- [ ] **Step 3: Implement pure timeline interpolation**

Sort a copied keyframe array by `atMs`, clamp requested time to `[0, durationMs]`, select surrounding frames, and linearly interpolate entities present in both. Carry the nearest defined position for entities absent from one surrounding keyframe. Do not mutate content arrays.

- [ ] **Step 4: Build automatic playback with reduced-motion fallback**

`ScenarioPlayback.tsx` uses `requestAnimationFrame` from 0 through `durationMs`, offers replay/pause controls, and renders selected versus recommended paths with different dash patterns. Detect `window.matchMedia("(prefers-reduced-motion: reduce)")`; in reduced motion, render the current stage endpoint and arrow markers without starting `requestAnimationFrame`.

- [ ] **Step 5: Build the three-stage explanation review**

`CoachExplanationPanel.tsx` renders tabs labeled `상황`, `판단`, `결과`. Map `observe` to 상황, `benefit` and `risk` to 판단, and `remember` to 결과. Selecting a block calls `seek(explanation.fromMs)` and passes its highlight references to playback. Show the coach-authored text only; do not synthesize tactical copy on the client.

- [ ] **Step 6: Connect feedback flow and rendered assertions**

After correct or second-miss feedback, auto-play once and then expose stage navigation, replay, and next-position controls. Add rendered assertions for `상황`, `판단`, `결과`, `다시 보기`, and the reduced-motion arrow class.

- [ ] **Step 7: Run all verification commands**

Run: `npm test && npm run lint`

Expected: timeline unit tests, build, rendered HTML tests, and lint all PASS.

- [ ] **Step 8: Commit playback and explanation review**

```bash
git add lib/domain/timeline.ts app/train/'[campaignId]'/ScenarioPlayback.tsx app/train/'[campaignId]'/CoachExplanationPanel.tsx app/train/'[campaignId]'/CampaignPlayer.tsx app/globals.css tests/domain.test.ts tests/rendered-html.test.mjs
git commit -m "feat: explain choices with reviewed playback"
```

---

### Task 7: Enforce complete coach review before publication

**Files:**
- Modify: `app/api/content/scenarios/[id]/review/route.ts`
- Modify: `lib/domain/content.ts`
- Modify: `tests/domain.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `isScenarioPublishable(content)` and `CONTENT_REVIEW_KEY`.
- Produces: review transition response `{ id, reviewStatus }` or HTTP 409 with a concrete validation error.
- Preserves: draft/pending transitions for incomplete content; only `reviewed` is gated.

- [ ] **Step 1: Extract a testable review-transition validator and test it**

Add `assertReviewTransition(status, content)` to `lib/domain/content.ts`. Tests must prove `pending` accepts incomplete content, while `reviewed` rejects missing source approval, missing timeline approval, missing explanation approval, any absent explanation kind, invalid time range, and unknown highlight reference.

```ts
test("blocks publication until content and all review dimensions are complete", () => {
  assert.doesNotThrow(() => assertReviewTransition("pending", { ...reviewedScenarioContent, review: { sourceReviewed: false, timelineReviewed: false, explanationsReviewed: false } }));
  assert.throws(() => assertReviewTransition("reviewed", { ...reviewedScenarioContent, review: { ...reviewedScenarioContent.review, sourceReviewed: false } }), /출처/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --experimental-strip-types --test --test-name-pattern="publication" tests/domain.test.ts`

Expected: FAIL because the transition validator does not exist.

- [ ] **Step 3: Gate the review route**

When the requested status is `reviewed`, load the scenario, reject legacy/empty `contentJson`, parse structured content, call `assertReviewTransition`, and return HTTP 409 with the validator's Korean message on failure. On success, update `reviewStatus` to `reviewed`. Keep authentication and allowed-status checks unchanged.

- [ ] **Step 4: Document the coach review payload and sequence**

Replace the starter-focused README introduction with the TACTIQ development guide. Document the six defense values, three action values, four explanation kinds, review flags, migration command, and the rule that a reviewer must verify animation-highlight alignment before setting all flags and calling the review endpoint. State explicitly that example test fixtures are never inserted into D1 and are not tactical recommendations.

- [ ] **Step 5: Run final automated verification**

Run: `npm test && npm run lint && git diff --check`

Expected: tests and build PASS, lint exits 0, and `git diff --check` prints no whitespace errors.

- [ ] **Step 6: Perform mobile acceptance checks**

Run: `npm run dev`

On a mobile-width viewport, verify: each action target is at least 44px; action selection precedes pitch submission; all six defense labels render from synthetic local test data without publishing it; pass selects a teammate; dribble and move select space; first miss highlights the pressure clue; second miss shows recommended path; playback can replay and seek through 상황/판단/결과; reduced-motion mode shows arrows and endpoints; offline events resend once by event ID after reconnecting.

- [ ] **Step 7: Commit the publication gate and documentation**

```bash
git add app/api/content/scenarios/'[id]'/review/route.ts lib/domain/content.ts tests/domain.test.ts README.md
git commit -m "feat: require complete coach review for scenarios"
```

---

### Task 8: Pilot-ready regression and Sites deployment handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-08-15-dribbling-defense-scenarios-design.md` only if verified implementation details differ and the user approves the amendment.
- Modify: `README.md` only for verified deployment commands or environment variables discovered during deployment.

**Interfaces:**
- Consumes: all prior tasks and the existing Sites deployment workflow.
- Produces: a clean branch with reproducible verification evidence; no tactical scenario is published without supplied coach material.

- [ ] **Step 1: Verify the generated D1 migration is deployable**

Inspect the Task 3 migration and confirm it is committed under `drizzle/`, contains only additive `ALTER TABLE ... ADD` statements, defaults existing attempts to `action_type = 'pass'`, and leaves `.openai/hosting.json` as `{ "project_id": "appgprj_6a7fdb61540c81919f6775c2f42f829f", "d1": "DB", "r2": null }`. Do not put a physical database ID or runtime credential into source control; Sites applies packaged migrations to its managed D1 resource.

- [ ] **Step 2: Run the complete regression suite from a clean process**

Run: `npm test && npm run lint && npm run build && git status --short`

Expected: every command exits 0; status lists only intentional documentation changes, or is clean after their commit.

- [ ] **Step 3: Load only coach-supplied pilot content as pending**

Encode the supplied source material using `ScenarioContent`, set all new content to `pending`, and have the coach inspect each explanation-linked animation segment. Do not reuse the synthetic unit-test fixture and do not change status to `reviewed` during data entry.

- [ ] **Step 4: Publish only approved pilot scenarios and smoke test**

After the coach confirms the source, animation, and explanation flags, call the authenticated review endpoint for each approved scenario. Verify unpublished scenarios do not appear in campaign APIs and approved scenarios complete pass, dribble, move, replay, retry, and offline-resync flows.

- [ ] **Step 5: Commit any approved deployment documentation changes**

```bash
git add README.md docs/superpowers/specs/2026-08-15-dribbling-defense-scenarios-design.md
git commit -m "docs: record tactical scenario deployment workflow"
```

Skip this commit when neither file changed.

- [ ] **Step 6: Package and publish the validated Site**

Invoke the required `sites-hosting` skill. Reuse the successful build, existing `project_id`, and current source repository credential or obtain a short-lived replacement through Sites. Use `scripts/package-site.sh` from the installed Sites plugin to package the project and an archive path under `/private/tmp`; verify the archive contains `dist/server/index.js`, `dist/.openai/hosting.json`, and `dist/.openai/drizzle/`. Save one version from the exact branch-head SHA, deploy it privately, poll until `succeeded`, and reopen the resulting URL in the stable Site tab from Task 0.
