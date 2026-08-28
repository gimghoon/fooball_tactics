# Task 4 implementer report: search, selection, and import orchestration

## Status

**DONE** — Task 4 is implemented in `54d1d68` (`feat: orchestrate external evidence selection`). The brief-defined focused tests, ESLint, and the production build pass.

## Exact files

Implementation commit `54d1d68` changes exactly the requested five files:

- `lib/server/evidence-search-jobs.ts` (new)
- `lib/server/evidence-service.ts`
- `lib/server/evidence-runtime.ts`
- `tests/evidence-search-jobs.test.ts` (new)
- `tests/evidence-service.test.ts`

No schema migration or runtime package was added.

## Implemented behavior

### Explicit search lifecycle

- `startSearch()` reads the current bundle and builds a direct-evidence summary from uploaded extracted text plus direct video observations. The summary is capped at 4,000 UTF-8 bytes and also at the search adapter's 2,000-code-unit boundary.
- The search input hash covers bundle content/version, title, purpose, the bounded summary, search model, and search prompt version.
- A unique D1 input version plus `INSERT OR IGNORE` deduplicates concurrent starts. Existing `queued`, `searching`, or `ready` work is reused; a provider-failed run with no candidates can be requeued safely.
- The run is stored as `queued` before scheduling. Candidate insertion and the `searching → ready` checkpoint share one D1 batch, are guarded by the original bundle authority, and retain at most eight server-policy-approved canonical URLs.
- Search failures store only a classified Korean message capped at 240 characters. Provider bodies, API keys, and arbitrary transport messages are never persisted or returned.
- `getLatestSearch()` and `getSearch()` expose parsed query strings and candidate metadata, but not provider envelopes, request bodies, storage keys, or credentials.

### Selection CAS and audit

- `saveSelection()` validates the run/bundle relationship, state, stale bit, expected numeric bundle version, candidate ownership, five-selection maximum, and selected/excluded disjointness.
- Advisory reads are followed by a single D1 batch whose every candidate/audit write shares the same bundle version, run status/stale/`updated_at`, and complete candidate-membership guard. The final run `updated_at` write is the CAS checkpoint; a zero-row result becomes a 409 conflict.
- Selected and excluded decisions record actor/time and an `evidence_audit_events` row per changed candidate.
- Imported candidates cannot be excluded, importing candidates cannot be changed, and previously imported candidates count toward the five-source cap.
- A post-commit transport error is reconciled by rereading the requested candidate states, making exact selection retries idempotent.

### Selected-only isolated imports

- `startImport()` requires at least one selected or failed candidate, enforces the five-candidate boundary again, deduplicates an already-importing run, and schedules only D1-selected rows.
- Candidates execute sequentially but independently as `selected|failed → importing → imported|failed`. Sequential execution avoids self-induced bundle CAS races while retaining per-candidate partial failure and retry behavior.
- Each candidate uses the existing bounded `fetchExternalEvidence()` path. The orchestrator independently rechecks the final URL with server policy and verifies that the proposed quote appears in the returned extracted pages before any R2 write.
- Successful bytes use the existing `EvidenceFileStore`, external metadata validation, URL/hash deduplication, opaque R2 keys, registration CAS, and durable loser-cleanup receipts.
- The source insert, bundle version increase, analysis/card invalidation, importing-run version advance, and new candidate `source_id`/hash transition are guarded in the same D1 mutation batch when a new source is registered. If the bundle/source CAS loses, the existing storage reconciliation removes only unowned R2 objects.
- A duplicate existing source is linked to the importing candidate without a new bundle version or R2 write. A post-commit D1 transport error is reconciled to the already committed source/candidate state.
- One failed candidate does not roll back a successful sibling. A run becomes `completed` when at least one selected source imports and all selected work is terminal; it becomes `failed` only when all imports fail. Retrying a completed partial-success run fetches only failed candidates.

### Staleness, detail, deletion, and runtime

