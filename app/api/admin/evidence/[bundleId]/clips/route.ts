import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceClipCreate } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string }> };

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceClipCreate(request, context, runtime));
}
