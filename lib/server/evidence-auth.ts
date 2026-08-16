import type { ChatGPTUser } from "../../app/chatgpt-auth.ts";

export type EvidenceAdmin = ChatGPTUser;

export type EvidenceAdminAuthDependencies = {
  getUser?: () => Promise<ChatGPTUser | null>;
  adminUserIds?: string;
  redirect?: (path: string) => never;
};

const ADMIN_USER_IDS_ENV = "EVIDENCE_ADMIN_USER_IDS";

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

async function authenticatedUser(
  dependencies?: EvidenceAdminAuthDependencies,
): Promise<ChatGPTUser | null> {
  if (dependencies?.getUser) return dependencies.getUser();
  const { getChatGPTUser } = await import("../../app/chatgpt-auth.ts");
  return getChatGPTUser();
}

function configuredAdminUserIds(
  dependencies?: EvidenceAdminAuthDependencies,
): string | undefined {
  return dependencies?.adminUserIds ?? process.env[ADMIN_USER_IDS_ENV];
}

export async function requireEvidenceAdminPage(
  returnTo: string,
  dependencies?: EvidenceAdminAuthDependencies,
): Promise<EvidenceAdmin> {
  const user = await authenticatedUser(dependencies);
  if (!user) {
    const { requireChatGPTUser } = await import("../../app/chatgpt-auth.ts");
    return requireChatGPTUser(returnTo);
  }

  const admin = authorizeEvidenceAdmin(user, configuredAdminUserIds(dependencies));
  if (admin) return admin;

  if (dependencies?.redirect) return dependencies.redirect("/");
  const { redirect } = await import("next/navigation");
  return redirect("/");
}

export async function requireEvidenceAdminApi(
  request: Request,
  dependencies?: EvidenceAdminAuthDependencies,
): Promise<EvidenceAdmin | Response> {
  void request;
  const user = await authenticatedUser(dependencies);
  const admin = authorizeEvidenceAdmin(user, configuredAdminUserIds(dependencies));
  if (!admin) {
    return Response.json(
      { error: user ? "자료 관리자 권한이 필요해요." : "로그인이 필요해요." },
      { status: user ? 403 : 401 },
    );
  }
  return admin;
}
