import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceAnalyzeStart } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string }> };

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceAnalyzeStart(context, runtime));
}
