import type { EvidenceAdmin } from "./evidence-auth.ts";
import {
  EvidenceExternalSearchJobs,
} from "./evidence-search-jobs.ts";
import type { EvidenceSourcePolicy } from "./evidence-source-policy.ts";
import {
  D1EvidenceServiceRepository,
  EvidenceService,
  type EvidenceAnalysisSettings,
  type EvidenceD1Database,
} from "./evidence-service.ts";
import {
  EvidenceFileStore,
  type EvidenceR2Bucket,
  type EvidenceSourceRegistrationPort,
} from "./evidence-storage.ts";
import {
  fetchExternalEvidence,
  resolveHostWithCloudflareDns,
} from "./evidence-web-fetcher.ts";
import type { EvidenceSearchProvider } from "./openai-evidence-search.ts";

export type EvidenceProductionBindings = {
  DB: EvidenceD1Database;
  EVIDENCE_FILES: EvidenceR2Bucket;
};

export type EvidenceProductionRuntimeDependencies = {
  bindings: EvidenceProductionBindings;
  admin: EvidenceAdmin;
  settings: EvidenceAnalysisSettings;
  now?: () => number;
  newId?: () => string;
  externalSearch?: {
    provider: EvidenceSearchProvider;
    policy: EvidenceSourcePolicy;
    promptVersion: string;
    schedule(promise: Promise<unknown>): void;
    fetch?: typeof fetch;
    resolveHost?: (host: string, signal: AbortSignal) => Promise<string[]>;
    newId?: () => string;
  };
};

/** Per-admin production composition for D1-authoritative metadata and R2 file pairs. */
export function createEvidenceProductionRuntime(dependencies: EvidenceProductionRuntimeDependencies) {
  const repository = new D1EvidenceServiceRepository(dependencies.bindings.DB);
  let registration: EvidenceSourceRegistrationPort | null = null;
  const requiredRegistration: EvidenceSourceRegistrationPort = {
    findExisting(bundleId, contentHash, canonicalUrl) {
      if (registration === null) throw new Error("근거 자료 등록 서비스가 구성되지 않았습니다.");
      return registration.findExisting(bundleId, contentHash, canonicalUrl);
    },
    findById(sourceId) {
      if (registration === null) throw new Error("근거 자료 등록 서비스가 구성되지 않았습니다.");
      return registration.findById(sourceId);
    },
    register(source) {
      if (registration === null) throw new Error("근거 자료 등록 서비스가 구성되지 않았습니다.");
      return registration.register(source);
    },
    startCleanup(input) {
      if (registration === null) throw new Error("근거 자료 등록 서비스가 구성되지 않았습니다.");
      return registration.startCleanup(input);
    },
    finishCleanup(receiptId, completion) {
      if (registration === null) throw new Error("근거 자료 등록 서비스가 구성되지 않았습니다.");
      return registration.finishCleanup(receiptId, completion);
    },
  };
  const fileStore = new EvidenceFileStore({
    bucket: dependencies.bindings.EVIDENCE_FILES,
    registration: requiredRegistration,
  });
  const service = new EvidenceService({
    repository,
    settings: dependencies.settings,
    fileStore,
    now: dependencies.now,
    newId: dependencies.newId,
  });
  registration = service.sourceRegistration(dependencies.admin);
  const externalSearch = dependencies.externalSearch;
  let searchJobs: EvidenceExternalSearchJobs | null = null;
  if (externalSearch !== undefined) {
    const fetchImpl = externalSearch.fetch ?? globalThis.fetch;
    const now = dependencies.now ?? Date.now;
    const resolveHost = externalSearch.resolveHost
      ?? ((host: string, signal: AbortSignal) => resolveHostWithCloudflareDns(host, signal, fetchImpl));
    searchJobs = new EvidenceExternalSearchJobs({
      db: dependencies.bindings.DB,
      provider: externalSearch.provider,
      policy: externalSearch.policy,
      files: fileStore,
      promptVersion: externalSearch.promptVersion,
      schedule: externalSearch.schedule,
      fetchExternalEvidence: (input) => fetchExternalEvidence(input, {
        fetch: fetchImpl,
        resolveHost,
        policy: externalSearch.policy,
        now,
      }),
      now: dependencies.now,
      newId: externalSearch.newId,
    });
  }
  return { service, fileStore, searchJobs };
}
