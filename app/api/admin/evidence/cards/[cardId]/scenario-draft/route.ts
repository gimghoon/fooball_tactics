import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceScenarioDraft } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ cardId: string }> };

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceScenarioDraft(request, context, runtime));
}
