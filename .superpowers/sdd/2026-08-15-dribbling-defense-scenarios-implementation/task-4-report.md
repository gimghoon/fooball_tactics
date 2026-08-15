# Task 4 report: submit tactical action choices

## Behavior

- Added `parseAttemptInput` for structured action submissions: `pass` requires a target player or destination; `dribble` and `move` require finite destinations; unknown action types fail.
- Retained the explicit legacy coordinate shape `{ eventId, scenarioId, x, y }`. Legacy rows are adapted only when `contentJson === ""`; they keep their original circle scoring, hint/plain-explanation behavior, and answer-circle reveal.
- The attempts API now parses the request before recording it. Structured rows are parsed and review-gated server-side, evaluated with `evaluateScenarioAction`, and persist `actionType`, `targetPlayerId`, scaled endpoint coordinates, and a nullable JSON `selectedPath`.
- Structured first misses return the existing hint and only the reviewed `observe` block. Correct attempts and second misses disclose the reviewed result timeline, recommended action/path, and all four authored explanation blocks.
- Event-ID retries reload and evaluate the persisted choice, rather than trusting a changed retry body. Inserts use `onConflictDoNothing` and reload the winning row, preserving idempotency and mastery under concurrent retries.

## TDD evidence

- RED: `node --experimental-strip-types --test --test-name-pattern='attempt payloads|legacy circle' tests/domain.test.ts` failed because `parseAttemptInput` was not exported.
- GREEN: the same focused command passed after implementing the parser.

## Files

- `app/api/attempts/route.ts`
- `lib/domain/content.ts`
- `lib/server/training.ts`
- `tests/domain.test.ts`

## Verification

- `node --experimental-strip-types --test tests/domain.test.ts` — 19 passing tests.
- `npm run build && npm run lint` — both passed. The build emitted only the existing Node `DEP0205` deprecation warning.
- `npm test` — passed: domain tests, production build, and rendered HTML test.
- `git diff --check` — passed.

## Self-review

- Confirmed first-miss structured responses leave the result timeline, recommended action/path, and non-observe explanation blocks absent.
- Confirmed action persistence matches the additive schema: coordinates are stored in `touchX`/`touchY`, and `pathJson` is null when no selected path exists.
- Confirmed legacy destination-pass requests score against the adapted circle while retained coordinate requests remain accepted.
- External review identified retry/body divergence, legacy destination-pass rejection, and concurrent insert handling; all three were corrected and the follow-up review returned no issues.

## Concerns

- No route-level database integration test exists in the repository; behavior was verified through pure-domain tests, production build/type checking, linting, rendered HTML coverage, and code review.

## Fix round 1/5

### Changes

- `evaluateScenarioAction` now supports a `pass` action whose reviewed target is a zone: a finite submitted destination must be inside that zone, and its selected path runs from the actor to that exact point.
- Attempt-input failures now use `AttemptInputError`; the attempts route consumes the tested `mapAttemptInputError` result and returns `{ error }` with HTTP 400 instead of passing invalid requests to the generic HTTP-500 mapper.
- Structured retries are reconstructed from the persisted `actionType`, `targetPlayerId`, and exact final point in `pathJson`. The rounded `touchX`/`touchY` analytics columns are no longer used to re-evaluate a stored structured action. A malformed or missing persisted structured path is rejected instead of trusting a changed retry body.

### TDD evidence

#### RED

```text
node --experimental-strip-types --test --test-name-pattern='bad-request|destination when|exact persisted' tests/domain.test.ts
```

Result: failed during test-module loading because `mapAttemptInputError` did not exist. The same test patch also specified the missing zone-pass and exact-path reconstruction behavior.

#### GREEN

```text
node --experimental-strip-types --test --test-name-pattern='bad-request|destination when|exact persisted' tests/domain.test.ts
```

Result: 3 passed / 0 failed:

- invalid request maps to `{ status: 400 }`;
- a pass to a reviewed zone is correct and yields its path;
- a persisted `{ x: 70.004 }` endpoint remains incorrect against a radius-10 boundary even though rounded `{ x: 70 }` would become correct.

### Verification

```text
node --experimental-strip-types --test tests/domain.test.ts
```

Result: 22 passed / 0 failed.

```text
npm test
```

Result: 22 domain tests passed, production build passed, and rendered HTML test passed. The build emitted only the existing Node `DEP0205` deprecation warning.

```text
npm run lint
git diff --check
```

Result: both commands exited 0.

### Self-review

- Confirmed the actual attempts route consumes the tested 400 mapper before the generic `jsonError` fallback.
- Confirmed stored structured choices never fall back to a changed retry body; `pathJson` supplies the destination on every reload.
- Confirmed the regression test exercises the classification change caused specifically by two-decimal coordinate rounding.

### Concerns

- The application has no D1 harness for a full HTTP/database retry test; the pure reconstruction contract covers the canonical persisted-choice boundary used by `recordAttempt`.