- Content-bearing service mutations stale other search runs in the existing guarded D1 mutation. The importing run that owns a newly registered candidate is preserved and atomically advanced to the new bundle version.
- Purpose, uploaded source, external source, video observation, and source deletion changes therefore invalidate prior search authority. Title-only mutations keep the existing content-version behavior.
- Administrator bundle detail retains `origin`, `canonicalUrl`, `publisher`, `publishedAt`, and `retrievedAt` from the production repository.
- External source removal continues through the existing link-impact check, durable receipt, bundle/source CAS, and compensated R2 pair deletion path. Existing card and exact scenario relations still block deletion.
- Production runtime optionally composes `EvidenceExternalSearchJobs` without starting search implicitly. Its real import closure uses Cloudflare Workers `fetch`, the server-owned allowlist, and bounded Cloudflare DoH. No raw TCP, IP-pinned socket, or unsupported resolution override was introduced.

## RED/GREEN evidence

### RED 1 — orchestrator absent

`npx tsx --test tests/evidence-search-jobs.test.ts` exited 1 with `ERR_MODULE_NOT_FOUND` for `lib/server/evidence-search-jobs.ts`. This was the brief-specified initial failure and established that the new public orchestration surface did not exist.

### RED 2 — production runtime not wired

After the core orchestrator/service slice was green, the runtime composition test failed because `runtime.searchJobs` was `undefined`. Adding the optional production composition made the same test pass while preserving explicit search start semantics.

### GREEN

- Final required command `npx tsx --test tests/evidence-search-jobs.test.ts tests/evidence-service.test.ts tests/evidence-storage.test.ts && npm run lint` passed **68/68** tests with 0 failures, cancellations, skips, or todos; ESLint exited 0.
- `npm run build` completed all five vinext build stages successfully.
- `npm test` passed the repository suite: domain **47/47**, integration/component **18/18**, rendered output **5/5**, with its production build stage also successful.
- `git diff --check` reported no whitespace errors before the implementation commit.

## Concurrency and failure-injection evidence

- Repeated explicit search starts produce one D1 run, one scheduled promise, one provider call, and at most eight unique candidates.
- A real SQLite/D1 `beforeNextBatch` bundle-version winner causes selection CAS failure with zero candidate changes and zero selection audit rows.
- A source-registration CAS loss after fetch leaves zero `evidence_sources` rows and zero R2 objects; the candidate reaches terminal `failed` state without exposing the injected upstream body.
- A D1 transport error injected after the registration batch commits reconciles to exactly one source, two owned R2 objects, an `imported` candidate, a `completed` run, and matching run/bundle version 2.
- Partial import failure preserves the successful source. Retry fetches only the failed URL, reaches two sources, and an additional completed-run retry performs no work.
- Quote mismatch fails before R2/source registration.
- Provider failure leaves prior analysis/card state unchanged and persists only the bounded classified failure message.
- Existing Task 3 tests continue to prove durable pending cleanup receipts, URL/content race reconciliation, pair compensation, and no restoration of unowned objects.

## Concerns

- No Task 4 blocker remains.
- The focused storage suite still prints existing PDF.js standard-font/indexing warnings while passing; these are unchanged from the Task 3 baseline.
- The build still prints the existing Node `module.register()` deprecation and vinext route-classification warnings while exiting 0.
- Repository-wide bare `npx tsc --noEmit` was already documented by Task 3 as a non-green, unsupported broad gate; Task 4 used the brief-defined tests, ESLint, and production build gates instead.

---

## Fix round 1 — authority races and interrupted handoffs

Implementation commit: `7b55d78` (`fix: harden evidence search handoffs`).

### Changes

