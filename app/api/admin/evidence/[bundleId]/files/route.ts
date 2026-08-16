import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceFileUpload } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string }> };

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceFileUpload(request, context, runtime));
}
