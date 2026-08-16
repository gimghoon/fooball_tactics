# Coach Evidence Bundle & LLM Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자가 코치 문서와 영상 구간을 근거 묶음으로 저장하고, 해당 근거만 사용하는 LLM 분석 초안을 직접 검수해 승인된 카드만 기존 시나리오 초안 단계로 보낼 수 있게 한다.

**Architecture:** D1을 워크플로 상태·버전·감사 로그의 권위 저장소로, R2 `EVIDENCE_FILES`를 원본 및 추출 텍스트 저장소로 사용한다. 서버 도메인 계층이 검증·상태 전이·근거 무결성을 담당하고, `EvidenceAnalyzer` 어댑터와 lease 기반 단계 실행기가 LLM 호출을 격리한다. `/admin/evidence`는 서버에서 관리자 권한을 확인한 뒤 네 단계 클라이언트 마법사를 제공하며 공개 훈련 API에는 승인 전 데이터를 투영하지 않는다.

**Tech Stack:** Next.js/Vinext, React 19, TypeScript 5.9, Cloudflare D1/R2, Drizzle ORM, `pdfjs-dist` 6.2.108, OpenAI-compatible server HTTP API, Node test runner, happy-dom, ESLint

## Global Constraints

- 관리자 화면과 모든 evidence API는 Sites 로그인 사용자 중 `EVIDENCE_ADMIN_USER_IDS`에 등록된 사용자 ID만 접근한다.
- 허용 파일은 PDF, TXT, Markdown이며 파일당 최대 크기는 정확히 20 MiB(20 × 1024 × 1024 bytes)다.
- 영상은 HTTPS URL만 허용하고 `startMs >= 0`, `endMs > startMs`를 만족해야 한다.
- R2 논리 바인딩 이름은 `EVIDENCE_FILES`이며 원본 파일명은 표시 메타데이터일 뿐 저장 키에 사용하지 않는다.
- LLM 비밀키·모델·제공자 응답은 서버 밖으로 노출하지 않는다.
- LLM은 업로드된 근거 청크와 운영자 관찰 메모만 사용하며 모든 행동·이유는 하나 이상의 유효한 근거를 참조해야 한다.
- `low` 확신도, 미해결 충돌, 빈 근거, 잘못된 참조가 있는 카드는 승인할 수 없다.
- 카드 상태는 `analysis_draft | owner_reviewed | coach_reviewed | held | rejected`, 작업 상태는 `queued | running | review_ready | completed | failed`만 사용한다.
- 근거 묶음 버전이 바뀌면 이전 분석·승인은 stale 처리하고 시나리오 초안 전환을 차단한다.
- 승인 카드는 시나리오 `draft`만 만들 수 있으며 기존 출처·타임라인·설명 검수 게이트를 우회하지 않는다.
- 원본 영상 업로드, 웹 자동 수집, OCR, 다중 관리자 동시 편집, 자동 공개는 구현하지 않는다.
- Node.js 최소 버전은 `22.13.0`이며 PDF 텍스트 계층 추출에는 `pdfjs-dist` `6.2.108`만 새 런타임 의존성으로 추가한다.

---

## File Map

