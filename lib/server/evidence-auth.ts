import type { ChatGPTUser } from "../../app/chatgpt-auth.ts";

export type EvidenceAdmin = ChatGPTUser;

export type EvidenceAdminPageDecision =
  | { kind: "admin"; admin: EvidenceAdmin }
  | { kind: "signin"; returnTo: string }
  | { kind: "forbidden" };

export type EvidenceAdminApiDecision =
  | { kind: "admin"; admin: EvidenceAdmin }
  | { kind: "response"; status: 401 | 403; error: string };

const ADMIN_USER_IDS_ENV = "EVIDENCE_ADMIN_USER_IDS";

type EvidenceAuthWorkerEnvironment = {
  EVIDENCE_ADMIN_USER_IDS?: string;
};

export function resolveEvidenceAdminUserIds(
  workerValue: string | undefined,
  processValue: string | undefined,
): string | undefined {
  return workerValue ?? processValue;
}

async function configuredEvidenceAdminUserIds(): Promise<string | undefined> {
  let workerValue: string | undefined;
  try {
    const { env } = await import("cloudflare:workers");
    workerValue = (env as unknown as EvidenceAuthWorkerEnvironment).EVIDENCE_ADMIN_USER_IDS;
  } catch {
    // Node-only tests and non-Workers local tools use the process fallback.
  }
  return resolveEvidenceAdminUserIds(workerValue, process.env[ADMIN_USER_IDS_ENV]);
}

export function parseAdminUserIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

export function authorizeEvidenceAdmin(
  user: ChatGPTUser | null,
  raw: string | undefined,
): EvidenceAdmin | null {
  if (!user || !parseAdminUserIds(raw).has(user.userId)) return null;
  return user;
}

export function decideEvidenceAdminPage(
  user: ChatGPTUser | null,
  raw: string | undefined,
  returnTo: string,
): EvidenceAdminPageDecision {
  if (!user) return { kind: "signin", returnTo };
  const admin = authorizeEvidenceAdmin(user, raw);
  return admin ? { kind: "admin", admin } : { kind: "forbidden" };
}

export function decideEvidenceAdminApi(
  user: ChatGPTUser | null,
  raw: string | undefined,
): EvidenceAdminApiDecision {
  const admin = authorizeEvidenceAdmin(user, raw);
  if (admin) return { kind: "admin", admin };
  return user
    ? { kind: "response", status: 403, error: "자료 관리자 권한이 필요해요." }
    : { kind: "response", status: 401, error: "로그인이 필요해요." };
}

export async function requireEvidenceAdminPage(
  returnTo: string,
): Promise<EvidenceAdmin> {
  const { getChatGPTUser, requireChatGPTUser } = await import("../../app/chatgpt-auth.ts");
  const decision = decideEvidenceAdminPage(
    await getChatGPTUser(),
    await configuredEvidenceAdminUserIds(),
    returnTo,
  );
  if (decision.kind === "admin") return decision.admin;
  if (decision.kind === "signin") return requireChatGPTUser(decision.returnTo);

  const { redirect } = await import("next/navigation");
  return redirect("/");
}

export async function requireEvidenceAdminApi(
  request: Request,
): Promise<EvidenceAdmin | Response> {
  void request;
  const { getChatGPTUser } = await import("../../app/chatgpt-auth.ts");
  const decision = decideEvidenceAdminApi(
    await getChatGPTUser(),
    await configuredEvidenceAdminUserIds(),
  );
  if (decision.kind === "admin") return decision.admin;
  return Response.json(
    { error: decision.error },
    { status: decision.status },
  );
}

export async function getCurrentEvidenceAdmin(): Promise<EvidenceAdmin | null> {
  const { getChatGPTUser } = await import("../../app/chatgpt-auth.ts");
  return authorizeEvidenceAdmin(
    await getChatGPTUser(),
    await configuredEvidenceAdminUserIds(),
  );
}
