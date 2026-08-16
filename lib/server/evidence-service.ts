import {
  parseScenarioContent,
  type ScenarioContent,
} from "../domain/content.ts";
import {
  assertCardReviewTransition,
  computeEvidenceVersion,
  parseBundleInput,
  parseTacticCardContent,
  parseVideoClip,
  type CardReviewStatus,
  type EvidenceBundleInput,
  type TacticCardContent,
  type VideoClipInput,
} from "../domain/evidence.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import type {
  EvidenceFileStore,
  StoredEvidenceFile,
} from "./evidence-storage.ts";
import {
  EvidenceConflictError,
  EvidenceNotFoundError,
  EvidenceRequestValidationError,
  EvidenceUnavailableError,
} from "./evidence-errors.ts";
export { EvidenceConflictError } from "./evidence-errors.ts";

export type EvidenceAnalysisSettings = {
  analyzerModel: string;
  promptVersion: string;
  schemaVersion: string;
};
export type EvidenceBundleRecord = EvidenceBundleInput & {
  id: string;
  version: number;
  contentVersion: string;
  createdAt: number;
  updatedAt: number;
};
export type EvidenceVideoClipRecord = VideoClipInput & {
  id: string;
  bundleId: string;
  createdAt: number;
  updatedAt: number;
};
export type EvidenceAuditEventInput = {
  id: string;
  bundleId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  detailsJson: string;
  createdAt: number;
};
export type EvidenceDeleteImpact = {
  sourceId: string;
  cardIds: string[];
  scenarioDraftIds: string[];
};
export type EvidenceBundleDetail = EvidenceBundleRecord & {
  sources: StoredEvidenceFile[];
  videoClips: EvidenceVideoClipRecord[];
};
export type EvidenceBundleUpdate = Partial<EvidenceBundleInput>;
export type EvidenceCardRecord = {
  id: string;
  bundleId: string;
  jobId: string;
  bundleVersion: string;
  currentBundleVersion: string;
  currentReviewId: string | null;
  producerModel: string;
  status: CardReviewStatus;
  draftContentJson: string;
  currentContentJson: string;
  isStale: boolean;
  createdAt: number;
  updatedAt: number;
};
export type EvidenceCardReviewVersionKind =
  "llm_draft" | "owner_edit" | "coach_edit" | "status_change";
export type EvidenceCitationSnapshot = {
  chunkId: string;
  sourceId: string | null;
  videoClipId: string | null;
  locationLabel: string;
  content: string;
  contentHash: string;
};
export type EvidenceCardAdminDetail = EvidenceCardRecord & {
  citations: EvidenceCitationSnapshot[];
  citationCount: number;
};
export type EvidenceCardsPage = { cards: EvidenceCardAdminDetail[]; totalCount: number; nextOffset: number | null };
export type EvidenceCardReviewRecord = {
  id: string;
  cardId: string;
  actorUserId: string | null;
  status: CardReviewStatus;
  versionKind: EvidenceCardReviewVersionKind;
  producerJobId: string | null;
  producerModel: string | null;
  contentJson: string;
  citationSnapshotJson: string;
  bundleVersion: string;
  createdAt: number;
};
export type EvidenceCardReviewCommand = {
  status: CardReviewStatus;
  content: unknown;
  expectedUpdatedAt: number;
};
export type EvidenceScenarioDraftInput = {
  expectedUpdatedAt: number;
  campaignId: string;
  role: "fixo" | "ala" | "pivo" | "recap";
  principle: "width" | "support" | "pivot" | "transition";
  prompt: string;
  hint: string;
  explanation: string;
  orderIndex: number;
  content: unknown;
};
export type EvidenceScenarioDraftRecord = {
  id: string;
  campaignId: string;
  role: EvidenceScenarioDraftInput["role"];
  principle: EvidenceScenarioDraftInput["principle"];
  prompt: string;
  hint: string;
  explanation: string;
  pitchJson: string;
  answerJson: string;
  contentJson: string;
  reviewStatus: "draft";
  orderIndex: number;
};
export type EvidenceCardReviewMutation = {
  card: EvidenceCardRecord;
  expectedUpdatedAt: number;
  nextUpdatedAt: number;
  status: CardReviewStatus;
  contentJson: string;
  originalReview: EvidenceCardReviewRecord;
  review: EvidenceCardReviewRecord;
  audit: EvidenceAuditEventInput;
};
export type EvidenceScenarioDraftMutation = {
  card: EvidenceCardRecord;
  review: EvidenceCardReviewRecord;
  expectedUpdatedAt: number;
  scenario: EvidenceScenarioDraftRecord;
  chunkIds: string[];
  sourceIds: string[];
  audit: EvidenceAuditEventInput;
  createdAt: number;
};
export type EvidenceMutation = {
  current: EvidenceBundleRecord;
  next: EvidenceBundleRecord;
  audit: EvidenceAuditEventInput;
  sourceToInsert?: StoredEvidenceFile;
  sourceToDelete?: string;
  clipToInsert?: EvidenceVideoClipRecord;
};
export type EvidenceD1Statement = {
  bind(...values: unknown[]): EvidenceD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};
