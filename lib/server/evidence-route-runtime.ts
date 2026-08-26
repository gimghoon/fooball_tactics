import { createConfiguredEvidenceAnalyzer, type EvidenceAnalyzerEnvironment } from "./openai-evidence-analyzer.ts";
import type { EvidenceAdmin } from "./evidence-auth.ts";
import { EvidenceAnalysisJobs } from "./evidence-jobs.ts";
import { createEvidenceProductionRuntime, type EvidenceProductionBindings } from "./evidence-runtime.ts";
import type { EvidenceRouteRuntime } from "./evidence-routes.ts";

export const EVIDENCE_PROMPT_VERSION = "evidence-prompt-v1";
export const EVIDENCE_SCHEMA_VERSION = "evidence-card-schema-v1";

export type EvidenceProductionRouteRuntimeDependencies = {
  admin: EvidenceAdmin;
  bindings: EvidenceProductionBindings;
  analyzerEnvironment: EvidenceAnalyzerEnvironment;
  schedule(promise: Promise<unknown>): void;
};

/** Composes production D1/R2 services and lazily creates the analyzer only for job endpoints. */
export function createEvidenceProductionRouteRuntime(
  dependencies: EvidenceProductionRouteRuntimeDependencies,
): EvidenceRouteRuntime {
  if (!dependencies.bindings.DB || !dependencies.bindings.EVIDENCE_FILES) {
    throw new Error("근거 자료 저장소 바인딩이 필요합니다.");
  }

  let analysisJobs: EvidenceAnalysisJobs | null = null;
  const jobs = () => {
    if (analysisJobs !== null) return analysisJobs;
    const analyzer = createConfiguredEvidenceAnalyzer(dependencies.analyzerEnvironment, {
      onTransportError(diagnostic) {
        console.error("evidence_llm_transport", diagnostic);
      },
    });
    const settings = {
      analyzerModel: analyzer.modelId,
      promptVersion: EVIDENCE_PROMPT_VERSION,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
    };
    analysisJobs = new EvidenceAnalysisJobs({
      db: dependencies.bindings.DB,
      files: runtime.fileStore,
      analyzer,
      settings,
      schedule: dependencies.schedule,
    });
    return analysisJobs;
  };

  // Bundle versions use the configured model ID too. Configuration is validated
  // lazily, but service construction needs a stable contract version immediately.
  const configuredModel = dependencies.analyzerEnvironment.EVIDENCE_LLM_MODEL?.trim();
  if (!configuredModel) throw new Error("근거 분석 모델 설정이 필요합니다.");
  const settings = {
    analyzerModel: configuredModel,
    promptVersion: EVIDENCE_PROMPT_VERSION,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
  };
  const runtime = createEvidenceProductionRuntime({
    bindings: dependencies.bindings,
    admin: dependencies.admin,
    settings,
  });

  return {
    admin: dependencies.admin,
    service: runtime.service,
    fileStore: runtime.fileStore,
    jobs: {
      startAnalysis: (bundleId, admin) => jobs().startAnalysis(bundleId, admin),
      retryAnalysis: (jobId, admin) => jobs().retryAnalysis(jobId, admin),
      getAnalysisStatus: (jobId) => jobs().getAnalysisStatus(jobId),
      getLatestAnalysisStatusForBundle: (bundleId) => jobs().getLatestAnalysisStatusForBundle(bundleId),
    },
  };
}
