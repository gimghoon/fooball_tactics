import { env, waitUntil } from "cloudflare:workers";

import { requireEvidenceAdminApi } from "./evidence-auth-runtime.ts";
import { createEvidenceProductionRouteRuntime } from "./evidence-route-runtime.ts";
import { bindEvidenceSchedule, runEvidenceAdminRoute, type EvidenceRouteRuntime } from "./evidence-routes.ts";
import type { EvidenceProductionBindings } from "./evidence-runtime.ts";
import type { EvidenceAnalyzerEnvironment } from "./openai-evidence-analyzer.ts";
import type { EvidenceSearchEnvironment } from "./openai-evidence-search.ts";

type EvidenceWorkerEnvironment = Partial<
  EvidenceProductionBindings & EvidenceAnalyzerEnvironment & EvidenceSearchEnvironment
>;

function workerEnvironment(): EvidenceWorkerEnvironment {
  return env as unknown as EvidenceWorkerEnvironment;
}

/** Non-injectable production boundary used by every evidence route entrypoint. */
export function runEvidenceProductionRoute(
  request: Request,
  handle: (runtime: EvidenceRouteRuntime) => Promise<Response>,
): Promise<Response> {
  return runEvidenceAdminRoute(
    request,
    requireEvidenceAdminApi,
    (admin) => {
      const bindings = workerEnvironment();
      return createEvidenceProductionRouteRuntime({
        admin,
        bindings: {
          DB: bindings.DB!,
          EVIDENCE_FILES: bindings.EVIDENCE_FILES!,
        },
        analyzerEnvironment: {
          EVIDENCE_LLM_ENDPOINT: bindings.EVIDENCE_LLM_ENDPOINT ?? process.env.EVIDENCE_LLM_ENDPOINT,
          EVIDENCE_LLM_API_KEY: bindings.EVIDENCE_LLM_API_KEY ?? process.env.EVIDENCE_LLM_API_KEY,
          EVIDENCE_LLM_MODEL: bindings.EVIDENCE_LLM_MODEL ?? process.env.EVIDENCE_LLM_MODEL,
        },
        searchEnvironment: {
          EVIDENCE_SEARCH_MODEL: bindings.EVIDENCE_SEARCH_MODEL ?? process.env.EVIDENCE_SEARCH_MODEL,
          EVIDENCE_EXTERNAL_ALLOWED_HOSTS: bindings.EVIDENCE_EXTERNAL_ALLOWED_HOSTS ?? process.env.EVIDENCE_EXTERNAL_ALLOWED_HOSTS,
        },
        schedule: bindEvidenceSchedule(waitUntil),
      });
    },
    handle,
  );
}