- Search-run creation now uses `INSERT OR IGNORE ... SELECT` with the captured bundle numeric version and content version in the insert authority. A bundle mutation between the advisory read and insert produces zero rows and a 409 without leaving a queued run.
- A queued search whose acquisition loses because bundle authority changed is terminally changed to `failed`, `is_stale=1`, with a bounded public error. It can no longer remain reusable forever.
- Search insert and import-start D1 post-commit transport failures now reconcile the authoritative row before scheduling. Subsequent calls seeing `queued` search work or an `importing` run re-schedule the continuation; provider and candidate acquisition CAS operations ensure only one provider/fetch worker wins.
- Candidate acquisition is reconciled after a post-commit exception by matching its authoritative `importing` timestamp. Pre-commit acquisition failures remain selected for a later repaired handoff.
- Each import candidate, including acquisition and failure-state persistence, is isolated from its siblings. Failure-state writes reconcile committed terminal state and retry a transient pre-commit state write once. `finishImportRun()` is attempted from `finally`, even when enumeration or a candidate path fails.
- An already-`importing` run now schedules a repair continuation instead of returning forever. A repair can finish a terminal-but-uncheckpointed run or acquire still-selected/failed candidates without duplicating a candidate already acquired by another continuation.
- Selection now catches and reconciles only exceptions thrown by `db.batch()`. A successfully returned batch whose final CAS reports zero changes always throws 409; identical candidate state can no longer mask lost authority.

### RED evidence

The first fix-round run of `npx tsx --test tests/evidence-search-jobs.test.ts` executed 17 tests with **10 passing and 7 failing**. The failures exactly reproduced:

- unguarded search insertion after a bundle mutation;
- a bundle-mutation acquisition loss remaining `queued` instead of terminal stale/failed;
- post-commit search insertion and import-start exceptions escaping before scheduling;
- first-candidate acquisition and failure-update exceptions aborting sibling work;
- a returned zero-row selection CAS being swallowed after an identical concurrent winner.

### GREEN evidence

- `npx tsx --test tests/evidence-search-jobs.test.ts` passes **19/19**, including added pre-commit and post-commit candidate acquisition/failure-update cases.
- `npx tsx --test tests/evidence-search-jobs.test.ts tests/evidence-service.test.ts tests/evidence-storage.test.ts` passes **77/77**.
- `npm run lint` exits 0.
- `npm run build` completes all five vinext build stages.
- `npm test` passes domain **47/47**, integration/component **18/18**, and rendered output **5/5**, including its production build stage.
- `git diff --check` exits 0 before the fix commit.

### Concurrency and failure evidence

- A real SQLite hook mutating bundle version/content immediately before run insertion proves zero search rows and zero scheduled work.
- Mutation immediately before acquisition proves zero provider calls and a terminal `failed`/stale run.
- Search and import start post-commit exceptions are followed by repeated calls while acquisition is held. Two continuations are registered, but acquisition CAS produces exactly one provider call or fetch.
- With two selected candidates, a pre-commit acquisition failure on the first leaves it recoverable, imports the sibling, and a later `startImport()` imports only the first.
- A post-commit acquisition exception is reconciled and both candidates import exactly once.
- Pre-commit and post-commit failure-state exceptions both preserve sibling success and terminal run checkpointing; retry fetches only the failed candidate.
- In the selection regression, one request pauses before its batch, an identical concurrent request commits, the bundle then mutates, and the paused request's old expected version receives 409. Only the winning request's two audit rows exist.

### Remaining concerns

- No fix-round blocker remains.
- The focused storage suite continues to print the pre-existing PDF.js standard-font/indexing warnings while passing.
- Build and full-test output continue to include the pre-existing Node `module.register()` deprecation and vinext route-classification warnings while exiting 0.

---

## Fix round 2 — durable acquisition leases and stranded-work recovery

### Changes

