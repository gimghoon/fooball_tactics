import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceCardReview } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ cardId: string }> };

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceCardReview(request, context, runtime));
}
