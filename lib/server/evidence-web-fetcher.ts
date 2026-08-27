import { normalizeExternalUrl } from "../domain/evidence-search.ts";
import type { EvidenceSourcePolicy } from "./evidence-source-policy.ts";
import { validateEvidenceFile } from "./evidence-storage.ts";
import {
  extractHtmlTextSections,
  type ExtractedPage,
} from "./evidence-text-extractor.ts";

export const EXTERNAL_FETCH_LIMITS = {
  redirects: 4,
  bytes: 20 * 1024 * 1024,
  extractedTextBytes: 2 * 1024 * 1024,
  timeoutMs: 15_000,
} as const;

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TIMEOUT_MS = 2_000;
const DNS_RESPONSE_BYTES = 32 * 1024;
const DNS_ADDRESS_LIMIT = 16;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchedExternalEvidence = {
  finalUrl: string;
  mediaType: "application/pdf" | "text/plain";
  fileName: string;
  bytes: Uint8Array;
  extractedPages: ExtractedPage[];
  contentHash: string;
  retrievedAt: number;
};

export type ExternalEvidenceFetchDependencies = {
  fetch: typeof fetch;
  resolveHost: (host: string, signal: AbortSignal) => Promise<string[]>;
  policy: EvidenceSourcePolicy;
  now: () => number;
};

class ExternalFetchDeadlineError extends Error {
  constructor() {
    super("외부 문서 가져오기 시간 제한을 초과했습니다.");
    this.name = "ExternalFetchDeadlineError";
  }
}

class DeadlineGuard {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly interruption: Promise<never>;
  private rejectInterruption!: (error: Error) => void;
  private expired = false;

  constructor(private readonly now: () => number, timeoutMs: number) {
    this.deadline = now() + timeoutMs;
    this.signal = this.controller.signal;
    this.interruption = new Promise<never>((_resolve, reject) => {
      this.rejectInterruption = reject;
    });
    void this.interruption.catch(() => undefined);
    this.timer = setTimeout(() => this.expire(), Math.max(1, this.deadline - now()));
  }

  remaining(): number {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) {
      this.expire();
      throw new ExternalFetchDeadlineError();
    }
    return remaining;
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    this.remaining();
    // Give immediately-started stream pulls a checkpoint before entering a
    // potentially indefinite wait; production timeouts still use the timer.
    await Promise.resolve();
    this.remaining();
    try {
      return await Promise.race([operation, this.interruption]);
    } catch (error) {
      if (this.expired) throw new ExternalFetchDeadlineError();
      throw error;
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private expire(): void {
    if (this.expired) return;
    this.expired = true;
    this.controller.abort();
    this.rejectInterruption(new ExternalFetchDeadlineError());
  }
}

function assertSafeHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || parseIpv4(host) !== null
    || (host.startsWith("[") && host.endsWith("]"))
    || host.includes(":")
  ) {
    throw new Error("허용된 외부 출처 호스트가 아닙니다.");
  }
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function parseIpv6(value: string): number[] | null {
  const raw = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (raw.includes("%") || !/^[0-9a-f:.]+$/.test(raw)) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (half === "") return [];
    const groups: number[] = [];
    for (const item of half.split(":")) {
      const ipv4 = parseIpv4(item);
      if (ipv4 !== null) {
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
        groups.push(Number.parseInt(item, 16));
      }
    }
    return groups;
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? "");
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPublicIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(groups: number[]): boolean {
  const first = groups[0]!;
  // Only globally routed 2000::/3 space is accepted. Documentation addresses
  // are excluded even though they share that prefix.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  return true;
}

function assertOnlyPublicAddresses(addresses: string[]): void {
  if (addresses.length === 0 || addresses.length > DNS_ADDRESS_LIMIT) {
    throw new Error("외부 출처 DNS 주소를 확인할 수 없습니다.");
  }
  for (const address of addresses) {
    const ipv4 = parseIpv4(address);
    const ipv6 = ipv4 === null ? parseIpv6(address) : null;
    if ((ipv4 !== null && !isPublicIpv4(ipv4)) || (ipv6 !== null && !isPublicIpv6(ipv6)) || (ipv4 === null && ipv6 === null)) {
      throw new Error("사설 또는 예약된 네트워크 주소는 사용할 수 없습니다.");
    }
  }
}