- `db/schema.ts`: evidence D1 테이블·enum·인덱스 정의.
- `drizzle/0004_*.sql`, `drizzle/meta/*`: 생성된 additive migration과 Drizzle 스냅샷.
- `.openai/hosting.json`: R2 논리 바인딩 `EVIDENCE_FILES` 선언.
- `lib/domain/evidence.ts`: 입력 타입, 파일/영상 검증, 버전 해시, 카드 스키마, 상태 전이 규칙.
- `lib/server/evidence-auth.ts`: 로그인 사용자 관리자 allowlist 판정과 API/페이지 가드.
- `lib/server/evidence-storage.ts`: R2 put/get/delete와 D1 메타데이터 조합.
- `lib/server/evidence-analyzer.ts`: 공급자 독립 분석 인터페이스, 구조화 출력 파서.
- `lib/server/openai-evidence-analyzer.ts`: 서버 환경 기반 LLM HTTP 어댑터.
- `lib/server/evidence-jobs.ts`: D1 lease, 단계 실행, 재개, 부분 실패, 중복 방지.
- `lib/server/evidence-service.ts`: 묶음 CRUD, 변경 시 버전 증가·stale 처리, 카드 검수·초안 전환.
- `app/api/admin/evidence/**/route.ts`: 관리자 전용 HTTP 경계.
- `app/admin/evidence/page.tsx`: 관리자 서버 페이지.
- `app/admin/evidence/EvidenceWizard.tsx`: 네 단계 마법사와 폴링·검수 UI.
- `app/admin/evidence/evidence-admin.css`: 모바일 우선 관리자 전용 스타일.
- `tests/evidence-domain.test.ts`: 순수 검증·상태 전이·카드 근거 테스트.
- `tests/evidence-auth.test.ts`: 관리자 경계 테스트.
- `tests/evidence-jobs.test.ts`: 분석 파이프라인과 lease/retry 테스트.
- `tests/evidence-routes.test.ts`: API 계약·비공개 데이터 테스트.
- `tests/evidence-components.test.tsx`: 마법사와 카드 검수 상호작용 테스트.

### Task 1: Evidence domain model and additive D1 schema

**Files:**
- Create: `lib/domain/evidence.ts`
- Modify: `db/schema.ts`
- Create: `tests/evidence-domain.test.ts`
- Generate: `drizzle/0004_*.sql`, `drizzle/meta/*`

**Interfaces:**
- Produces: `EvidenceBundleInput`, `VideoClipInput`, `TacticCardContent`, `parseBundleInput()`, `parseVideoClip()`, `parseTacticCardContent()`, `assertCardReviewTransition()`, `computeEvidenceVersion()`.
- Produces D1 tables: `evidenceBundles`, `evidenceSources`, `evidenceVideoClips`, `evidenceChunks`, `evidenceAnalysisJobs`, `tacticCards`, `tacticCardCitations`, `tacticCardReviews`, `evidenceAuditEvents`.

- [ ] **Step 1: Write failing domain tests**

```ts
test("video clips require HTTPS and increasing timecodes", () => {
  assert.throws(() => parseVideoClip({ url: "http://x.test/v", startMs: 0, endMs: 10, observation: "압박" }));
  assert.throws(() => parseVideoClip({ url: "https://x.test/v", startMs: 10, endMs: 10, observation: "압박" }));
  assert.deepEqual(parseVideoClip({ url: "https://x.test/v", startMs: 0, endMs: 10, observation: "압박" }).startMs, 0);
});

test("a reviewable card requires supported actions and reasons", () => {
  const card = validCard({ preferred: [{ action: "pass", reason: "측면 지원", citationIds: [] }] });
  assert.throws(() => assertCardReviewTransition("owner_reviewed", card, new Set(["chunk-1"])));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test tests/evidence-domain.test.ts`

Expected: FAIL because `lib/domain/evidence.ts` does not exist.

- [ ] **Step 3: Implement exact domain contracts**

```ts
export type CardReviewStatus = "analysis_draft" | "owner_reviewed" | "coach_reviewed" | "held" | "rejected";
export type AnalysisJobStatus = "queued" | "running" | "review_ready" | "completed" | "failed";
export type Confidence = "high" | "medium" | "low";
export type CardAction = { action: "pass" | "dribble" | "move"; reason: string; citationIds: string[] };
export type TacticCardContent = {
  situation: string; conditions: string[]; defenseType: DefenseType; cues: string[];
  preferred: CardAction[]; alternatives: CardAction[]; risky: CardAction[];
  confidence: Confidence; uncertainties: string[]; conflicts: string[];
  scenarioSuitable: boolean; animationSuitable: boolean;
};

export function assertCardReviewTransition(status: CardReviewStatus, card: TacticCardContent, knownCitationIds: Set<string>) {
  if (status !== "owner_reviewed" && status !== "coach_reviewed") return;
  if (card.confidence === "low" || card.conflicts.length > 0) throw new EvidenceValidationError("낮은 확신도 또는 미해결 충돌이 있어 승인할 수 없습니다.");
  const actions = [...card.preferred, ...card.alternatives, ...card.risky];
  if (actions.some((item) => !item.reason.trim() || item.citationIds.length === 0 || item.citationIds.some((id) => !knownCitationIds.has(id)))) {
    throw new EvidenceValidationError("모든 행동과 이유에는 유효한 근거가 필요합니다.");
  }
}
```

