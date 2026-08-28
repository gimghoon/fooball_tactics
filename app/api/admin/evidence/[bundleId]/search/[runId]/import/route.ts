import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceSearchImport } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string; runId: string }> };

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) =>
    handleEvidenceSearchImport(context, runtime));
}