function mediaType(headers: Headers): string {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function cancelBody(response: Response, reason: string): void {
  if (response.body === null) return;
  void response.body.cancel(reason).catch(() => undefined);
}

async function readBoundedBody(response: Response, guard: DeadlineGuard): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > EXTERNAL_FETCH_LIMITS.bytes) {
      cancelBody(response, "External evidence response exceeds the byte limit.");
      throw new Error("외부 문서 크기 제한을 초과했습니다.");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      guard.remaining();
      const next = await guard.wait(reader.read());
      if (next.done) {
        complete = true;
        break;
      }
      total += next.value.byteLength;
      if (total > EXTERNAL_FETCH_LIMITS.bytes) throw new Error("외부 문서 크기 제한을 초과했습니다.");
      chunks.push(next.value);
    }
  } finally {
    if (!complete) {
      void reader.cancel("External evidence body read was rejected.").catch(() => undefined);
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeFileName(url: URL, expectedType: "web_page" | "pdf"): string {
  const encodedLeaf = url.pathname.split("/").filter(Boolean).at(-1) ?? "document";
  let leaf: string;
  try { leaf = decodeURIComponent(encodedLeaf); } catch { leaf = encodedLeaf; }
  leaf = [...leaf.normalize("NFKC")].map((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f || character === "/" || character === "\\" ? "_" : character;
  }).join("")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "").slice(0, 100) || "document";
  const stem = leaf.replace(/\.[a-z0-9]{1,10}$/i, "") || "document";
  return expectedType === "pdf" ? `${stem}.pdf` : `${stem}.txt`;
}

function normalizeQuote(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

export function quoteAppearsInPages(quote: string, pages: ExtractedPage[]): boolean {
  const normalizedQuote = normalizeQuote(quote);
  if (normalizedQuote === "") return false;
  return normalizeQuote(pages.map((page) => page.text).join(" ")).includes(normalizedQuote);
}

function resolveRedirect(current: URL, location: string | null): URL {
  if (location === null || location.trim() === "") throw new Error("외부 문서 리다이렉트 위치가 올바르지 않습니다.");
  let redirected: URL;
  try { redirected = new URL(location, current); } catch { throw new Error("외부 문서 리다이렉트 위치가 올바르지 않습니다."); }
  return new URL(normalizeExternalUrl(redirected.toString()));
}

/** Fetches and validates one selected external HTML/PDF candidate under shared limits. */
export async function fetchExternalEvidence(
  input: { url: string; expectedType: "web_page" | "pdf"; quote: string },
  dependencies: ExternalEvidenceFetchDependencies,
): Promise<FetchedExternalEvidence> {
  let current = new URL(normalizeExternalUrl(input.url));
  const guard = new DeadlineGuard(dependencies.now, EXTERNAL_FETCH_LIMITS.timeoutMs);
  try {
    for (let hop = 0; hop <= EXTERNAL_FETCH_LIMITS.redirects; hop += 1) {
      dependencies.policy.assertAllowed(current);
      assertSafeHostname(current.hostname);
      guard.remaining();
      const addresses = await guard.wait(dependencies.resolveHost(current.hostname, guard.signal));
      assertOnlyPublicAddresses(addresses);
      guard.remaining();
      const response = await guard.wait(dependencies.fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: guard.signal,
        headers: { accept: input.expectedType === "pdf" ? "application/pdf" : "text/html,application/xhtml+xml" },
      }));
      if (REDIRECT_STATUSES.has(response.status)) {
        cancelBody(response, "External evidence redirect body is not retained.");
        if (hop === EXTERNAL_FETCH_LIMITS.redirects) throw new Error("외부 문서 리다이렉트가 너무 많습니다.");
        current = resolveRedirect(current, response.headers.get("location"));
        continue;
      }
      if (!response.ok) {
        cancelBody(response, "External evidence response status was rejected.");
        throw new Error("외부 문서를 가져오지 못했습니다.");
      }

      const responseMediaType = mediaType(response.headers);
      const expectedMediaTypes = input.expectedType === "pdf"
        ? new Set(["application/pdf"])
        : new Set(["text/html", "application/xhtml+xml"]);
      if (!expectedMediaTypes.has(responseMediaType)) {
        cancelBody(response, "External evidence media type was rejected.");
        throw new Error("외부 문서 MIME 또는 파일 형식이 올바르지 않습니다.");
      }
      const downloaded = await readBoundedBody(response, guard);
      const fileName = safeFileName(current, input.expectedType);
      let result: Omit<FetchedExternalEvidence, "finalUrl" | "fileName" | "retrievedAt">;

      if (input.expectedType === "pdf") {
        guard.remaining();
        const validated = await guard.wait(validateEvidenceFile({
          name: fileName,
          type: "application/pdf",
          bytes: downloaded,
        }, {
          maxExtractionMs: guard.remaining(),
          now: dependencies.now,
          abortSignal: guard.signal,
        }));
        result = {
          mediaType: "application/pdf",
          bytes: validated.bytes,
          extractedPages: validated.preflightExtractedPages ?? [],
          contentHash: validated.sha256,
        };
      } else {
        let html: string;
        try {
          if (downloaded.some((byte) => byte === 0) || downloaded.slice(0, 5).every((byte, index) => byte === [0x25, 0x50, 0x44, 0x46, 0x2d][index])) {
            throw new Error();
          }
          html = new TextDecoder("utf-8", { fatal: true }).decode(downloaded);
        } catch {
          throw new Error("외부 문서 MIME 또는 파일 형식이 올바르지 않습니다.");
        }
        const extracted = extractHtmlTextSections(html, {
          maxPages: 64,
          maxOutputBytes: EXTERNAL_FETCH_LIMITS.extractedTextBytes,
        });
        const snapshot = new TextEncoder().encode(extracted.text);
        guard.remaining();
        const validated = await guard.wait(validateEvidenceFile({ name: fileName, type: "text/plain", bytes: snapshot }));
        result = {
          mediaType: "text/plain",
          bytes: snapshot,
          extractedPages: extracted.pages,
          contentHash: validated.sha256,
        };
      }
      if (!quoteAppearsInPages(input.quote, result.extractedPages)) {
        throw new Error("선택한 인용을 외부 문서에서 확인할 수 없습니다.");
      }
      guard.remaining();
      return {
        finalUrl: normalizeExternalUrl(current.toString()),
        fileName,
        retrievedAt: dependencies.now(),
        ...result,
      };
    }
    throw new Error("외부 문서를 가져오지 못했습니다.");
  } finally {
    guard.dispose();
  }
}

