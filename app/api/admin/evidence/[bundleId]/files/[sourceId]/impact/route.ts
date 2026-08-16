import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceFileImpact } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string; sourceId: string }> };

export function GET(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceFileImpact(context, runtime));
}
