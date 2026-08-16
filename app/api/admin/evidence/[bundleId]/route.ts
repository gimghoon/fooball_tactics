import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceBundleGet, handleEvidenceBundleUpdate } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string }> };

export function GET(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceBundleGet(context, runtime));
}

export function PATCH(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceBundleUpdate(request, context, runtime));
}
