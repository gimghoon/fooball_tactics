import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceFileDelete, handleEvidenceFileDownload } from "@/lib/server/evidence-routes";

type Context = { params: Promise<{ bundleId: string; sourceId: string }> };

export function GET(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceFileDownload(context, runtime));
}

export function DELETE(request: Request, context: Context) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceFileDelete(context, runtime));
}