export type EvidenceD1Database = {
  prepare(query: string): EvidenceD1Statement;
  batch(
    statements: EvidenceD1Statement[],
  ): Promise<{ meta?: { changes?: number } }[]>;
};
export type EvidenceServiceRepository = {
  campaignExists(id: string): Promise<boolean>;
  getBundle(id: string): Promise<EvidenceBundleRecord | null>;
  listBundles(): Promise<EvidenceBundleRecord[]>;
  listSources(bundleId: string): Promise<StoredEvidenceFile[]>;
  findSource(sourceId: string): Promise<StoredEvidenceFile | null>;
  listVideoClips(bundleId: string): Promise<EvidenceVideoClipRecord[]>;
  findSourceByHash(
    bundleId: string,
    hash: string,
  ): Promise<StoredEvidenceFile | null>;
  describeDeleteImpact(sourceId: string): Promise<EvidenceDeleteImpact>;
  createBundle(
    bundle: EvidenceBundleRecord,
    audit: EvidenceAuditEventInput,
  ): Promise<void>;
  applyMutation(mutation: EvidenceMutation): Promise<boolean>;
  listCardsForJob(jobId: string, offset?: number, limit?: number): Promise<EvidenceCardRecord[]>;
  countCardsForJob(jobId: string): Promise<number>;
  findCard(cardId: string): Promise<EvidenceCardRecord | null>;
  listCardCitations(
    cardId: string,
  ): Promise<(EvidenceCitationSnapshot & { inputVersion: string })[]>;
  countCardCitations(cardId: string, inputVersion: string): Promise<number>;
  listCardCitationsForAdmin(cardId: string, inputVersion: string, limit: number): Promise<EvidenceCitationSnapshot[]>;
  findCardReview(
    reviewId: string,
    cardId: string,
  ): Promise<EvidenceCardReviewRecord | null>;
  applyCardReview(mutation: EvidenceCardReviewMutation): Promise<boolean>;
  findScenarioDraftByReview(
    reviewId: string,
    cardId: string,
    expectedUpdatedAt: number,
  ): Promise<EvidenceScenarioDraftRecord | null>;
  createScenarioDraft(
    mutation: EvidenceScenarioDraftMutation,
  ): Promise<"created" | "conflict" | "campaign_missing">;
};
const guard =
  "EXISTS (SELECT 1 FROM evidence_bundles WHERE id=? AND version=? AND content_version=?)";
const CARD_REVIEW_STATUSES: readonly CardReviewStatus[] = [
  "analysis_draft",
  "owner_reviewed",
  "coach_reviewed",
  "held",
  "rejected",
];
const SCENARIO_ROLES: readonly EvidenceScenarioDraftInput["role"][] = [
  "fixo",
  "ala",
  "pivo",
  "recap",
];
const SCENARIO_PRINCIPLES: readonly EvidenceScenarioDraftInput["principle"][] =
  ["width", "support", "pivot", "transition"];

function cardCitationIds(content: TacticCardContent): string[] {
  return [
    ...new Set(
      [...content.preferred, ...content.alternatives, ...content.risky].flatMap(
        (action) => action.citationIds,
      ),
    ),
  ].sort();
}

function exactCitationSnapshot(
  content: TacticCardContent,
  citations: (EvidenceCitationSnapshot & { inputVersion: string })[],
  bundleVersion: string,
): EvidenceCitationSnapshot[] {
  const current = new Map(
    citations
      .filter((citation) => citation.inputVersion === bundleVersion)
      .map((citation) => [citation.chunkId, citation]),
  );
  const ids = cardCitationIds(content);
  if (ids.some((id) => !current.has(id)))
    throw new EvidenceConflictError(
      "현재 카드의 유효한 근거를 확인할 수 없어 검수할 수 없습니다.",
    );
  return ids.map((id) => {
    const citation = current.get(id)!;
    return {
      chunkId: citation.chunkId,
      sourceId: citation.sourceId,
      videoClipId: citation.videoClipId,
      locationLabel: citation.locationLabel,
      content: citation.content,
      contentHash: citation.contentHash,
    };
  });
}

function expectedTimestamp(value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw new EvidenceRequestValidationError("expectedUpdatedAt이 필요합니다.");
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new EvidenceRequestValidationError(`${field}이 필요합니다.`);
  return value;
}

