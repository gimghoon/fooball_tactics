import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import {
  handleEvidenceSearchGet,
  handleEvidenceSearchSelection,
} from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string; runId: string }> };

export function GET(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) =>
    handleEvidenceSearchGet(context, runtime));
}

export function PATCH(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) =>
    handleEvidenceSearchSelection(request, context, runtime));
}