type DnsJsonAnswer = { type?: unknown; data?: unknown };
type DnsJsonResponse = { Status?: unknown; Answer?: unknown };

async function readDnsJson(response: Response, budget: { remaining: number }, interruption: Promise<never>): Promise<DnsJsonResponse> {
  if (!response.ok || mediaType(response.headers) !== "application/dns-json" || response.body === null) {
    cancelBody(response, "DNS response was rejected.");
    throw new Error("외부 출처 DNS 응답이 올바르지 않습니다.");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > budget.remaining)) {
    cancelBody(response, "DNS response exceeds the byte limit.");
    throw new Error("외부 출처 DNS 응답 크기 제한을 초과했습니다.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interruption]);
      if (next.done) { complete = true; break; }
      total += next.value.byteLength;
      budget.remaining -= next.value.byteLength;
      if (budget.remaining < 0) throw new Error("외부 출처 DNS 응답 크기 제한을 초과했습니다.");
      chunks.push(next.value);
    }
  } finally {
    if (!complete) {
      void reader.cancel("DNS response read was rejected.").catch(() => undefined);
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as DnsJsonResponse; }
  catch { throw new Error("외부 출처 DNS 응답이 올바르지 않습니다."); }
}

/** Production DNS resolver: fixed Cloudflare DoH endpoint, shared 2s/32KiB/16-address bounds. */
export async function resolveHostWithCloudflareDns(
  host: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string[]> {
  const controller = new AbortController();
  let rejectInterruption!: (reason: Error) => void;
  const interruption = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
  void interruption.catch(() => undefined);
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
    rejectInterruption(new Error("외부 출처 DNS 조회 시간이 초과되었습니다."));
  };
  const onAbort = () => interrupt();
  if (signal.aborted) interrupt();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(interrupt, DNS_TIMEOUT_MS);
  const budget = { remaining: DNS_RESPONSE_BYTES };
  try {
    const resolveType = async (type: "A" | "AAAA") => {
      const url = new URL(DNS_ENDPOINT);
      url.searchParams.set("name", host);
      url.searchParams.set("type", type);
      const response = await Promise.race([fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/dns-json" },
      }), interruption]);
      return readDnsJson(response, budget, interruption);
    };
    const responses = await Promise.all([resolveType("A"), resolveType("AAAA")]);
    const addresses: string[] = [];
    for (const response of responses) {
      if (response.Status !== 0 || (response.Answer !== undefined && !Array.isArray(response.Answer))) {
        throw new Error("외부 출처 DNS 응답이 올바르지 않습니다.");
      }
      for (const answer of (response.Answer ?? []) as DnsJsonAnswer[]) {
        if (typeof answer === "object" && answer !== null && (answer.type === 1 || answer.type === 28) && typeof answer.data === "string" && !addresses.includes(answer.data)) {
          addresses.push(answer.data);
          if (addresses.length > DNS_ADDRESS_LIMIT) throw new Error("외부 출처 DNS 주소 제한을 초과했습니다.");
        }
      }
    }
    if (addresses.length === 0) throw new Error("외부 출처 DNS 주소를 확인할 수 없습니다.");
    return addresses;
  } catch (error) {
    controller.abort();
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error("외부 출처 DNS 조회 시간이 초과되었습니다.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}