`computeEvidenceVersion()`은 정렬된 source hash, clip fields, observation, analyzer model, prompt version, schema version을 canonical JSON으로 만든 뒤 Web Crypto SHA-256 hex를 반환한다.

- [ ] **Step 4: Add additive schema tables and indexes**

각 테이블은 `createdAt`, 변경 가능한 레코드는 `updatedAt`을 millisecond timestamp로 저장한다. `evidenceAnalysisJobs.inputVersion`에는 unique index를 두고, `tacticCards`에는 `bundleId`, `jobId`, `bundleVersion`, `status`, `draftContentJson`, `currentContentJson`, `isStale`을 저장한다. citation은 `(cardId, chunkId)` unique, audit는 `(bundleId, createdAt)` index를 둔다.

- [ ] **Step 5: Generate and inspect migration**

Run: `npm run db:generate`

Expected: 새 `drizzle/0004_*.sql`이 기존 테이블을 drop/recreate하지 않고 evidence 테이블과 인덱스만 추가한다.

- [ ] **Step 6: Run tests and commit**

Run: `npx tsx --test tests/evidence-domain.test.ts && npm run lint`

Expected: PASS and zero ESLint errors.

```bash
git add db/schema.ts lib/domain/evidence.ts tests/evidence-domain.test.ts drizzle
git commit -m "feat: add evidence workflow domain model"
```

### Task 2: Administrator authorization boundary

**Files:**
- Create: `lib/server/evidence-auth.ts`
- Create: `tests/evidence-auth.test.ts`
- Modify: `app/chatgpt-auth.ts`

**Interfaces:**
- Consumes: `ChatGPTUser`, `getChatGPTUser()`.
- Produces: `parseAdminUserIds(raw: string | undefined): Set<string>`, `authorizeEvidenceAdmin(user, raw): EvidenceAdmin | null`, `requireEvidenceAdminPage(returnTo): Promise<EvidenceAdmin>`, `requireEvidenceAdminApi(request): Promise<EvidenceAdmin | Response>`.

- [ ] **Step 1: Write failing authorization tests**

```ts
test("only exact allowlisted user IDs are admins", () => {
  const user = { userId: "user-2", email: "a@x.test", displayName: "A", fullName: null };
  assert.equal(authorizeEvidenceAdmin(user, "user-1,user-2")?.userId, "user-2");
  assert.equal(authorizeEvidenceAdmin(user, "user-20"), null);
});

test("missing login is 401 and logged-in non-admin is 403", async () => {
  assert.equal((await requireEvidenceAdminApiWith(null, "user-1")).status, 401);
  assert.equal((await requireEvidenceAdminApiWith({ ...user, userId: "user-2" }, "user-1")).status, 403);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-auth.test.ts`

Expected: FAIL because the authorization module is absent.

- [ ] **Step 3: Implement fail-closed authorization**

Trim comma-separated IDs, discard empty values, and compare `user.userId` exactly. Page access redirects unauthenticated users through existing ChatGPT sign-in and sends authenticated non-admin users to `/`; API access returns Korean JSON errors with 401/403. Never accept email, nickname, query parameter, cookie, or client header as admin authority.

- [ ] **Step 4: Run tests and commit**

Run: `npx tsx --test tests/evidence-auth.test.ts && npm run lint`

Expected: PASS.

```bash
git add app/chatgpt-auth.ts lib/server/evidence-auth.ts tests/evidence-auth.test.ts
git commit -m "feat: guard evidence administration"
```

### Task 3: File validation and R2 persistence

**Files:**
- Modify: `.openai/hosting.json`
- Create: `lib/server/evidence-storage.ts`
- Create: `lib/server/evidence-text-extractor.ts`
- Create: `tests/evidence-storage.test.ts`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `EvidenceFileStore` with `putValidatedFile(input): Promise<StoredEvidenceFile>`, `getFile(key)`, `deleteFilePair(originalKey, extractedKey)`.
- Produces: `validateEvidenceFile({ name, type, bytes }): Promise<{ kind; sha256; bytes }>`.
- Produces: `extractEvidenceText(kind, bytes): Promise<ExtractedPage[]>`, where `ExtractedPage = { locator: string; text: string }`.