- Added forward-only migration `0013_quick_layla_miller.sql`; migrations 0010–0012 are unchanged. Both `evidence_search_runs` and `evidence_search_candidates` gain nullable `lease_token` and `lease_expires_at` columns. Recovery indexes cover run status/expiry and candidate run/status/expiry. `db/schema.ts`, snapshot 0013, and the Drizzle journal are aligned.
- Every search-provider and candidate-fetch acquisition creates a fresh cryptographic UUID token and a 60-second lease. Search provider timeout is 30 seconds; external fetch plus bounded validation is below the 60-second lease.
- Search acquisition accepts `queued` or expired/legacy `searching` rows. Candidate acquisition accepts `selected|failed` or expired/legacy `importing` rows. Active unexpired leases cannot be replaced.
- D1 ambiguity reconciliation now proceeds only when the authoritative row contains the exact token generated by that continuation. Equal `Date.now()` values cannot confer ownership.
- Lease expiry permits a successor CAS but does not revoke the current token by itself. Provider completion, candidate success/failure, and source registration require the exact token but do not require an unexpired wall clock. An in-flight owner can therefore finish after expiry if no successor replaced it; after replacement, its terminal writes affect zero rows.
- Candidate tokens cross the internal file-store/service boundary only as mutation authority. They are validated, excluded from persisted source provenance and administrator job detail, and stripped from returned stored-source records.
- New external-source registration, bundle version advance, importing-run version advance, candidate import, audit, and final bundle CAS share exact candidate-token authority. The batch retains an exact imported-source fallback after it clears the terminal candidate token, so the final CAS remains authoritative.
- Explicit `startSearch()` calls now reschedule both `queued` and `searching` work. Explicit `startImport()` calls continue to reschedule `importing` work. There is no timer or polling loop.
- Import enumeration skips active candidate leases, includes expired/legacy importing candidates once, and processes the bounded candidate snapshot once. Finalization separately recognizes active and recoverable leases and never marks a run terminal while either exists.
- Ready/failed/stale search transitions and imported/failed/selected/excluded candidate transitions clear lease token and expiry.

### RED evidence

The first fix-round jobs/service run executed 45 tests with **39 passing and 6 failing**. The failures demonstrated:

- an active `searching` run was returned without scheduling a repair;
- stranded runs/candidates could not persist lease ownership because the columns were absent;
- two same-millisecond candidate continuations fetched the same URL twice after an ambiguous no-op acquisition;
- stale candidate ownership could reach source registration;
- additive migration 0013 and its indexes were absent.

A targeted search-recovery run then failed specifically with `no such column: lease_token`, confirming the stranded-work test reached the intended missing schema rather than failing in its interruption harness.

### GREEN evidence

- `npx tsx --test --test-timeout=10000 tests/evidence-search-jobs.test.ts` passes **25/25**.
- `npx tsx --test --test-timeout=15000 tests/evidence-search-jobs.test.ts tests/evidence-domain.test.ts tests/evidence-service.test.ts tests/evidence-storage.test.ts tests/local-db-setup.test.mjs` passes **97/97**.
- `npm run lint` exits 0.
- Standalone `npm run build` completes all five vinext stages.
- `npm test` passes domain **47/47**, integration/component **18/18**, and rendered output **5/5**, including its own successful production build.
- `git diff --check` exits 0 before commit.

### Concurrency, recovery, and migration evidence

- Fixed-clock search and candidate tests hold both continuations at the same millisecond. One owns the token; the other executes a zero-row acquisition followed by an injected ambiguous transport error. Exactly one provider/fetch invocation occurs.
- Post-commit acquisition followed by an unavailable authoritative reread strands a tokenized `searching` run or `importing` candidate. An explicit call before expiry schedules but cannot steal it. Advancing the injected clock to the exact expiry and calling again replaces the token, performs one provider/fetch, and reaches a terminal ready/completed state.
- Separate tests advance the clock past 60 seconds during provider/fetch execution without scheduling a successor. Exact-token completion and source registration still succeed and clear the lease.
- A stale candidate token loses the real source-registration D1 batch, leaves the successor token/status untouched, persists zero sources, and compensates both R2 objects.
- Migration testing applies 0013 to pre-existing `searching` and `importing` rows, preserves their state with null legacy leases, verifies both recovery indexes and foreign keys, and validates the aligned journal entry.
- Local Wrangler/D1 setup applies every migration and confirms both lease columns and indexes in the resulting database.

### Remaining concerns

- Recovery is intentionally driven by later explicit start calls; there is no background sweeper. This matches the approved no-polling design.
- Lease takeover can duplicate already-started upstream work after 60 seconds, but exact-token D1/source authority ensures only the current owner can commit. Normal provider/fetch deadlines are safely shorter than the lease.
- The focused storage suite and builds retain the same pre-existing PDF.js, Node deprecation, and vinext route-classification warnings while all commands exit 0.