function reviewVersionKind(
  status: CardReviewStatus,
): EvidenceCardReviewVersionKind {
  if (status === "owner_reviewed") return "owner_edit";
  if (status === "coach_reviewed") return "coach_edit";
  return "status_change";
}
/** Production D1 adapter: every dependent write shares an optimistic-CAS guard in one atomic batch. */
export class D1EvidenceServiceRepository implements EvidenceServiceRepository {
  constructor(private readonly db: EvidenceD1Database) {}
  async campaignExists(id: string): Promise<boolean> {
    return (
      (await this.db
        .prepare("SELECT 1 AS found FROM campaigns WHERE id=?")
        .bind(id)
        .first()) !== null
    );
  }
  async getBundle(id: string) {
    return this.db
      .prepare(
        "SELECT id,title,purpose,version,content_version AS contentVersion,created_at AS createdAt,updated_at AS updatedAt FROM evidence_bundles WHERE id=?",
      )
      .bind(id)
      .first<EvidenceBundleRecord>();
  }
  async listBundles() {
    return (
      await this.db
        .prepare(
          "SELECT id,title,purpose,version,content_version AS contentVersion,created_at AS createdAt,updated_at AS updatedAt FROM evidence_bundles ORDER BY updated_at DESC",
        )
        .all<EvidenceBundleRecord>()
    ).results;
  }
  async listSources(bundleId: string) {
    return (
      await this.db
        .prepare(
          "SELECT id,bundle_id AS bundleId,original_file_name AS originalFileName,media_type AS mediaType,byte_size AS byteSize,content_hash AS contentHash,storage_key AS storageKey,extracted_text_key AS extractedTextKey,extraction_status AS extractionStatus,extraction_error AS extractionError FROM evidence_sources WHERE bundle_id=?",
        )
        .bind(bundleId)
        .all<StoredEvidenceFile>()
    ).results;
  }
  async findSource(id: string) {
    return this.db
      .prepare(
        "SELECT id,bundle_id AS bundleId,original_file_name AS originalFileName,media_type AS mediaType,byte_size AS byteSize,content_hash AS contentHash,storage_key AS storageKey,extracted_text_key AS extractedTextKey,extraction_status AS extractionStatus,extraction_error AS extractionError FROM evidence_sources WHERE id=?",
      )
      .bind(id)
      .first<StoredEvidenceFile>();
  }
  async listVideoClips(bundleId: string) {
    return (
      await this.db
        .prepare(
          "SELECT id,bundle_id AS bundleId,url,start_ms AS startMs,end_ms AS endMs,observation,created_at AS createdAt,updated_at AS updatedAt FROM evidence_video_clips WHERE bundle_id=?",
        )
        .bind(bundleId)
        .all<EvidenceVideoClipRecord>()
    ).results;
  }
  async findSourceByHash(bundleId: string, hash: string) {
    return this.db
      .prepare(
        "SELECT id,bundle_id AS bundleId,original_file_name AS originalFileName,media_type AS mediaType,byte_size AS byteSize,content_hash AS contentHash,storage_key AS storageKey,extracted_text_key AS extractedTextKey,extraction_status AS extractionStatus,extraction_error AS extractionError FROM evidence_sources WHERE bundle_id=? AND content_hash=?",
      )
      .bind(bundleId, hash)
      .first<StoredEvidenceFile>();
  }
  async describeDeleteImpact(sourceId: string) {
    const [cards, scenarios] = await Promise.all([
      this.db
        .prepare(
          "SELECT DISTINCT c.id FROM tactic_cards c JOIN tactic_card_citations x ON x.card_id=c.id JOIN evidence_chunks h ON h.id=x.chunk_id WHERE h.source_id=?",
        )
        .bind(sourceId)
        .all<{ id: string }>(),
      this.db
        .prepare(
          "SELECT DISTINCT s.id FROM scenario_evidence_sources x JOIN scenarios s ON s.id=x.scenario_id WHERE x.source_id=? AND s.review_status='draft'",
        )
        .bind(sourceId)
        .all<{ id: string }>(),
    ]);
    return {
      sourceId,
      cardIds: cards.results.map((x) => x.id),
      scenarioDraftIds: scenarios.results.map((x) => x.id),
    };
  }
  async createBundle(b: EvidenceBundleRecord, a: EvidenceAuditEventInput) {
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO evidence_bundles (id,title,purpose,version,content_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(
          b.id,
          b.title,
          b.purpose,
          b.version,
          b.contentVersion,
          b.createdAt,
          b.updatedAt,
        ),
      this.audit(a, "EXISTS (SELECT 1 FROM evidence_bundles WHERE id=?)", [
        b.id,
      ]),
    ]);
  }
  async applyMutation(mutation: EvidenceMutation) {
    const current = mutation.current;
    const next = mutation.next;
    const oldState = [current.id, current.version, current.contentVersion];
    const statements: EvidenceD1Statement[] = [];
    let dependentGuard = guard;
    let dependentGuardValues: unknown[] = oldState;

    if (mutation.sourceToDelete) {
      // D1 does not fail a batch when a required DELETE affects zero rows. This
      // durable receipt materializes target existence so every later write,
      // including the final CAS, can depend on the same SQL precondition.
      const receiptId = mutation.audit.id;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO evidence_mutation_receipts (id,bundle_id,source_id,created_at)
          SELECT ?,?,?,? FROM evidence_sources
          WHERE id=? AND bundle_id=? AND ${guard}`,
          )
          .bind(
            receiptId,
            current.id,
            mutation.sourceToDelete,
            next.updatedAt,
            mutation.sourceToDelete,
            current.id,
            ...oldState,
          ),
      );
      dependentGuard = `${guard} AND EXISTS (
        SELECT 1 FROM evidence_mutation_receipts
        WHERE id=? AND bundle_id=? AND source_id=?
      )`;
      dependentGuardValues = [
        ...oldState,
        receiptId,
        current.id,
        mutation.sourceToDelete,
      ];
    }

    if (mutation.sourceToInsert) {
      const source = mutation.sourceToInsert;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO evidence_sources (id,bundle_id,original_file_name,media_type,byte_size,content_hash,storage_key,extracted_text_key,extraction_status,extraction_error,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,
          )
          .bind(
            source.id,
            source.bundleId,
            source.originalFileName,
            source.mediaType,
            source.byteSize,
            source.contentHash,
            source.storageKey,
            source.extractedTextKey,
            source.extractionStatus,
            source.extractionError,
            next.updatedAt,
            next.updatedAt,
            ...oldState,
          ),
      );
    }
    if (mutation.sourceToDelete) {
      statements.push(
        this.db
          .prepare(
            `DELETE FROM evidence_sources WHERE id=? AND bundle_id=? AND ${dependentGuard}`,
          )
          .bind(mutation.sourceToDelete, current.id, ...dependentGuardValues),
      );
    }
    if (mutation.clipToInsert) {
      const clip = mutation.clipToInsert;
      statements.push(
        this.db
          .prepare(
            `INSERT INTO evidence_video_clips (id,bundle_id,url,start_ms,end_ms,observation,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`,
          )
          .bind(
            clip.id,
            clip.bundleId,
            clip.url,
            clip.startMs,
            clip.endMs,
            clip.observation,
            clip.createdAt,
            clip.updatedAt,
            ...oldState,
          ),
      );
    }

    statements.push(
      this.db
        .prepare(
          `UPDATE evidence_analysis_jobs
          SET is_stale=1,
            status=CASE WHEN status IN ('queued','running','review_ready') THEN 'failed' ELSE status END,
            error_message=CASE WHEN status IN ('queued','running','review_ready') THEN 'evidence version superseded' ELSE error_message END,
            updated_at=?
          WHERE bundle_id=? AND input_version<>? AND ${dependentGuard}`,
        )
        .bind(
          next.updatedAt,
          current.id,
          next.contentVersion,
          ...dependentGuardValues,
        ),
      this.db
        .prepare(
          `UPDATE tactic_cards
          SET is_stale=1,
            status=CASE WHEN status IN ('analysis_draft','owner_reviewed','coach_reviewed') THEN 'held' ELSE status END,
            updated_at=?
          WHERE bundle_id=? AND bundle_version<>? AND ${dependentGuard}`,
        )
        .bind(
          next.updatedAt,
          current.id,
          next.contentVersion,
          ...dependentGuardValues,
        ),
      this.audit(mutation.audit, dependentGuard, dependentGuardValues),
      // D1 batch statements execute sequentially. The CAS must remain last so
      // every dependent old-state guard is true on success and false on a miss.
      this.db
        .prepare(
          `UPDATE evidence_bundles
          SET title=?,purpose=?,version=?,content_version=?,updated_at=?
          WHERE id=? AND version=? AND content_version=?${
            mutation.sourceToDelete
              ? ` AND EXISTS (
            SELECT 1 FROM evidence_mutation_receipts
            WHERE id=? AND bundle_id=? AND source_id=?
          )`
              : ""
          }`,
        )
        .bind(
          next.title,
          next.purpose,
          next.version,
          next.contentVersion,
          next.updatedAt,
          ...oldState,
          ...(mutation.sourceToDelete
            ? [mutation.audit.id, current.id, mutation.sourceToDelete]
            : []),
        ),
    );

    const results = await this.db.batch(statements);
    return (results.at(-1)?.meta?.changes ?? 0) === 1;
  }
  async listCardsForJob(jobId: string, offset = 0, limit = 20): Promise<EvidenceCardRecord[]> {
    return (
      await this.db
        .prepare(
          `SELECT card.id,card.bundle_id AS bundleId,card.job_id AS jobId,card.bundle_version AS bundleVersion,
        bundle.content_version AS currentBundleVersion,card.current_review_id AS currentReviewId,
        job.analyzer_model AS producerModel,card.status,card.draft_content_json AS draftContentJson,
        card.current_content_json AS currentContentJson,card.is_stale AS isStale,
        card.created_at AS createdAt,card.updated_at AS updatedAt
        FROM tactic_cards AS card
        JOIN evidence_bundles AS bundle ON bundle.id=card.bundle_id
        JOIN evidence_analysis_jobs AS job ON job.id=card.job_id AND job.bundle_id=card.bundle_id
        WHERE card.job_id=? ORDER BY card.created_at,card.id LIMIT ? OFFSET ?`,
        )
        .bind(jobId, limit, offset)
        .all<EvidenceCardRecord>()
    ).results.map((card) => ({ ...card, isStale: Boolean(card.isStale) }));
  }
  async countCardsForJob(jobId: string): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM tactic_cards WHERE job_id=?").bind(jobId).first<{count:number}>();
    return row?.count ?? 0;
  }
  async findCard(cardId: string): Promise<EvidenceCardRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT card.id,card.bundle_id AS bundleId,card.job_id AS jobId,card.bundle_version AS bundleVersion,
        bundle.content_version AS currentBundleVersion,card.current_review_id AS currentReviewId,
        job.analyzer_model AS producerModel,card.status,card.draft_content_json AS draftContentJson,
        card.current_content_json AS currentContentJson,card.is_stale AS isStale,
        card.created_at AS createdAt,card.updated_at AS updatedAt
        FROM tactic_cards AS card
        JOIN evidence_bundles AS bundle ON bundle.id=card.bundle_id
        JOIN evidence_analysis_jobs AS job ON job.id=card.job_id AND job.bundle_id=card.bundle_id
        WHERE card.id=?`,
      )
      .bind(cardId)
      .first<EvidenceCardRecord>();
    return row === null ? null : { ...row, isStale: Boolean(row.isStale) };
  }
  async listCardCitations(
    cardId: string,
  ): Promise<(EvidenceCitationSnapshot & { inputVersion: string })[]> {
    return (
      await this.db
        .prepare(
          `SELECT chunk.id AS chunkId,chunk.source_id AS sourceId,chunk.video_clip_id AS videoClipId,
        chunk.location_label AS locationLabel,chunk.content,chunk.content_hash AS contentHash,chunk.input_version AS inputVersion
        FROM tactic_card_citations AS citation
        JOIN evidence_chunks AS chunk ON chunk.id=citation.chunk_id AND chunk.bundle_id=citation.bundle_id
        WHERE citation.card_id=? ORDER BY chunk.id`,
        )
        .bind(cardId)
        .all<EvidenceCitationSnapshot & { inputVersion: string }>()
    ).results;
  }
  async countCardCitations(cardId: string, inputVersion: string): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS count FROM tactic_card_citations AS citation
      JOIN evidence_chunks AS chunk ON chunk.id=citation.chunk_id AND chunk.bundle_id=citation.bundle_id
      WHERE citation.card_id=? AND chunk.input_version=?`).bind(cardId, inputVersion).first<{count:number}>();
    return row?.count ?? 0;
  }
  async listCardCitationsForAdmin(cardId: string, inputVersion: string, limit: number): Promise<EvidenceCitationSnapshot[]> {
    return (await this.db.prepare(`SELECT chunk.id AS chunkId,chunk.source_id AS sourceId,chunk.video_clip_id AS videoClipId,
      chunk.location_label AS locationLabel,chunk.content,chunk.content_hash AS contentHash
      FROM tactic_card_citations AS citation
      JOIN evidence_chunks AS chunk ON chunk.id=citation.chunk_id AND chunk.bundle_id=citation.bundle_id
      WHERE citation.card_id=? AND chunk.input_version=? ORDER BY chunk.id LIMIT ?`)
      .bind(cardId, inputVersion, limit).all<EvidenceCitationSnapshot>()).results;
  }
  async findCardReview(
    reviewId: string,
    cardId: string,
  ): Promise<EvidenceCardReviewRecord | null> {
    return this.db
      .prepare(
        `SELECT review.id,review.card_id AS cardId,review.actor_user_id AS actorUserId,review.status,
        review.version_kind AS versionKind,review.producer_job_id AS producerJobId,review.producer_model AS producerModel,
        review.content_json AS contentJson,review.citation_snapshot_json AS citationSnapshotJson,
        review.bundle_version AS bundleVersion,review.created_at AS createdAt
        FROM tactic_card_reviews AS review WHERE review.id=? AND review.card_id=?`,
      )
      .bind(reviewId, cardId)
      .first<EvidenceCardReviewRecord>();
  }
  async applyCardReview(
    mutation: EvidenceCardReviewMutation,
  ): Promise<boolean> {
    const reviewGuard = `EXISTS (
      SELECT 1 FROM tactic_cards AS card
      JOIN evidence_bundles AS bundle ON bundle.id=card.bundle_id
      WHERE card.id=? AND card.updated_at=? AND card.is_stale=0
        AND card.bundle_version=bundle.content_version
    )`;
    const guardValues = [mutation.card.id, mutation.expectedUpdatedAt];
    const original = mutation.originalReview;
    const review = mutation.review;
    const statements = [
      this.db
        .prepare(
          `INSERT INTO tactic_card_reviews
          (id,card_id,actor_user_id,status,version_kind,producer_job_id,producer_model,
           content_json,citation_snapshot_json,bundle_version,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${reviewGuard}
            AND NOT EXISTS (SELECT 1 FROM tactic_card_reviews WHERE card_id=? AND version_kind='llm_draft')`,
        )
        .bind(
          original.id,
          original.cardId,
          original.actorUserId,
          original.status,
          original.versionKind,
          original.producerJobId,
          original.producerModel,
          original.contentJson,
          original.citationSnapshotJson,
          original.bundleVersion,
          original.createdAt,
          ...guardValues,
          mutation.card.id,
        ),
      this.db
        .prepare(
          `INSERT INTO tactic_card_reviews
          (id,card_id,actor_user_id,status,version_kind,producer_job_id,producer_model,
           content_json,citation_snapshot_json,bundle_version,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${reviewGuard}`,
        )
        .bind(
          review.id,
          review.cardId,
          review.actorUserId,
          review.status,
          review.versionKind,
          review.producerJobId,
          review.producerModel,
          review.contentJson,
          review.citationSnapshotJson,
          review.bundleVersion,
          review.createdAt,
          ...guardValues,
        ),
      this.audit(mutation.audit, reviewGuard, guardValues),
      this.db
        .prepare(
          `UPDATE tactic_cards SET status=?,current_content_json=?,current_review_id=?,updated_at=?
          WHERE id=? AND updated_at=? AND is_stale=0
            AND bundle_version=(SELECT content_version FROM evidence_bundles WHERE id=bundle_id)`,
        )
        .bind(
          mutation.status,
          mutation.contentJson,
          review.id,
          mutation.nextUpdatedAt,
          mutation.card.id,
          mutation.expectedUpdatedAt,
        ),
    ];
    const results = await this.db.batch(statements);
    return (results.at(-1)?.meta?.changes ?? 0) === 1;
  }
  async findScenarioDraftByReview(
    reviewId: string,
    cardId: string,
    expectedUpdatedAt: number,
  ): Promise<EvidenceScenarioDraftRecord | null> {
    return this.db
      .prepare(
        `SELECT scenario.id,scenario.campaign_id AS campaignId,scenario.role,scenario.principle,
        scenario.prompt,scenario.hint,scenario.explanation,scenario.pitch_json AS pitchJson,
        scenario.answer_json AS answerJson,scenario.content_json AS contentJson,
        scenario.review_status AS reviewStatus,scenario.order_index AS orderIndex
        FROM scenario_tactic_card_reviews AS provenance
        JOIN scenarios AS scenario ON scenario.id=provenance.scenario_id
        JOIN tactic_cards AS card ON card.id=provenance.card_id
        JOIN evidence_bundles AS bundle ON bundle.id=card.bundle_id
        JOIN tactic_card_reviews AS review ON review.id=provenance.card_review_id AND review.card_id=card.id
        WHERE provenance.card_review_id=? AND provenance.card_id=?
          AND card.current_review_id=? AND card.updated_at=? AND card.is_stale=0
          AND card.bundle_version=bundle.content_version
          AND card.status IN ('owner_reviewed','coach_reviewed')
          AND review.status=card.status AND review.content_json=card.current_content_json
          AND review.bundle_version=card.bundle_version`,
      )
      .bind(reviewId, cardId, reviewId, expectedUpdatedAt)
      .first<EvidenceScenarioDraftRecord>();
  }
  async createScenarioDraft(
    mutation: EvidenceScenarioDraftMutation,
  ): Promise<"created" | "conflict" | "campaign_missing"> {
    const scenario = mutation.scenario;
    const conversionGuard = `EXISTS (
      SELECT 1 FROM tactic_cards AS card
      JOIN evidence_bundles AS bundle ON bundle.id=card.bundle_id
      JOIN tactic_card_reviews AS review ON review.id=? AND review.card_id=card.id
      WHERE card.id=? AND card.updated_at=? AND card.is_stale=0
        AND card.bundle_version=bundle.content_version
        AND card.current_review_id=review.id
        AND card.status IN ('owner_reviewed','coach_reviewed')
        AND review.status=card.status AND review.content_json=card.current_content_json
        AND review.bundle_version=card.bundle_version
    )`;
    const guardValues = [
      mutation.review.id,
      mutation.card.id,
      mutation.expectedUpdatedAt,
    ];
    const statements: EvidenceD1Statement[] = [
      this.db
        .prepare(
          `INSERT INTO scenarios
          (id,campaign_id,role,principle,prompt,hint,explanation,pitch_json,answer_json,content_json,review_status,order_index)
          SELECT ?,?,?,?,?,?,?,?,?,?,'draft',? WHERE ${conversionGuard}
            AND EXISTS (SELECT 1 FROM campaigns WHERE id=?)
            AND NOT EXISTS (SELECT 1 FROM scenario_tactic_card_reviews WHERE card_review_id=?)`,
        )
        .bind(
          scenario.id,
          scenario.campaignId,
          scenario.role,
          scenario.principle,
          scenario.prompt,
          scenario.hint,
          scenario.explanation,
          scenario.pitchJson,
          scenario.answerJson,
          scenario.contentJson,
          scenario.orderIndex,
          ...guardValues,
          scenario.campaignId,
          mutation.review.id,
        ),
      this.db
        .prepare(
          `INSERT INTO scenario_tactic_card_reviews (scenario_id,card_id,card_review_id,created_at)
          SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM scenarios WHERE id=?)`,
        )
        .bind(
          scenario.id,
          mutation.card.id,
          mutation.review.id,
          mutation.createdAt,
          scenario.id,
        ),
    ];
    for (const sourceId of mutation.sourceIds) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO scenario_evidence_sources (scenario_id,source_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM scenarios WHERE id=?)",
          )
          .bind(scenario.id, sourceId, scenario.id),
      );
    }
    for (const chunkId of mutation.chunkIds) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO scenario_evidence_chunks (scenario_id,chunk_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM scenarios WHERE id=?)",
          )
          .bind(scenario.id, chunkId, scenario.id),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO evidence_audit_events
        (id,bundle_id,actor_user_id,action,target_type,target_id,details_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM scenarios WHERE id=?)`,
        )
        .bind(
          mutation.audit.id,
          mutation.audit.bundleId,
          mutation.audit.actorUserId,
          mutation.audit.action,
          mutation.audit.targetType,
          mutation.audit.targetId,
          mutation.audit.detailsJson,
          mutation.audit.createdAt,
          scenario.id,
        ),
    );
    const results = await this.db.batch(statements);
    if ((results[0]?.meta?.changes ?? 0) === 1) return "created";
    return (await this.campaignExists(scenario.campaignId))
      ? "conflict"
      : "campaign_missing";
  }
  private audit(a: EvidenceAuditEventInput, w: string, v: unknown[]) {
    return this.db
      .prepare(
        `INSERT INTO evidence_audit_events (id,bundle_id,actor_user_id,action,target_type,target_id,details_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${w}`,
      )
      .bind(
        a.id,
        a.bundleId,
        a.actorUserId,
        a.action,
        a.targetType,
        a.targetId,
        a.detailsJson,
        a.createdAt,
        ...v,
      );
  }
}
export class EvidenceService {
  constructor(
    private readonly d: {
      repository: EvidenceServiceRepository;
      settings: EvidenceAnalysisSettings;
      fileStore?: Pick<EvidenceFileStore, "deleteFilePairWithCompensation">;
      now?: () => number;
      newId?: () => string;
    },
  ) {}
  async createBundle(input: unknown, admin: EvidenceAdmin) {
    const x = parseBundleInput(input),
      now = this.now(),
      b: EvidenceBundleRecord = {
        id: this.id(),
        ...x,
        version: 1,
        contentVersion: await this.hash(x.purpose, [], []),
        createdAt: now,
        updatedAt: now,
      };
    await this.d.repository.createBundle(
      b,
      this.audit(b, admin, "bundle.created", "bundle", b.id, x, now),
    );
    return b;
  }
  async updateBundle(id: string, u: EvidenceBundleUpdate, a: EvidenceAdmin) {
    const c = await this.need(id),
      x = parseBundleInput({
        title: u.title ?? c.title,
        purpose: u.purpose ?? c.purpose,
      }),
      changed = x.purpose !== c.purpose,
      n = {
        ...c,
        ...x,
        version: changed ? c.version + 1 : c.version,
        contentVersion: changed
          ? await this.hash(
              x.purpose,
              await this.d.repository.listSources(id),
              await this.d.repository.listVideoClips(id),
            )
          : c.contentVersion,
        updatedAt: this.now(),
      };
    await this.commit({
      current: c,
      next: n,
      audit: this.audit(
        n,
        a,
        "bundle.updated",
        "bundle",
        id,
        { contentChanged: changed },
        n.updatedAt,
      ),
    });
    return n;
  }
  async addVideoClip(id: string, input: unknown, a: EvidenceAdmin) {
    const c = await this.need(id),
      now = this.now(),
      x: EvidenceVideoClipRecord = {
        id: this.id(),
        bundleId: id,
        ...parseVideoClip(input),
        createdAt: now,
        updatedAt: now,
      },
      n = {
        ...c,
        version: c.version + 1,
        contentVersion: await this.hash(
          c.purpose,
          await this.d.repository.listSources(id),
          [...(await this.d.repository.listVideoClips(id)), x],
        ),
        updatedAt: now,
      };
    await this.commit({
      current: c,
      next: n,
      clipToInsert: x,
      audit: this.audit(n, a, "video_clip.added", "video_clip", x.id, x, now),
    });
    return n;
  }
  sourceRegistration(a: EvidenceAdmin) {
    return {
      findExisting: (b: string, h: string) =>
        this.d.repository.findSourceByHash(b, h),
      register: (s: StoredEvidenceFile) => this.addSource(s, a),
    };
  }
  async addSource(s: StoredEvidenceFile, a: EvidenceAdmin) {
    const c = await this.need(s.bundleId),
      now = this.now(),
      n = {
        ...c,
        version: c.version + 1,
        contentVersion: await this.hash(
          c.purpose,
          [...(await this.d.repository.listSources(c.id)), s],
          await this.d.repository.listVideoClips(c.id),
        ),
        updatedAt: now,
      };
    await this.commit({
      current: c,
      next: n,
      sourceToInsert: s,
      audit: this.audit(
        n,
        a,
        "source.added",
        "source",
        s.id,
        { contentHash: s.contentHash },
        now,
      ),
    });
    return s;
  }
  async describeDeleteImpact(id: string) {
    return this.d.repository.describeDeleteImpact(id);
  }
  async removeSource(id: string, admin: EvidenceAdmin) {
    const source = await this.d.repository.findSource(id);
    if (!source)
      throw new EvidenceNotFoundError("근거 파일을 찾을 수 없습니다.");
    this.links(await this.describeDeleteImpact(id));
    if (!this.d.fileStore)
      throw new EvidenceUnavailableError(
        "근거 파일 저장소를 사용할 수 없습니다.",
      );

    return this.d.fileStore.deleteFilePairWithCompensation(
      source.storageKey,
      source.extractedTextKey,
      async () => {
        this.links(await this.describeDeleteImpact(id));
        const current = await this.need(source.bundleId);
        const now = this.now();
        const next = {
          ...current,
          version: current.version + 1,
          contentVersion: await this.hash(
            current.purpose,
            (await this.d.repository.listSources(current.id)).filter(
              (item) => item.id !== id,
            ),
            await this.d.repository.listVideoClips(current.id),
          ),
          updatedAt: now,
        };
        try {
          await this.commit({
            current,
            next,
            sourceToDelete: id,
            audit: this.audit(
              next,
              admin,
              "source.removed",
              "source",
              id,
              {},
              now,
            ),
          });
        } catch (error) {
          // A relation can appear after both advisory impact checks. Translate
          // the authoritative FK/trigger rollback into the public domain error.
          this.links(await this.describeDeleteImpact(id));
          throw error;
        }
        return next;
      },
      async () => (await this.d.repository.findSource(id)) !== null,
    );
  }
  async reviewCard(
    cardId: string,
    command: EvidenceCardReviewCommand,
    admin: EvidenceAdmin,
  ): Promise<EvidenceCardRecord> {
    if (!CARD_REVIEW_STATUSES.includes(command.status))
      throw new EvidenceRequestValidationError("카드 검수 상태가 올바르지 않습니다.");
    const expectedUpdatedAt = expectedTimestamp(command.expectedUpdatedAt);
    const card = await this.d.repository.findCard(cardId);
    if (card === null) throw new EvidenceNotFoundError("전술 카드를 찾을 수 없습니다.");
    if (card.updatedAt !== expectedUpdatedAt) throw new EvidenceConflictError();
    this.assertCurrentCard(card);

    const content = parseTacticCardContent(command.content);
    const citations = await this.d.repository.listCardCitations(card.id);
    const snapshot = exactCitationSnapshot(
      content,
      citations,
      card.bundleVersion,
    );
    assertCardReviewTransition(
      command.status,
      content,
      new Set(snapshot.map((citation) => citation.chunkId)),
    );

    const original = parseTacticCardContent(card.draftContentJson);
    const originalSnapshot = exactCitationSnapshot(
      original,
      citations,
      card.bundleVersion,
    );
    const now = Math.max(this.now(), card.updatedAt + 1);
    const originalReview: EvidenceCardReviewRecord = {
      id: this.id(),
      cardId: card.id,
      actorUserId: null,
      status: "analysis_draft",
      versionKind: "llm_draft",
      producerJobId: card.jobId,
      producerModel: card.producerModel,
      contentJson: JSON.stringify(original),
      citationSnapshotJson: JSON.stringify(originalSnapshot),
      bundleVersion: card.bundleVersion,
      createdAt: card.createdAt,
    };
    const review: EvidenceCardReviewRecord = {
      id: this.id(),
      cardId: card.id,
      actorUserId: admin.userId,
      status: command.status,
      versionKind: reviewVersionKind(command.status),
      producerJobId: null,
      producerModel: null,
      contentJson: JSON.stringify(content),
      citationSnapshotJson: JSON.stringify(snapshot),
      bundleVersion: card.bundleVersion,
      createdAt: now,
    };
    const audit = this.audit(
      { id: card.bundleId },
      admin,
      "card.reviewed",
      "tactic_card",
      card.id,
      {
        reviewId: review.id,
        status: command.status,
        bundleVersion: card.bundleVersion,
        citationSnapshot: snapshot,
      },
      now,
    );
    const applied = await this.d.repository.applyCardReview({
      card,
      expectedUpdatedAt,
      nextUpdatedAt: now,
      status: command.status,
      contentJson: review.contentJson,
      originalReview,
      review,
      audit,
    });
    if (!applied) throw new EvidenceConflictError();
    return {
      ...card,
      status: command.status,
      currentContentJson: review.contentJson,
      currentReviewId: review.id,
      updatedAt: now,
    };
  }
  async createScenarioDraft(
    cardId: string,
    input: EvidenceScenarioDraftInput,
    admin: EvidenceAdmin,
  ): Promise<EvidenceScenarioDraftRecord> {
    const expectedUpdatedAt = expectedTimestamp(input.expectedUpdatedAt);
    const card = await this.d.repository.findCard(cardId);
    if (card === null) throw new EvidenceNotFoundError("전술 카드를 찾을 수 없습니다.");
    if (card.updatedAt !== expectedUpdatedAt) throw new EvidenceConflictError();
    this.assertCurrentCard(card);
    if (card.status !== "owner_reviewed" && card.status !== "coach_reviewed") {
      throw new EvidenceConflictError(
        "승인된 전술 카드만 시나리오 초안으로 전환할 수 있습니다.",
      );
    }
    const reviewedCard = parseTacticCardContent(card.currentContentJson);
    if (!reviewedCard.scenarioSuitable || !reviewedCard.animationSuitable) {
      throw new EvidenceConflictError(
        "문제와 애니메이션 제작에 적합한 카드만 전환할 수 있습니다.",
      );
    }
    if (card.currentReviewId === null)
      throw new EvidenceConflictError("현재 카드의 승인 스냅샷을 찾을 수 없습니다.");
    const review = await this.d.repository.findCardReview(
      card.currentReviewId,
      card.id,
    );
    if (review === null)
      throw new EvidenceConflictError("현재 카드의 승인 스냅샷을 찾을 수 없습니다.");
    const citations = await this.d.repository.listCardCitations(card.id);
    const snapshot = exactCitationSnapshot(
      reviewedCard,
      citations,
      card.bundleVersion,
    );
    if (JSON.stringify(snapshot) !== review.citationSnapshotJson) {
      throw new EvidenceConflictError("현재 카드의 근거가 승인 스냅샷과 일치하지 않습니다.");
    }
    const existing = await this.d.repository.findScenarioDraftByReview(
      review.id,
      card.id,
      expectedUpdatedAt,
    );
    if (existing !== null) return existing;
    if (!SCENARIO_ROLES.includes(input.role))
      throw new EvidenceRequestValidationError("role이 올바르지 않습니다.");
    if (!SCENARIO_PRINCIPLES.includes(input.principle))
      throw new EvidenceRequestValidationError("principle이 올바르지 않습니다.");
    if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0)
      throw new EvidenceRequestValidationError("orderIndex가 올바르지 않습니다.");
    const content: ScenarioContent = parseScenarioContent({
      ...parseScenarioContent(input.content),
      review: {
        sourceReviewed: false,
        timelineReviewed: false,
        explanationsReviewed: false,
      },
    });
    const now = this.now();
    const scenario: EvidenceScenarioDraftRecord = {
      id: this.id(),
      campaignId: requiredText(input.campaignId, "campaignId"),
      role: input.role,
      principle: input.principle,
      prompt: requiredText(input.prompt, "prompt"),
      hint: requiredText(input.hint, "hint"),
      explanation: requiredText(input.explanation, "explanation"),
      pitchJson: JSON.stringify(content.pitch),
      answerJson: JSON.stringify(content.answer),
      contentJson: JSON.stringify(content),
      reviewStatus: "draft",
      orderIndex: input.orderIndex,
    };
    if (!(await this.d.repository.campaignExists(scenario.campaignId))) {
      throw new EvidenceNotFoundError("캠페인을 찾을 수 없습니다.");
    }
    const sourceIds = [
      ...new Set(
        snapshot.flatMap((citation) =>
          citation.sourceId === null ? [] : [citation.sourceId],
        ),
      ),
    ].sort();
    const chunkIds = snapshot.map((citation) => citation.chunkId);
    const audit = this.audit(
      { id: card.bundleId },
      admin,
      "scenario.draft_created",
      "scenario",
      scenario.id,
      {
        cardId: card.id,
        reviewId: review.id,
        bundleVersion: card.bundleVersion,
        citationSnapshot: snapshot,
      },
      now,
    );
    try {
      const created = await this.d.repository.createScenarioDraft({
        card,
        review,
        expectedUpdatedAt,
        scenario,
        chunkIds,
        sourceIds,
        audit,
        createdAt: now,
      });
      if (created === "campaign_missing")
        throw new EvidenceNotFoundError("캠페인을 찾을 수 없습니다.");
      if (created === "conflict") throw new EvidenceConflictError();
    } catch (error) {
      const winner = await this.d.repository.findScenarioDraftByReview(
        review.id,
        card.id,
        expectedUpdatedAt,
      );
      if (winner !== null) return winner;
      const current = await this.d.repository.findCard(card.id);
      if (
        current === null ||
        current.updatedAt !== expectedUpdatedAt ||
        current.isStale ||
        current.bundleVersion !== current.currentBundleVersion ||
        current.currentReviewId !== review.id
      ) {
        throw new EvidenceConflictError();
      }
      if (!(await this.d.repository.campaignExists(scenario.campaignId))) {
        throw new EvidenceNotFoundError("캠페인을 찾을 수 없습니다.");
      }
      throw error;
    }
    const created = await this.d.repository.findScenarioDraftByReview(
      review.id,
      card.id,
      expectedUpdatedAt,
    );
    if (created === null)
      throw new Error("시나리오 초안 저장 결과를 확인할 수 없습니다.");
    return created;
  }
  async listCardsForJob(
    jobId: string,
    admin: EvidenceAdmin,
    page: { offset?: number; limit?: number; citationLimit?: number } = {},
  ): Promise<EvidenceCardsPage> {
    void admin;
    const offset = page.offset ?? 0;
    const limit = Math.min(page.limit ?? 20, 20);
    const citationLimit = Math.min(page.citationLimit ?? 20, 20);
    const [cards, totalCount] = await Promise.all([
      this.d.repository.listCardsForJob(jobId, offset, limit),
      this.d.repository.countCardsForJob(jobId),
    ]);
    const details = await Promise.all(
      cards.map(async (card) => ({
        ...card,
        citationCount: await this.d.repository.countCardCitations(card.id, card.bundleVersion),
        citations: await this.d.repository.listCardCitationsForAdmin(card.id, card.bundleVersion, citationLimit),
      })),
    );
    const consumed = offset + details.length;
    return { cards: details, totalCount, nextOffset: consumed < totalCount ? consumed : null };
  }
  async getBundleForAdmin(
    id: string,
    a: EvidenceAdmin,
  ): Promise<EvidenceBundleDetail | null> {
    void a;
    const b = await this.d.repository.getBundle(id);
    return b
      ? {
          ...b,
          sources: await this.d.repository.listSources(id),
          videoClips: await this.d.repository.listVideoClips(id),
        }
      : null;
  }
  async listBundlesForAdmin(a: EvidenceAdmin) {
    void a;
    return this.d.repository.listBundles();
  }
  private assertCurrentCard(card: EvidenceCardRecord): void {
    if (card.isStale || card.bundleVersion !== card.currentBundleVersion) {
      throw new EvidenceConflictError(
        "오래된 근거 묶음 버전의 카드는 검수하거나 전환할 수 없습니다.",
      );
    }
  }
  private async commit(m: EvidenceMutation) {
    if (!(await this.d.repository.applyMutation(m)))
      throw new EvidenceConflictError();
  }
  private async need(id: string) {
    const b = await this.d.repository.getBundle(id);
    if (!b) throw new EvidenceNotFoundError("근거 묶음을 찾을 수 없습니다.");
    return b;
  }
  private hash(
    p: string,
    s: Pick<StoredEvidenceFile, "contentHash">[],
    c: VideoClipInput[],
  ) {
    return computeEvidenceVersion({
      purpose: p,
      sourceHashes: s.map((x) => x.contentHash),
      clips: c,
      ...this.d.settings,
    });
  }
  private links(x: EvidenceDeleteImpact) {
    if (x.cardIds.length || x.scenarioDraftIds.length)
      throw new EvidenceConflictError(
        "연결된 카드 또는 시나리오 초안이 있어 근거를 삭제할 수 없습니다.",
      );
  }
  private audit(
    b: Pick<EvidenceBundleRecord, "id">,
    a: EvidenceAdmin,
    ac: string,
    t: string,
    id: string,
    o: object,
    at: number,
  ): EvidenceAuditEventInput {
    return {
      id: this.id(),
      bundleId: b.id,
      actorUserId: a.userId,
      action: ac,
      targetType: t,
      targetId: id,
      detailsJson: JSON.stringify(o),
      createdAt: at,
    };
  }
  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private id() {
    return this.d.newId?.() ?? crypto.randomUUID();
  }
}
