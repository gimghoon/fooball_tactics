import { runEvidenceProductionRoute } from "@/lib/server/evidence-route-entry";
import { handleEvidenceCollectionCreate, handleEvidenceCollectionList } from "@/lib/server/evidence-routes";

export function GET(request: Request) {
  return runEvidenceProductionRoute(request, handleEvidenceCollectionList);
}

export function POST(request: Request) {
  return runEvidenceProductionRoute(request, (runtime) => handleEvidenceCollectionCreate(request, runtime));
}
