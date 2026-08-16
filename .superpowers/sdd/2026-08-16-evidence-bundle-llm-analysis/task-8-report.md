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

## Fix Round 2

Status: both Important findings from `task-8-rereview-1.md` are addressed.

- PDF validation now traverses every PDF.js page and content stream before the first R2 write, with `stopAtErrors` enabled. Because PDF.js deliberately recovers some corrupt Flate streams as empty content, validation also drains every directly Flate-encoded stream through the platform `DecompressionStream` before page traversal. A corrupt `/FlateDecode` page is therefore rejected as 415 with zero objects and zero metadata instead of being mislabeled scan-only.
- The bounded PDF.js extraction result is retained on the validated file and reused after original-object persistence, removing the former duplicate document/page parse. Existing page, UTF-8 output, interruption, and deadline limits remain enforced by the preflight extraction.
- Structurally valid textless PDFs remain accepted and stored as `extractionStatus: failed` with the scan/OCR message. Valid uncompressed and Flate-compressed text PDFs remain accepted with completed extracted text.
- The upload adapter now passes `EvidencePublicError` through centralized typed routing after store cleanup. Real-store registration CAS and deleted-bundle failures clean both R2 objects, return fixed redacted 409/404 responses, and do not leak the thrown message. Unknown storage/provider failures remain fixed redacted 503 responses.

Fix-round regression coverage includes a structurally loadable PDF with a corrupt Flate page stream, valid scan-only and text PDFs through the real HTTP handler, a valid compressed text PDF, zero-write assertions, and real-store cleanup followed by typed 409/404 propagation.

Verification:

```text
npx tsx --test tests/evidence-analyzer.test.ts tests/evidence-auth.test.ts tests/evidence-domain.test.ts tests/evidence-jobs.test.ts tests/evidence-review.test.ts tests/evidence-routes.test.ts tests/evidence-service.test.ts tests/evidence-storage.test.ts
152 passed, 0 failed

npm test
47 domain + 16 route/component + production build + 3 rendered HTML tests passed

npm run lint
passed

git diff --check
passed
```

No new concerns. The pre-existing standalone `tsc --noEmit` configuration limitation documented in Fix Round 1 is unchanged; the required lint, production build, full project tests, and complete evidence matrix pass.

## Fix Round 3

Status: both Important Flate-validator findings from `task-8-rereview-2.md` are addressed.

- Replaced the whole-file Latin-1 regular-expression scan with a bounded PDF object/dictionary tokenizer. It recognizes stream dictionaries only at indirect-object boundaries, jumps over payloads by their declared byte length, decodes PDF name `#xx` escapes, and recognizes direct `/FlateDecode`, `/Fl`, escaped equivalents, and single-filter arrays. Unresolved lengths, filters, dictionaries, excessive nesting/tokens/objects/streams, and unsupported multi-filter pipelines fail closed as typed PDF validation errors.
- Flate validation now streams decompressed output without retaining chunks. Production limits cap decoded output at 2 MiB per stream and 4 MiB aggregate, below the existing 5 MiB extracted-text budget. Every read is raced against the shared 10-second extraction deadline, observes the caller `AbortSignal`, and cancels/releases its reader on overflow, timeout, abort, or decompressor failure.
- The remaining shared deadline is passed into the existing PDF.js page/content preflight, whose extracted pages are still reused after persistence. No duplicate PDF.js traversal was reintroduced.
- Escaped corrupt filters now return HTTP 415 with zero R2 objects and zero metadata. Valid compressed text, scan-only pages, and a valid uncompressed stream containing filter-like syntax bytes remain accepted.

Fix-round regression coverage includes `/Flate#44ecode`, `[/F#6c]`, stream-payload false positives, a small fake decompression bomb with cancellation, multiple-stream aggregate overflow, deadline cancellation, abort cancellation, valid compressed text, route-level 415 mapping, and zero-write assertions.

Verification:

```text
npx tsx --test tests/evidence-storage.test.ts tests/evidence-routes.test.ts
49 passed, 0 failed

npx tsx --test tests/evidence-analyzer.test.ts tests/evidence-auth.test.ts tests/evidence-domain.test.ts tests/evidence-jobs.test.ts tests/evidence-review.test.ts tests/evidence-routes.test.ts tests/evidence-service.test.ts tests/evidence-storage.test.ts
158 passed, 0 failed

npm test
47 domain + 16 route/component + production build + 3 rendered HTML tests passed

npm run lint
passed

git diff --check
passed
```

Concern: the security preflight deliberately rejects indirect `/Length` values and multi-stage filter pipelines instead of accepting streams it cannot validate with the bounded supported subset. This is fail-closed behavior, but PDFs using those otherwise-valid encodings must be normalized before upload. The pre-existing standalone `tsc --noEmit` configuration limitation documented in Fix Round 1 is unchanged.
