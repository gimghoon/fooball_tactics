import {
  computeEvidenceVersion,
  parseBundleInput,
  parseVideoClip,
  type EvidenceBundleInput,
  type VideoClipInput,
} from "../domain/evidence.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import type { EvidenceFileStore, StoredEvidenceFile } from "./evidence-storage.ts";

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

/**
 * A transaction boundary intentionally kept above D1. Production adapters must
 * make this callback atomic (D1 batch/transaction); the narrow seam lets tests
 * observe rollback, staleness, and audit writes without parsing SQL.
 */
export type EvidenceServiceTransaction = {
  getBundle(id: string): Promise<EvidenceBundleRecord | null>;
  listBundles(): Promise<EvidenceBundleRecord[]>;
  listSources(bundleId: string): Promise<StoredEvidenceFile[]>;
  findSource(sourceId: string): Promise<StoredEvidenceFile | null>;
  listVideoClips(bundleId: string): Promise<EvidenceVideoClipRecord[]>;
  createBundle(bundle: EvidenceBundleRecord): Promise<void>;
  updateBundle(bundle: EvidenceBundleRecord): Promise<void>;
  addVideoClip(clip: EvidenceVideoClipRecord): Promise<void>;
  removeSource(sourceId: string): Promise<void>;
  /** Marks jobs/cards from prior content versions stale and revokes approval eligibility. */
  invalidateBundle(bundleId: string): Promise<void>;
  recordAudit(event: EvidenceAuditEventInput): Promise<void>;
  describeDeleteImpact(sourceId: string): Promise<EvidenceDeleteImpact>;
};

export type EvidenceServiceRepository = EvidenceServiceTransaction & {
  transaction<T>(work: (transaction: EvidenceServiceTransaction) => Promise<T>): Promise<T>;
};

export type EvidenceBundleDetail = EvidenceBundleRecord & {
  sources: StoredEvidenceFile[];
  videoClips: EvidenceVideoClipRecord[];
};

export type EvidenceBundleUpdate = Partial<EvidenceBundleInput>;

export class EvidenceService {
  constructor(private readonly dependencies: {
    repository: EvidenceServiceRepository;
    settings: EvidenceAnalysisSettings;
    fileStore?: Pick<EvidenceFileStore, "deleteFilePair">;
    now?: () => number;
    newId?: () => string;
  }) {}

  async createBundle(input: unknown, admin: EvidenceAdmin): Promise<EvidenceBundleRecord> {
    const parsed = parseBundleInput(input);
    return this.dependencies.repository.transaction(async (transaction) => {
      const now = this.now();
      const bundle: EvidenceBundleRecord = {
        id: this.newId(),
        ...parsed,
        version: 1,
        contentVersion: await this.contentVersion([], []),
        createdAt: now,
        updatedAt: now,
      };
      await transaction.createBundle(bundle);
      await transaction.recordAudit(this.audit(bundle.id, admin, "bundle.created", "bundle", bundle.id, { title: bundle.title, purpose: bundle.purpose }, now));
      return bundle;
    });
  }

  async updateBundle(id: string, update: EvidenceBundleUpdate, admin: EvidenceAdmin): Promise<EvidenceBundleRecord> {
    return this.dependencies.repository.transaction(async (transaction) => {
      const current = await this.requiredBundle(transaction, id);
      const nextInput = parseBundleInput({ title: update.title ?? current.title, purpose: update.purpose ?? current.purpose });
      const contentChanged = nextInput.purpose !== current.purpose;
      const now = this.now();
      const updated: EvidenceBundleRecord = {
        ...current,
        ...nextInput,
        version: contentChanged ? current.version + 1 : current.version,
        contentVersion: contentChanged
          ? await this.versionForBundle(transaction, id)
          : current.contentVersion,
        updatedAt: now,
      };
      await transaction.updateBundle(updated);
      if (contentChanged) await transaction.invalidateBundle(id);
      await transaction.recordAudit(this.audit(id, admin, "bundle.updated", "bundle", id, {
        contentChanged,
        title: updated.title,
        purpose: updated.purpose,
      }, now));
      return updated;
    });
  }

