import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceJobRetry, handleEvidenceJobStatus } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ jobId: string }> };

export function GET(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceJobStatus(request, context, runtime));
}

export function POST(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceJobRetry(context, runtime));
}
