import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import {
  handleEvidenceSearchLatest,
  handleEvidenceSearchStart,
} from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string }> };

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) =>
    handleEvidenceSearchStart(context, runtime));
}

export function GET(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) =>
    handleEvidenceSearchLatest(context, runtime));
}
