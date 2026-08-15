export function normalizeNickname(value: string) {
  const nickname = value.trim().replace(/\s+/g, " ");
  if (!nickname) throw new Error("닉네임을 입력해주세요.");
  if ([...nickname].length > 16) throw new Error("닉네임은 16자 이하여야 합니다.");
  return nickname;
}

export function createRecoveryToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashRecoveryToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

