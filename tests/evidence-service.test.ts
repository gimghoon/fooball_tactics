import assert from "node:assert/strict";
import test from "node:test";

import {
  EvidenceService,
  type EvidenceAuditEventInput,
  type EvidenceBundleRecord,
  type EvidenceServiceRepository,
  type EvidenceServiceTransaction,
} from "../lib/server/evidence-service.ts";
import type { EvidenceAdmin } from "../lib/server/evidence-auth.ts";

const admin: EvidenceAdmin = {
  userId: "admin-1", email: "admin@example.test", displayName: "Admin", fullName: "Admin User",
};

const settings = { analyzerModel: "model-1", promptVersion: "prompt-1", schemaVersion: "schema-1" };

function validBundleInput() {
  return { title: "드리블 대응", purpose: "전방 압박 대응 분석" };
}

class FakeRepository implements EvidenceServiceRepository {
  bundles: EvidenceBundleRecord[] = [];
  sources: EvidenceServiceTransaction["listSources"] extends (bundleId: string) => Promise<infer T> ? T : never = [];
  clips: Awaited<ReturnType<EvidenceServiceTransaction["listVideoClips"]>> = [];
  cards: { id: string; bundleId: string; isStale: boolean }[] = [];
  audits: EvidenceAuditEventInput[] = [];
  transactions = 0;

  async transaction<T>(work: (transaction: EvidenceServiceTransaction) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const snapshot = structuredClone({ bundles: this.bundles, sources: this.sources, clips: this.clips, cards: this.cards, audits: this.audits });
    try {
      return await work(this);
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  async getBundle(id: string) { return this.bundles.find((bundle) => bundle.id === id) ?? null; }
  async listBundles() { return this.bundles.slice(); }
  async listSources(bundleId: string) { return this.sources.filter((source) => source.bundleId === bundleId); }
  async findSource(sourceId: string) { return this.sources.find((source) => source.id === sourceId) ?? null; }
  async listVideoClips(bundleId: string) { return this.clips.filter((clip) => clip.bundleId === bundleId); }
  async createBundle(bundle: EvidenceBundleRecord) { this.bundles.push(bundle); }
  async updateBundle(bundle: EvidenceBundleRecord) { this.bundles = this.bundles.map((item) => item.id === bundle.id ? bundle : item); }
  async addVideoClip(clip: Awaited<ReturnType<EvidenceServiceTransaction["listVideoClips"]>>[number]) { this.clips.push(clip); }
  async removeSource(sourceId: string) { this.sources = this.sources.filter((source) => source.id !== sourceId); }
  async invalidateBundle(bundleId: string) { this.cards = this.cards.map((card) => card.bundleId === bundleId ? { ...card, isStale: true } : card); }
  async recordAudit(event: Parameters<EvidenceServiceTransaction["recordAudit"]>[0]) { this.audits.push(event); }
  async describeDeleteImpact(sourceId: string) {
    return { sourceId, cardIds: sourceId === "source-1" ? ["card-1"] : [], scenarioDraftIds: [] };
  }
}

test("changing source observations increments version and stales prior cards", async () => {
  const repository = new FakeRepository();
  const service = new EvidenceService({ repository, settings });
  const bundle = await service.createBundle(validBundleInput(), admin);
  repository.cards.push({ id: "card-1", bundleId: bundle.id, isStale: false });

  const changed = await service.addVideoClip(bundle.id, {
    url: "https://video.example.test/press", startMs: 0, endMs: 3_000, observation: "새 관찰",
  }, admin);

  assert.equal(changed.version, bundle.version + 1);
  assert.equal(repository.cards[0]?.isStale, true);
  assert.equal(repository.audits.at(-1)?.action, "video_clip.added");
  assert.equal(repository.transactions, 2);
});

test("metadata-only title updates retain content version and still audit atomically", async () => {
  const repository = new FakeRepository();
  const service = new EvidenceService({ repository, settings });
  const bundle = await service.createBundle(validBundleInput(), admin);

  const updated = await service.updateBundle(bundle.id, { title: "새 제목" }, admin);

  assert.equal(updated.version, bundle.version);
  assert.equal(updated.contentVersion, bundle.contentVersion);
  assert.equal(repository.audits.at(-1)?.targetId, bundle.id);
});

test("linked cards block deletion and report impact before R2 deletion", async () => {
  const repository = new FakeRepository();
  const deleted: string[] = [];
  const service = new EvidenceService({
    repository,
    settings,
    fileStore: { deleteFilePair: async (...keys: [string, string | null]) => { deleted.push(keys.join(":")); } },
  });
  repository.sources.push({
    id: "source-1", bundleId: "bundle-1", originalFileName: "notes.md", mediaType: "text/markdown", byteSize: 1,
    contentHash: "source-hash", storageKey: "original", extractedTextKey: "extracted", extractionStatus: "completed", extractionError: null,
  });
  repository.bundles.push({ id: "bundle-1", ...validBundleInput(), version: 1, contentVersion: "version", createdAt: 0, updatedAt: 0 });

  const impact = await service.describeDeleteImpact("source-1");
  assert.deepEqual(impact.cardIds, ["card-1"]);
  await assert.rejects(() => service.removeSource("source-1", admin), /연결/);
  assert.deepEqual(deleted, []);
});

test("a failed R2 deletion leaves the source row untouched and rejects the mutation", async () => {
  const repository = new FakeRepository();
  const service = new EvidenceService({
    repository,
    settings,
    fileStore: { deleteFilePair: async () => { throw new Error("R2 delete failed"); } },
  });
  repository.sources.push({
    id: "source-2", bundleId: "bundle-2", originalFileName: "notes.md", mediaType: "text/markdown", byteSize: 1,
    contentHash: "source-hash", storageKey: "original", extractedTextKey: null, extractionStatus: "completed", extractionError: null,
  });
  repository.bundles.push({ id: "bundle-2", ...validBundleInput(), version: 1, contentVersion: "version", createdAt: 0, updatedAt: 0 });

  await assert.rejects(() => service.removeSource("source-2", admin), /R2 delete failed/);
  assert.equal(repository.sources.length, 1);
});
