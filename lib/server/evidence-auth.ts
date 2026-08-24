import type { ChatGPTUser } from "../../app/chatgpt-auth.ts";

export type EvidenceAdmin = ChatGPTUser;

export type EvidenceAdminPageDecision =
  | { kind: "admin"; admin: EvidenceAdmin }
  | { kind: "signin"; returnTo: string }
  | { kind: "forbidden" };

export type EvidenceAdminApiDecision =
  | { kind: "admin"; admin: EvidenceAdmin }
  | { kind: "response"; status: 401 | 403; error: string };

export function resolveEvidenceAdminUserIds(
  workerValue: string | undefined,
  processValue: string | undefined,
): string | undefined {
  return workerValue ?? processValue;
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
  if (!user) return null;
  const allowlist = parseAdminUserIds(raw);
  const email = user.email.trim().toLowerCase();
  const emailAllowed = [...allowlist].some((value) => value.toLowerCase() === email);
  if (!allowlist.has(user.userId) && !emailAllowed) return null;
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
