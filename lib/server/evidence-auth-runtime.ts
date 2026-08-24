import { env } from "cloudflare:workers";

import { getChatGPTUser } from "../../app/chatgpt-auth.ts";
import {
  decideEvidenceAdminApi,
  resolveEvidenceAdminUserIds,
  type EvidenceAdmin,
} from "./evidence-auth.ts";

type EvidenceAuthWorkerEnvironment = {
  EVIDENCE_ADMIN_USER_IDS?: string;
};

const ADMIN_USER_IDS_ENV = "EVIDENCE_ADMIN_USER_IDS";

function configuredEvidenceAdminUserIds(): string | undefined {
  const workerValue = (env as unknown as EvidenceAuthWorkerEnvironment).EVIDENCE_ADMIN_USER_IDS;
  return resolveEvidenceAdminUserIds(workerValue, process.env[ADMIN_USER_IDS_ENV]);
}

export async function requireEvidenceAdminApi(request: Request): Promise<EvidenceAdmin | Response> {
  void request;
  const decision = decideEvidenceAdminApi(
    await getChatGPTUser(),
    configuredEvidenceAdminUserIds(),
  );
  if (decision.kind === "admin") return decision.admin;
  return Response.json({ error: decision.error }, { status: decision.status });
}