- [ ] **Step 1: Write failing boundary tests**

```ts
test("accepts the exact 20 MiB boundary and rejects one byte over", async () => {
  await assert.doesNotReject(() => validateEvidenceFile(textFile(20 * 1024 * 1024)));
  await assert.rejects(() => validateEvidenceFile(textFile(20 * 1024 * 1024 + 1)), /20MB/);
});

test("rejects MIME, extension, signature, archive, executable, and encrypted PDF mismatches", async () => {
  await assert.rejects(() => validateEvidenceFile(fakePdfWithZipSignature()), /형식/);
  await assert.rejects(() => validateEvidenceFile(encryptedPdf()), /암호화/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-storage.test.ts`

Expected: FAIL because storage validation is absent.

- [ ] **Step 3: Add the logical R2 binding**

Set `.openai/hosting.json` field `"r2": "EVIDENCE_FILES"` while preserving `project_id` and `d1`.

- [ ] **Step 4: Install the one PDF parsing dependency**

Run: `npm install --save-exact pdfjs-dist@6.2.108`

Expected: `package.json` and lockfile contain exactly `pdfjs-dist: "6.2.108"`; no other direct dependency is added.

- [ ] **Step 5: Implement validation, text extraction, and opaque storage keys**

Accept `.pdf` with `application/pdf` and `%PDF-` signature; accept `.txt`, `.md`, `.markdown` with allowed text MIME and reject NUL bytes or executable/archive signatures. Detect `/Encrypt` in the PDF trailer/body and reject it. Generate keys as `bundles/{bundleId}/{sourceId}/{crypto.randomUUID()}-{sha256}` and store original name only in D1 metadata. Same bundle+sha256 returns the existing source rather than duplicating the R2 object.

For PDF, call `getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false })`, read each page's text content, join adjacent string items with spaces, and emit locators `page:1`, `page:2`, etc. For TXT/Markdown, decode strict UTF-8 and split non-empty paragraphs into locators `paragraph:1`, `paragraph:2`, etc. If a PDF page has no text items, mark that source `extraction_failed` with `스캔 PDF는 OCR을 지원하지 않습니다.` rather than calling OCR.

- [ ] **Step 6: Run tests and commit**

Run: `npx tsx --test tests/evidence-storage.test.ts && npm run lint`

Expected: PASS.

```bash
git add .openai/hosting.json package.json package-lock.json lib/server/evidence-storage.ts lib/server/evidence-text-extractor.ts tests/evidence-storage.test.ts
git commit -m "feat: store validated evidence files in R2"
```

### Task 4: Evidence bundle CRUD, versioning, and invalidation

**Files:**
- Create: `lib/server/evidence-service.ts`
- Create: `tests/evidence-service.test.ts`

**Interfaces:**
- Consumes: domain parsers, schema tables, `EvidenceFileStore`.
- Produces: `createBundle()`, `updateBundle()`, `addVideoClip()`, `removeSource()`, `getBundleForAdmin()`, `listBundlesForAdmin()`, `describeDeleteImpact()`.

- [ ] **Step 1: Write failing service tests**

