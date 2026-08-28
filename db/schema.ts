import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(), title: text("title").notNull(), formation: text("formation").notNull(),
  reviewStatus: text("review_status", { enum: ["draft", "pending", "reviewed"] }).notNull().default("pending"),
  sourceTitle: text("source_title"), sourceUrl: text("source_url"), reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
});

export const scenarios = sqliteTable("scenarios", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["fixo", "ala", "pivo", "recap"] }).notNull(),
  principle: text("principle", { enum: ["width", "support", "pivot", "transition"] }).notNull(),
  prompt: text("prompt").notNull(), hint: text("hint").notNull(), explanation: text("explanation").notNull(),
  pitchJson: text("pitch_json").notNull(), answerJson: text("answer_json").notNull(), contentJson: text("content_json").notNull().default(""),
  reviewStatus: text("review_status", { enum: ["draft", "pending", "reviewed"] }).notNull().default("pending"),
  sourceTitle: text("source_title"), sourceUrl: text("source_url"), reviewerName: text("reviewer_name"), reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  reviewedContentJson: text("reviewed_content_json"),
  orderIndex: integer("order_index").notNull(),
}, (table) => [index("idx_scenarios_campaign_order").on(table.campaignId, table.orderIndex)]);

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(), inviteCode: text("invite_code").notNull(), campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  ownerParticipantId: text("owner_participant_id"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_rooms_invite_code").on(table.inviteCode)]);

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  nickname: text("nickname").notNull(), tokenHash: text("token_hash").notNull(), isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  completedStage: text("completed_stage").notNull().default("intro"), removedAt: integer("removed_at", { mode: "timestamp_ms" }), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_participants_room_nickname").on(table.roomId, table.nickname)]);

export const attempts = sqliteTable("attempts", {
  eventId: text("event_id").primaryKey(), participantId: text("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
  scenarioId: text("scenario_id").notNull().references(() => scenarios.id), principle: text("principle").notNull(), correct: integer("correct", { mode: "boolean" }).notNull(),
  touchX: integer("touch_x").notNull(), touchY: integer("touch_y").notNull(), actionType: text("action_type", { enum: ["pass", "dribble", "move"] }).notNull().default("pass"), targetPlayerId: text("target_player_id"), pathJson: text("path_json"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_attempts_participant").on(table.participantId)]);

export const mastery = sqliteTable("mastery", {
  participantId: text("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }), principle: text("principle").notNull(),
  score: integer("score").notNull().default(0), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_mastery_participant_principle").on(table.participantId, table.principle)]);

export const reflections = sqliteTable("reflections", {
  id: text("id").primaryKey(), participantId: text("participant_id").notNull().references(() => participants.id, { onDelete: "cascade" }),
  missionId: text("mission_id").notNull(), result: text("result", { enum: ["worked", "difficult"] }).notNull(), note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_reflections_participant").on(table.participantId)]);

export const evidenceBundles = sqliteTable("evidence_bundles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  purpose: text("purpose").notNull(),
  version: integer("version").notNull().default(1),
  contentVersion: text("content_version").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const evidenceSources = sqliteTable("evidence_sources", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  origin: text("origin", { enum: ["uploaded", "external_web"] }).notNull().default("uploaded"),
  originalFileName: text("original_file_name").notNull(),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  contentHash: text("content_hash").notNull(),
  storageKey: text("storage_key").notNull(),
  canonicalUrl: text("canonical_url"),
  publisher: text("publisher"),
  publishedAt: text("published_at"),
  retrievedAt: integer("retrieved_at", { mode: "timestamp_ms" }),
  searchCandidateId: text("search_candidate_id"),
  externalTextHash: text("external_text_hash"),
  extractedTextKey: text("extracted_text_key"),
  extractionStatus: text("extraction_status", { enum: ["pending", "completed", "failed"] }).notNull().default("pending"),
  extractionError: text("extraction_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_evidence_sources_bundle_content_hash").on(table.bundleId, table.contentHash),
  uniqueIndex("idx_evidence_sources_bundle_canonical_url").on(table.bundleId, table.canonicalUrl).where(sql`${table.canonicalUrl} IS NOT NULL`),
  uniqueIndex("idx_evidence_sources_id_bundle").on(table.id, table.bundleId),
  check(
    "ck_evidence_sources_media_type_and_size",
    sql`${table.mediaType} IN ('application/pdf', 'text/plain', 'text/markdown') AND ${table.byteSize} BETWEEN 0 AND 20971520`,
  ),
]);

export const evidenceSearchRuns = sqliteTable("evidence_search_runs", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  inputVersion: text("input_version").notNull(),
  bundleVersion: integer("bundle_version").notNull(),
  status: text("status").notNull().default("queued"),
  searchModel: text("search_model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  queryJson: text("query_json").notNull(),
  errorMessage: text("error_message"),
  isStale: integer("is_stale", { mode: "boolean" }).notNull().default(false),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_evidence_search_runs_input").on(table.bundleId, table.inputVersion),
  uniqueIndex("idx_evidence_search_runs_id_bundle").on(table.id, table.bundleId),
]);

export const evidenceSearchCandidates = sqliteTable("evidence_search_candidates", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  bundleId: text("bundle_id").notNull(),
  url: text("url").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  title: text("title").notNull(),
  publisher: text("publisher").notNull(),
  publishedAt: text("published_at").notNull(),
  retrievedAt: integer("retrieved_at", { mode: "timestamp_ms" }),
  documentType: text("document_type").notNull(),
  quote: text("quote").notNull(),
  relevance: text("relevance").notNull(),
  trustTier: integer("trust_tier").notNull(),
  rank: integer("rank").notNull(),
  status: text("status").notNull().default("candidate"),
  selectedBy: text("selected_by"),
  selectedAt: integer("selected_at", { mode: "timestamp_ms" }),
  sourceId: text("source_id"),
  contentHash: text("content_hash"),
  failureReason: text("failure_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  foreignKey({
    name: "fk_search_candidate_run_bundle",
    columns: [table.runId, table.bundleId],
    foreignColumns: [evidenceSearchRuns.id, evidenceSearchRuns.bundleId],
  }).onDelete("cascade"),
  uniqueIndex("idx_search_candidate_run_url").on(table.runId, table.canonicalUrl),
  index("idx_search_candidate_bundle_status").on(table.bundleId, table.status),
]);

export const evidenceMutationReceipts = sqliteTable("evidence_mutation_receipts", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_evidence_mutation_receipts_bundle_source").on(table.bundleId, table.sourceId)]);

export const evidenceR2CleanupReceipts = sqliteTable("evidence_r2_cleanup_receipts", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull(),
  storageKey: text("storage_key"),
  extractedTextKey: text("extracted_text_key"),
  status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_evidence_r2_cleanup_status").on(table.status, table.updatedAt)]);

export const scenarioEvidenceSources = sqliteTable("scenario_evidence_sources", {
  scenarioId: text("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  sourceId: text("source_id").notNull().references(() => evidenceSources.id, { onDelete: "restrict" }),
}, (table) => [
  primaryKey({ columns: [table.scenarioId, table.sourceId] }),
  index("idx_scenario_evidence_sources_source").on(table.sourceId),
]);

export const evidenceVideoClips = sqliteTable("evidence_video_clips", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  observation: text("observation").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_evidence_video_clips_id_bundle").on(table.id, table.bundleId),
  check(
    "ck_evidence_video_clips_https_timecodes",
    sql`${table.url} LIKE 'https://%' AND ${table.startMs} >= 0 AND ${table.endMs} > ${table.startMs}`,
  ),
]);

export const evidenceChunks = sqliteTable("evidence_chunks", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  inputVersion: text("input_version").notNull(),
  sourceId: text("source_id"),
  videoClipId: text("video_clip_id"),
  ordinal: integer("ordinal").notNull(),
  locationLabel: text("location_label").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_evidence_chunks_id_bundle").on(table.id, table.bundleId),
  uniqueIndex("idx_evidence_chunks_source_input_ordinal").on(table.bundleId, table.inputVersion, table.sourceId, table.ordinal),
  uniqueIndex("idx_evidence_chunks_clip_input_ordinal").on(table.bundleId, table.inputVersion, table.videoClipId, table.ordinal),
  check("ck_evidence_chunks_exactly_one_provenance", sql`(${table.sourceId} IS NULL) != (${table.videoClipId} IS NULL)`),
  foreignKey({
    name: "fk_evidence_chunks_source_bundle",
    columns: [table.sourceId, table.bundleId],
    foreignColumns: [evidenceSources.id, evidenceSources.bundleId],
  }).onDelete("cascade"),
  foreignKey({
    name: "fk_evidence_chunks_video_clip_bundle",
    columns: [table.videoClipId, table.bundleId],
    foreignColumns: [evidenceVideoClips.id, evidenceVideoClips.bundleId],
  }).onDelete("cascade"),
]);

export const scenarioEvidenceChunks = sqliteTable("scenario_evidence_chunks", {
  scenarioId: text("scenario_id").notNull().references(() => scenarios.id, { onDelete: "cascade" }),
  chunkId: text("chunk_id").notNull().references(() => evidenceChunks.id, { onDelete: "restrict" }),
}, (table) => [
  primaryKey({ columns: [table.scenarioId, table.chunkId] }),
  index("idx_scenario_evidence_chunks_chunk").on(table.chunkId),
]);

export const evidenceAnalysisJobs = sqliteTable("evidence_analysis_jobs", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  inputVersion: text("input_version").notNull(),
  status: text("status", { enum: ["queued", "running", "review_ready", "completed", "failed"] }).notNull().default("queued"),
  analyzerModel: text("analyzer_model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  schemaVersion: text("schema_version").notNull(),
  stage: text("stage").notNull().default("validate_sources"),
  leaseOwner: text("lease_owner"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  errorMessage: text("error_message"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  attemptCount: integer("attempt_count").notNull().default(0),
  extractedEvidenceJson: text("extracted_evidence_json"),
  generatedCardsJson: text("generated_cards_json"),
  isStale: integer("is_stale", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_evidence_analysis_jobs_input_version").on(table.bundleId, table.inputVersion),
  uniqueIndex("idx_evidence_analysis_jobs_id_bundle").on(table.id, table.bundleId),
  check("ck_evidence_analysis_jobs_status", sql`${table.status} IN ('queued', 'running', 'review_ready', 'completed', 'failed')`),
  check(
    "ck_evidence_analysis_jobs_stage",
    sql`${table.stage} IN ('validate_sources', 'extract_text', 'normalize_clips', 'extract_evidence', 'generate_cards', 'persist_cards', 'done')`,
  ),
]);

export const tacticCards = sqliteTable("tactic_cards", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  jobId: text("job_id").notNull(),
  bundleVersion: text("bundle_version").notNull(),
  status: text("status", { enum: ["analysis_draft", "owner_reviewed", "coach_reviewed", "held", "rejected"] }).notNull().default("analysis_draft"),
  draftContentJson: text("draft_content_json").notNull(),
  currentContentJson: text("current_content_json").notNull(),
  currentReviewId: text("current_review_id"),
  isStale: integer("is_stale", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_tactic_cards_bundle_status").on(table.bundleId, table.status),
  uniqueIndex("idx_tactic_cards_id_bundle").on(table.id, table.bundleId),
  check("ck_tactic_cards_status", sql`${table.status} IN ('analysis_draft', 'owner_reviewed', 'coach_reviewed', 'held', 'rejected')`),
  foreignKey({
    name: "fk_tactic_cards_job_bundle",
    columns: [table.jobId, table.bundleId],
    foreignColumns: [evidenceAnalysisJobs.id, evidenceAnalysisJobs.bundleId],
  }).onDelete("cascade"),
]);

export const tacticCardCitations = sqliteTable("tactic_card_citations", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  cardId: text("card_id").notNull(),
  chunkId: text("chunk_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_tactic_card_citations_card_chunk").on(table.cardId, table.chunkId),
  foreignKey({
    name: "fk_tactic_card_citations_card_bundle",
    columns: [table.cardId, table.bundleId],
    foreignColumns: [tacticCards.id, tacticCards.bundleId],
  }).onDelete("cascade"),
  foreignKey({
    name: "fk_tactic_card_citations_chunk_bundle",
    columns: [table.chunkId, table.bundleId],
    foreignColumns: [evidenceChunks.id, evidenceChunks.bundleId],
  }).onDelete("cascade"),
]);

export const tacticCardReviews = sqliteTable("tactic_card_reviews", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => tacticCards.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id"),
  status: text("status", { enum: ["analysis_draft", "owner_reviewed", "coach_reviewed", "held", "rejected"] }).notNull(),
  versionKind: text("version_kind", { enum: ["llm_draft", "owner_edit", "coach_edit", "status_change"] }).notNull().default("status_change"),
  producerJobId: text("producer_job_id"),
  producerModel: text("producer_model"),
  contentJson: text("content_json").notNull(),
  citationSnapshotJson: text("citation_snapshot_json").notNull(),
  bundleVersion: text("bundle_version").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  check("ck_tactic_card_reviews_status", sql`${table.status} IN ('analysis_draft', 'owner_reviewed', 'coach_reviewed', 'held', 'rejected')`),
  check("ck_tactic_card_reviews_version_kind", sql`${table.versionKind} IN ('llm_draft', 'owner_edit', 'coach_edit', 'status_change')`),
  check("ck_tactic_card_reviews_attribution", sql`(
    ${table.versionKind} = 'llm_draft'
    AND ${table.actorUserId} IS NULL
    AND ${table.producerJobId} IS NOT NULL
    AND ${table.producerModel} IS NOT NULL
  ) OR (
    ${table.versionKind} <> 'llm_draft'
    AND ${table.actorUserId} IS NOT NULL
    AND ${table.producerJobId} IS NULL
    AND ${table.producerModel} IS NULL
  )`),
  uniqueIndex("idx_tactic_card_reviews_one_llm_draft").on(table.cardId).where(sql`${table.versionKind} = 'llm_draft'`),
  uniqueIndex("idx_tactic_card_reviews_id_card").on(table.id, table.cardId),
]);

export const scenarioTacticCardReviews = sqliteTable("scenario_tactic_card_reviews", {
  scenarioId: text("scenario_id").primaryKey().references(() => scenarios.id, { onDelete: "cascade" }),
  cardId: text("card_id").notNull(),
  cardReviewId: text("card_review_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("idx_scenario_tactic_card_reviews_review").on(table.cardReviewId),
  foreignKey({
    name: "fk_scenario_tactic_card_reviews_review_card",
    columns: [table.cardReviewId, table.cardId],
    foreignColumns: [tacticCardReviews.id, tacticCardReviews.cardId],
  }).onDelete("restrict"),
]);

export const evidenceAuditEvents = sqliteTable("evidence_audit_events", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("idx_evidence_audit_events_bundle_created_at").on(table.bundleId, table.createdAt)]);