  async addVideoClip(bundleId: string, input: unknown, admin: EvidenceAdmin): Promise<EvidenceBundleRecord> {
    const parsed = parseVideoClip(input);
    return this.dependencies.repository.transaction(async (transaction) => {
      const bundle = await this.requiredBundle(transaction, bundleId);
      const now = this.now();
      const clip: EvidenceVideoClipRecord = { id: this.newId(), bundleId, ...parsed, createdAt: now, updatedAt: now };
      const sources = await transaction.listSources(bundleId);
      const clips = await transaction.listVideoClips(bundleId);
      const updated: EvidenceBundleRecord = {
        ...bundle,
        version: bundle.version + 1,
        contentVersion: await this.contentVersion(sources, [...clips, clip]),
        updatedAt: now,
      };
      await transaction.addVideoClip(clip);
      await transaction.updateBundle(updated);
      await transaction.invalidateBundle(bundleId);
      await transaction.recordAudit(this.audit(bundleId, admin, "video_clip.added", "video_clip", clip.id, {
        url: clip.url, startMs: clip.startMs, endMs: clip.endMs, observation: clip.observation,
      }, now));
      return updated;
    });
  }

  async describeDeleteImpact(sourceId: string): Promise<EvidenceDeleteImpact> {
    return this.dependencies.repository.describeDeleteImpact(sourceId);
  }

  async removeSource(sourceId: string, admin: EvidenceAdmin): Promise<EvidenceBundleRecord> {
    const impact = await this.describeDeleteImpact(sourceId);
    this.assertUnlinked(impact);
    const source = await this.dependencies.repository.findSource(sourceId);
    if (source === null) throw new Error("근거 파일을 찾을 수 없습니다.");
    if (!this.dependencies.fileStore) throw new Error("근거 파일 저장소가 구성되지 않았습니다.");

    // `deleteFilePair` compensates either key on failure. Do not mutate D1 until
    // it resolves, otherwise callers could receive a successful D1 deletion
    // while recoverable R2 deletion failed.
    await this.dependencies.fileStore.deleteFilePair(source.storageKey, source.extractedTextKey);

    return this.dependencies.repository.transaction(async (transaction) => {
      const currentSource = await transaction.findSource(sourceId);
      if (currentSource === null) throw new Error("근거 파일을 찾을 수 없습니다.");
      this.assertUnlinked(await transaction.describeDeleteImpact(sourceId));
      const bundle = await this.requiredBundle(transaction, currentSource.bundleId);
      const now = this.now();
      await transaction.removeSource(sourceId);
      const updated: EvidenceBundleRecord = {
        ...bundle,
        version: bundle.version + 1,
        contentVersion: await this.versionForBundle(transaction, bundle.id),
        updatedAt: now,
      };
      await transaction.updateBundle(updated);
      await transaction.invalidateBundle(bundle.id);
      await transaction.recordAudit(this.audit(bundle.id, admin, "source.removed", "source", sourceId, {
        originalFileName: currentSource.originalFileName,
      }, now));
      return updated;
    });
  }

  async getBundleForAdmin(id: string, admin: EvidenceAdmin): Promise<EvidenceBundleDetail | null> {
    void admin;
    const bundle = await this.dependencies.repository.getBundle(id);
    if (bundle === null) return null;
    const [sources, videoClips] = await Promise.all([
      this.dependencies.repository.listSources(id),
      this.dependencies.repository.listVideoClips(id),
    ]);
    return { ...bundle, sources, videoClips };
  }

  async listBundlesForAdmin(admin: EvidenceAdmin): Promise<EvidenceBundleRecord[]> {
    void admin;
    return this.dependencies.repository.listBundles();
  }

  private async versionForBundle(transaction: EvidenceServiceTransaction, bundleId: string): Promise<string> {
    const [sources, clips] = await Promise.all([transaction.listSources(bundleId), transaction.listVideoClips(bundleId)]);
    return this.contentVersion(sources, clips);
  }

  private contentVersion(sources: Pick<StoredEvidenceFile, "contentHash">[], clips: VideoClipInput[]): Promise<string> {
    return computeEvidenceVersion({ sourceHashes: sources.map((source) => source.contentHash), clips, ...this.dependencies.settings });
  }

  private async requiredBundle(transaction: EvidenceServiceTransaction, id: string): Promise<EvidenceBundleRecord> {
    const bundle = await transaction.getBundle(id);
    if (bundle === null) throw new Error("근거 묶음을 찾을 수 없습니다.");
    return bundle;
  }

  private assertUnlinked(impact: EvidenceDeleteImpact): void {
    if (impact.cardIds.length > 0 || impact.scenarioDraftIds.length > 0) {
      throw new Error("연결된 카드 또는 시나리오 초안이 있어 근거를 삭제할 수 없습니다.");
    }
  }

  private audit(bundleId: string, admin: EvidenceAdmin, action: string, targetType: string, targetId: string, details: object, createdAt: number): EvidenceAuditEventInput {
    return { bundleId, actorUserId: admin.userId, action, targetType, targetId, detailsJson: JSON.stringify(details), createdAt };
  }

  private now(): number { return this.dependencies.now?.() ?? Date.now(); }
  private newId(): string { return this.dependencies.newId?.() ?? crypto.randomUUID(); }
}