```ts
test("changing source observations increments version and stales prior cards", async () => {
  const bundle = await service.createBundle(validBundleInput(), admin);
  await seedApprovedCard(bundle.id, bundle.version);
  const changed = await service.updateBundle(bundle.id, { observation: "새 관찰" }, admin);
  assert.equal(changed.version, bundle.version + 1);
  assert.equal((await cards(bundle.id))[0].isStale, true);
});

test("linked cards block deletion and report impact", async () => {
  const impact = await service.describeDeleteImpact("source-1");
  assert.deepEqual(impact.cardIds, ["card-1"]);
  await assert.rejects(() => service.removeSource("source-1", admin), /연결/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-service.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement transactional mutations**

Every write records `{ actorUserId, action, targetType, targetId, detailsJson, createdAt }` in `evidenceAuditEvents`. Content-bearing changes increment `bundle.version`, recompute `contentVersion`, mark earlier jobs/cards stale, and clear their approval eligibility in one D1 transaction. Metadata-only title changes keep the content version. Deletion first returns impact; a confirmed delete is allowed only when no card or scenario draft references the source, then deletes both R2 keys and D1 rows.

- [ ] **Step 4: Run tests and commit**

Run: `npx tsx --test tests/evidence-service.test.ts && npm run lint`

Expected: PASS.

```bash
git add lib/server/evidence-service.ts tests/evidence-service.test.ts
git commit -m "feat: manage versioned evidence bundles"
```

### Task 5: Analyzer contract and grounded structured output

**Files:**
- Create: `lib/server/evidence-analyzer.ts`
- Create: `lib/server/openai-evidence-analyzer.ts`
- Create: `tests/evidence-analyzer.test.ts`

**Interfaces:**
- Produces: `EvidenceAnalyzer.analyzeExtraction(input, signal)`, `generateCards(input, signal)`.
- Produces: `createConfiguredEvidenceAnalyzer(env)` reading `EVIDENCE_LLM_ENDPOINT`, `EVIDENCE_LLM_API_KEY`, `EVIDENCE_LLM_MODEL` only on the server.

- [ ] **Step 1: Write failing parser and adapter tests**

```ts
test("rejects malformed JSON and unknown citation IDs", () => {
  assert.throws(() => parseAnalyzerCards("not-json", knownChunks), /JSON/);
  assert.throws(() => parseAnalyzerCards(JSON.stringify([cardWithCitation("unknown")]), knownChunks), /근거/);
});

