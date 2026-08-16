# Task 8 Report: Admin-only evidence HTTP API

## Status

Implemented and verified on `codex/dribbling-defense-scenarios`.

## Delivered

- Added non-injectable production route entrypoints for evidence bundle list/create/get/update, multipart uploads, video clips, analysis start, job status/retry, card review, scenario conversion, authenticated downloads, deletion impact, and source removal.
- Added a shared authorized handler layer so route tests can inject already-authorized service/runtime ports without making production authorization injectable.
- Every production route calls `requireEvidenceAdminApi()` before runtime/binding creation, request parsing, file-byte reads, D1/R2 access, or resource existence checks.
- Bound the Cloudflare `waitUntil` function directly to `EvidenceAnalysisJobs.schedule(promise)`; status polling only reads the job and review payload and never advances work.
- Added safe response projections that omit R2 keys, extracted-text keys/checkpoints, analyzer/model metadata, immutable internal JSON columns, provider errors, and secrets.
- Added review-ready job card discovery with current-version citations exposed only as bounded 2,000-character excerpts, so the admin UI can identify and review cards without returning source objects or full extracted text.
- Added authenticated R2 download streaming with `private, no-store`, `nosniff`, media type/length, and CR/LF/path-safe RFC 5987 attachment filenames.
- Added exact error handling for malformed input (400), authorized missing resources (404), stale/CAS/blocked operations (409), oversized files (413), unsupported/mismatched formats (415), and unavailable analyzer/storage (503).
- Added source deletion impact and removal endpoints; linked sources remain blocked, while storage failures are redacted and normalized to 503.
- Extended `EvidenceService`/D1 repository with read-only job-card listing and current-version citation filtering.

## TDD evidence

Initial RED:

```text
ERR_MODULE_NOT_FOUND: lib/server/evidence-routes.ts
```

Focused review regressions were also observed failing before fixes for:

- raw extraction-error leakage,
- missing review-card discovery on job polling,
- R2 deletion validation failures incorrectly returning 400.

All passed after the minimal production changes.

## Security review

A focused independent review identified three Important findings (extraction error redaction, card/citation discovery, and delete-storage 503 mapping). All were fixed and re-reviewed.

Final review result: no remaining Critical or Important findings.

## Final verification

```text
npx tsx --test tests/evidence-auth.test.ts tests/evidence-domain.test.ts tests/evidence-storage.test.ts tests/evidence-service.test.ts tests/evidence-analyzer.test.ts tests/evidence-jobs.test.ts tests/evidence-review.test.ts tests/evidence-routes.test.ts tests/review-route.test.ts
144 tests passed, 0 failed

npm test
47 domain + 16 route/component + production build + 3 rendered HTML tests passed

npm run lint
passed

git diff --check
passed
```

The production build enumerated all ten admin evidence route shapes, including download/delete impact routes.

## Concerns

- The repository's `npm test` script does not yet include the evidence-specific suites, so the complete 144-test evidence matrix was run explicitly in addition to `npm test`.
- Citation excerpts are deliberately capped at 2,000 characters at the HTTP boundary; the UI should treat them as review context, not as a full-document viewer.

## Fix Round 1

Status: all six Important findings and the Minor finding from `task-8-review.md` are addressed.

- Multipart uploads now reject an oversized `Content-Length` without reading the stream and enforce a hard 20 MiB + 64 KiB envelope cap while consuming chunked bodies. Only one `file` part is accepted; duplicate and unexpected parts are rejected.
- PDF.js parse failures now become validation failures before any original/extracted R2 object or source metadata is written. Valid scan-only PDFs retain the existing stored-with-extraction-failed policy.
- Retry under incompatible persisted analyzer/prompt/schema settings now fails the job and throws a typed configuration conflict, producing HTTP 409 instead of 202.
- Scenario conversion verifies campaign existence before conversion and again through the atomic D1 insert guard. A campaign deletion between the advisory check and batch returns typed 404 without partial provenance/audit writes.
- Admin JSON response creation is centralized with `Cache-Control: private, no-store`; authorization responses are also normalized and permissive CORS is removed. Authenticated download headers remain unchanged.
- Message-substring routing was removed. Typed public 400/404/409/413/415/503 errors map to fixed messages, while unknown D1/R2/provider messages are redacted as 500/503.
- Job polling now pages cards at 20, caps citations at 20 per card, caps each excerpt at 2,000 UTF-8 bytes and aggregate excerpts at 32 KiB, and returns `count`, `totalCount`, and `nextCursor` metadata. Repository queries apply SQL `LIMIT`/`OFFSET` and bounded citation reads.

Fix-round regression coverage includes auth-before-stream-read, declared/chunked multipart overflow, duplicate/unexpected parts, real-store malformed PDF cleanup, active-setting retry conflicts, nonexistent/deleted campaign conversion, header/CORS policy, malicious upstream routing strings/secrets, UTF-8 aggregate polling caps, continuation metadata, and public projection leak checks.

Verification:

```text
npx tsx --test tests/evidence-analyzer.test.ts tests/evidence-auth.test.ts tests/evidence-domain.test.ts tests/evidence-jobs.test.ts tests/evidence-review.test.ts tests/evidence-routes.test.ts tests/evidence-service.test.ts tests/evidence-storage.test.ts
149 passed, 0 failed

npm test
47 domain + 16 route/component + production build + 3 rendered HTML tests passed

npm run lint
passed

git diff --check
passed
```

Fix Round 1 concern: the repository's standalone `tsc --noEmit` command remains unusable because the existing TypeScript configuration rejects the project's `.ts` import convention and lacks Cloudflare ambient types, alongside unrelated pre-existing application type errors. The required lint, production build, full project tests, and complete evidence matrix pass.
