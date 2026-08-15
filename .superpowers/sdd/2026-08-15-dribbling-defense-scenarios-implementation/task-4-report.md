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