test("provider secrets and raw response never appear in returned cards", async () => {
  const cards = await analyzer.generateCards(input, AbortSignal.timeout(1000));
  assert.equal(JSON.stringify(cards).includes("secret-key"), false);
  assert.equal("providerResponse" in cards[0], false);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-analyzer.test.ts`

Expected: FAIL because analyzer modules are absent.

- [ ] **Step 3: Implement two-stage provider-neutral contracts**

```ts
export interface EvidenceAnalyzer {
  readonly modelId: string;
  analyzeExtraction(input: { chunks: EvidenceChunkInput[]; promptVersion: string }, signal: AbortSignal): Promise<ExtractedEvidence[]>;
  generateCards(input: { extracted: ExtractedEvidence[]; allowedCitationIds: string[]; promptVersion: string; schemaVersion: string }, signal: AbortSignal): Promise<TacticCardContent[]>;
}
```

The system instruction must state: use only supplied evidence, never add general tactical knowledge, preserve conflicts, split differing conditions, and cite every action/reason. Parse JSON into domain types and reject unknown fields, unknown defense/action enums, empty strings, empty citation lists, and citations outside `allowedCitationIds`.

- [ ] **Step 4: Implement the initial server HTTP adapter**

POST to the configured HTTPS endpoint with `{ model, instructions, input, response_format: { type: "json_schema", json_schema } }`; use a 30-second `AbortSignal`, map 408/429/5xx to retryable errors, map 400/401/403 to terminal configuration errors, and never include API keys or raw bodies in thrown messages. This adapter remains behind `EvidenceAnalyzer`, so a provider swap does not alter stored card JSON.

- [ ] **Step 5: Run tests and commit**

Run: `npx tsx --test tests/evidence-analyzer.test.ts && npm run lint`

Expected: PASS.

```bash
git add lib/server/evidence-analyzer.ts lib/server/openai-evidence-analyzer.ts tests/evidence-analyzer.test.ts
git commit -m "feat: add grounded evidence analyzer"
```

### Task 6: Lease-based resumable analysis jobs

**Files:**
- Create: `lib/server/evidence-jobs.ts`
- Create: `tests/evidence-jobs.test.ts`

**Interfaces:**
- Consumes: `EvidenceAnalyzer`, R2 store, D1 evidence tables.
- Produces: `startAnalysis(bundleId, admin)`, `runAnalysisStep(jobId)`, `retryAnalysis(jobId, admin)`, `getAnalysisStatus(jobId)`.

- [ ] **Step 1: Write failing job tests**

```ts
test("same input version deduplicates analysis jobs", async () => {
  const first = await jobs.startAnalysis("bundle-1", admin);
  const second = await jobs.startAnalysis("bundle-1", admin);
  assert.equal(second.id, first.id);
});

test("expired lease resumes from last completed stage", async () => {
  await seedJob({ stage: "chunks_ready", leaseUntil: past });
  await jobs.runAnalysisStep("job-1");
  assert.deepEqual(analyzer.calls, ["extract", "cards"]);
});

test("partial extraction failure preserves successful sources", async () => {
  await jobs.runAnalysisStep("job-1");
  assert.deepEqual(await sourceStates(), [{ id: "ok", status: "ready" }, { id: "bad", status: "failed" }]);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-jobs.test.ts`

Expected: FAIL because the job runner is absent.

- [ ] **Step 3: Implement stages and compare-and-set leases**

Stages are `validate_sources → extract_text → normalize_clips → extract_evidence → generate_cards → persist_cards → done`. Acquire a 60-second lease only when `leaseUntil` is null/expired or owned by the same runner; write stage output before advancing. Retry retryable analyzer failures at most 3 times with persisted `attemptCount`; invalid JSON gets the same bounded retry, while configuration errors fail immediately. Persist source-level failure details without discarding other valid chunks.

- [ ] **Step 4: Trigger continuation independently of browser polling**

`startAnalysis()` commits the queued record and schedules `runAnalysisStep(job.id)` using the platform request context continuation hook. Each completed stage schedules the next stage. `GET status` only reads D1 and never advances work. An expired job is resumed by explicit retry or a subsequent start with the same input version.

- [ ] **Step 5: Run tests and commit**

Run: `npx tsx --test tests/evidence-jobs.test.ts && npm run lint`

Expected: PASS.

```bash
git add lib/server/evidence-jobs.ts tests/evidence-jobs.test.ts
git commit -m "feat: run resumable evidence analysis jobs"
```

### Task 7: Card review, immutable versions, and scenario draft conversion

**Files:**
- Modify: `lib/server/evidence-service.ts`
- Create: `tests/evidence-review.test.ts`

**Interfaces:**
- Produces: `reviewCard(cardId, command, admin)`, `createScenarioDraft(cardId, input, admin)`.
- Consumes existing `ScenarioContent`, scenario `reviewStatus: "draft"`.

- [ ] **Step 1: Write failing review tests**

```ts
test("owner edits retain original and reviewed snapshots", async () => {
  await service.reviewCard("card-1", { status: "owner_reviewed", content: editedCard }, admin);
  const versions = await cardVersions("card-1");
  assert.deepEqual(versions.map((v) => v.kind), ["llm_draft", "owner_edit"]);
});

test("only current approved cards create draft scenarios", async () => {
  await assert.rejects(() => service.createScenarioDraft("draft-card", scenarioInput, admin), /승인/);
  const result = await service.createScenarioDraft("approved-card", scenarioInput, admin);
  assert.equal(result.reviewStatus, "draft");
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-review.test.ts`

Expected: FAIL because card review methods are absent.

- [ ] **Step 3: Implement CAS review and audit snapshots**

Review commands include `expectedUpdatedAt`; update only when it matches. Store the untouched LLM draft, each edited content snapshot, actor ID, timestamp, bundle version, and citation snapshot. Apply `assertCardReviewTransition()` before approval. `held` and `rejected` remain visible to the admin but cannot convert.

- [ ] **Step 4: Implement scenario draft conversion without publication**

Require current bundle version, non-stale card, `owner_reviewed | coach_reviewed`, `scenarioSuitable`, and `animationSuitable`. Create scenario content with `review: { sourceReviewed: false, timelineReviewed: false, explanationsReviewed: false }`, `reviewStatus: "draft"`, and provenance linking the card snapshot. Do not set `reviewedContentJson`, `reviewerName`, or `reviewedAt`; therefore existing `playableScenarios()` and public campaign queries exclude it.

- [ ] **Step 5: Run tests and commit**

Run: `npx tsx --test tests/evidence-review.test.ts tests/review-route.test.ts tests/domain.test.ts`

Expected: PASS, including all existing publication gates.

```bash
git add lib/server/evidence-service.ts tests/evidence-review.test.ts
git commit -m "feat: review evidence cards into scenario drafts"
```

### Task 8: Admin-only evidence HTTP API

**Files:**
- Create: `app/api/admin/evidence/route.ts`
- Create: `app/api/admin/evidence/[bundleId]/route.ts`
- Create: `app/api/admin/evidence/[bundleId]/files/route.ts`
- Create: `app/api/admin/evidence/[bundleId]/clips/route.ts`
- Create: `app/api/admin/evidence/[bundleId]/analyze/route.ts`
- Create: `app/api/admin/evidence/jobs/[jobId]/route.ts`
- Create: `app/api/admin/evidence/cards/[cardId]/review/route.ts`
- Create: `app/api/admin/evidence/cards/[cardId]/scenario-draft/route.ts`
- Create: `tests/evidence-routes.test.ts`

**Interfaces:**
- JSON list/create/update, multipart file upload, analysis start/status, card review and draft conversion endpoints.

- [ ] **Step 1: Write failing route contract tests**

```ts
test("every evidence endpoint rejects non-admin access", async () => {
  for (const invoke of endpointInvocations) assert.ok([401, 403].includes((await invoke(nonAdmin)).status));
});

test("public campaign and room responses never contain evidence fields", async () => {
  const body = JSON.stringify(await publicCampaignResponse());
  for (const secret of ["extractedText", "draftContentJson", "llm", "storageKey"]) assert.equal(body.includes(secret), false);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-routes.test.ts`

Expected: FAIL because the routes are absent.

- [ ] **Step 3: Implement routes as thin guarded adapters**

Call `requireEvidenceAdminApi()` before parsing request bodies or querying whether a record exists. Return 400 for malformed input, 404 for an authorized missing resource, 409 for stale/CAS/blocked-delete conflicts, 413 for oversized files, 415 for format mismatch, and 503 for unavailable storage/analyzer configuration. File download must use an authenticated route with `Content-Disposition: attachment` and escaped display filename; never expose an R2 key or public URL.

- [ ] **Step 4: Run tests and commit**

Run: `npx tsx --test tests/evidence-routes.test.ts tests/review-route.test.ts && npm run lint`

Expected: PASS.

```bash
git add app/api/admin/evidence tests/evidence-routes.test.ts
git commit -m "feat: expose guarded evidence workflow APIs"
```

### Task 9: Four-step admin wizard and intuitive review UI

**Files:**
- Create: `app/admin/evidence/page.tsx`
- Create: `app/admin/evidence/EvidenceWizard.tsx`
- Create: `app/admin/evidence/evidence-admin.css`
- Create: `tests/evidence-components.test.tsx`

**Interfaces:**
- Consumes Task 8 endpoints.
- Produces four stages: `자료 정보`, `근거 추가`, `분석 확인`, `카드 검수`.

- [ ] **Step 1: Write failing mounted UI tests**

```tsx
test("cannot start analysis before explicit confirmation", async () => {
  render(<EvidenceWizard initialBundles={[]} />);
  await fillBundleAndUploadEvidence();
  assert.equal(button("분석 시작").disabled, true);
  click(checkbox("등록한 자료만 분석한다는 점을 확인했습니다"));
  assert.equal(button("분석 시작").disabled, false);
});

test("card review shows evidence beside action reasons", async () => {
  render(<EvidenceWizard initialBundles={[reviewReadyBundle]} />);
  click(text("카드 검수"));
  assert.ok(text("근거 C-2 · 문서 3쪽"));
  assert.ok(text("드리블 권장 이유"));
});
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test tests/evidence-components.test.tsx`

Expected: FAIL because the wizard is absent.

- [ ] **Step 3: Implement the protected server page and four-step state machine**

The server page calls `requireEvidenceAdminPage("/admin/evidence")`. The client keeps only form drafts locally; saved bundle/job/card state always refreshes from the API. Step 2 supports per-file success/error and retry, multiple video clips, duplicate warnings, and HH:MM:SS inputs normalized to milliseconds. Step 3 shows the exact source inventory and requires explicit confirmation before `분석 시작`.

- [ ] **Step 4: Make analysis and coach review visually direct**

Poll a running job every 2 seconds and stop on `review_ready | completed | failed` or unmount. Present stage, source-level failures, retry action, and stale warning. In review, use a two-column desktop/single-column mobile layout: source excerpt/timecode on one side; condition, defense type, cue, preferred/alternative/risky action and reason on the other. Selecting a citation scrolls/highlights its excerpt. Show animation suitability as `관찰 → 선택 → 결과 → 기억` preview labels; approval controls remain disabled until every action/reason displays at least one source badge. Use Korean status labels while retaining stable enum values in API payloads.

- [ ] **Step 5: Add accessible interactions and deletion impact dialog**

All steps, tabs, uploads, citations, status changes, and dialogs must be keyboard operable with visible focus. Announce upload/job status through `aria-live="polite"`; errors use `role="alert"`. Before delete, fetch and list affected cards/scenario drafts and disable confirmation while references exist.

- [ ] **Step 6: Run tests and commit**

Run: `npx tsx --test tests/evidence-components.test.tsx && npm run lint`

Expected: PASS and zero accessibility lint errors.

```bash
git add app/admin/evidence tests/evidence-components.test.tsx
git commit -m "feat: add coach evidence review wizard"
```

### Task 10: Full privacy, migration, build, and deployment-readiness verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-16-evidence-bundle-llm-analysis-design.md` only if implementation exposes a verified constraint that the approved spec must record.

**Interfaces:**
- Documents required server configuration: `EVIDENCE_ADMIN_USER_IDS`, `EVIDENCE_LLM_ENDPOINT`, `EVIDENCE_LLM_API_KEY`, `EVIDENCE_LLM_MODEL`, D1 `DB`, R2 `EVIDENCE_FILES`.

- [ ] **Step 1: Add operational documentation**

Document configuration names without values, 20 MiB/file limits, HTTPS timecodes, supported file types, manual analysis start, retry behavior, stale invalidation, owner review meaning, and the rule that approved cards only create unreviewed scenario drafts. State that deleting a lost anonymous return key remains unrelated and unrecoverable.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: all domain, route, component, build, and rendered HTML tests pass.

- [ ] **Step 3: Run static verification**

Run: `npm run lint && npm run build`

Expected: zero lint errors and successful Vinext production build.

- [ ] **Step 4: Inspect migration and public-data boundary**

Run: `git diff origin/codex/dribbling-defense-scenarios...HEAD -- drizzle .openai/hosting.json db/schema.ts app/api/campaigns app/api/rooms lib/server/training.ts`

Expected: migration is additive, the logical R2 binding is present, and no public API projection selects evidence tables or fields.

- [ ] **Step 5: Verify the production package has no secrets**

Run: `rg -n "EVIDENCE_LLM_API_KEY|secret-key|storageKey|extractedText" dist .next 2>/dev/null`

Expected: no secret value and no admin evidence payload in public client chunks; server-side symbol names may appear only in server output.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md docs/superpowers/specs/2026-08-16-evidence-bundle-llm-analysis-design.md
git commit -m "docs: explain evidence analysis operations"
```

- [ ] **Step 7: Request code review before publication**

Use `superpowers:requesting-code-review`, address any proven correctness or privacy issues, repeat Steps 2–5, then use `superpowers:finishing-a-development-branch`. Do not deploy or push without the user's explicit publication choice.

---

## Acceptance Traceability

- Admin isolation: Tasks 2, 8, 9.
- File/MIME/signature/size and HTTPS timecodes: Tasks 1, 3, 8.
- D1/R2 persistence, duplicate prevention, safe deletion: Tasks 1, 3, 4.
- Grounded two-stage LLM extraction, conflicts, confidence and citations: Task 5.
- Async lease/resume, browser independence, partial failure and bounded retry: Task 6.
- Owner review, immutable snapshots, stale invalidation and CAS: Tasks 4, 7.
- Approved-card-only scenario draft and existing review gates: Task 7.
- Four-step wizard and intuitive source/action/animation explanation: Task 9.
- Public-data privacy and production verification: Tasks 8, 10.
