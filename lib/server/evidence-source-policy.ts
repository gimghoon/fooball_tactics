export type EvidenceSourcePolicy = {
  classify(url: URL): 1 | 2 | 3 | null;
  assertAllowed(url: URL): 1 | 2 | 3;
};

/** Creates the server-owned source allowlist used for both search and import boundaries. */
export function createEvidenceSourcePolicy(rawHosts: string): EvidenceSourcePolicy {
  const entries = rawHosts.split(",").map((item) => {
    const match = item.trim().match(/^([123]):([a-z0-9.-]+)$/i);
    if (!match || !match[2]!.includes(".") || match[2]!.includes("..")) throw new Error("외부 출처 호스트 설정이 올바르지 않습니다.");
    return { tier: Number(match[1]) as 1 | 2 | 3, host: match[2]!.toLowerCase().replace(/\.$/, "") };
  }).sort((a, b) => b.host.length - a.host.length);
  const classify = (url: URL) => {
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return entries.find(({ host }) => url.hostname === host || url.hostname.endsWith(`.${host}`))?.tier ?? null;
  };
  return {
    classify,
    assertAllowed(url) {
      const tier = classify(url);
      if (tier === null) throw new Error("허용된 외부 출처가 아닙니다.");
      return tier;
    },
  };
}
