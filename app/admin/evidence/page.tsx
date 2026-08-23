import { requireEvidenceAdminPage } from "@/lib/server/evidence-auth";
import { EvidenceWizard } from "./EvidenceWizard";
import "./evidence-admin.css";

export const dynamic = "force-dynamic";

export default async function EvidenceAdminPage() {
  await requireEvidenceAdminPage("/admin/evidence");
  return <EvidenceWizard initialBundles={[]} />;
}
