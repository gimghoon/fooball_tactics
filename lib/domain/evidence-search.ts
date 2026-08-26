export type SearchRunStatus = "queued" | "searching" | "ready" | "importing" | "completed" | "failed";
export type SearchCandidateStatus = "candidate" | "selected" | "excluded" | "importing" | "imported" | "failed";
export type EvidenceSourceOrigin = "uploaded" | "external_web";

export type SearchCandidateDraft = {
  url: string;
  canonicalUrl: string;
  title: string;
  publisher: string;
  publishedAt: string;
  documentType: "web_page" | "pdf";
  quote: string;
  relevance: string;
  proposedTrustTier: 1 | 2 | 3;
};

export type SearchSelectionInput = {
  expectedBundleVersion: number;
  selectedIds: string[];
  excludedIds: string[];
};

export class EvidenceSearchValidationError extends Error {}

function fail(message: string): never {
  throw new EvidenceSearchValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string") fail(`${field}이 필요합니다.`);
  const text = value.trim();
  if (text === "") fail(`${field}이 필요합니다.`);
  if (maxLength !== undefined && text.length > maxLength) fail(`${field}은(는) ${maxLength}자 이하여야 합니다.`);
  return text;
}

function dateOnly(value: unknown): string {
  const date = trimmedString(value, "게시일");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) fail("게시일은 YYYY-MM-DD 형식이어야 합니다.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail("게시일이 올바르지 않습니다.");
  }
  return date;
}

function idArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} 배열이 필요합니다.`);
  const ids = value.map((item, index) => trimmedString(item, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) fail(`${field}에는 중복 ID를 넣을 수 없습니다.`);
  return ids;
}

/** Converts an external URL to the single canonical HTTPS representation used for deduplication. */
export function normalizeExternalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    fail("URL이 올바르지 않습니다.");
  }
  if (url.protocol !== "https:") fail("외부 URL은 HTTPS여야 합니다.");
  if (url.username !== "" || url.password !== "") fail("URL에 자격 증명을 포함할 수 없습니다.");
  if (url.hostname === "") fail("URL이 올바르지 않습니다.");

  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") url.port = "";
  url.hash = "";

  const parameters = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  url.search = "";
  for (const [key, parameterValue] of parameters) url.searchParams.append(key, parameterValue);
  return url.toString();
}

/** Validates search-model metadata before a candidate is persisted. */
export function parseSearchCandidateDraft(value: unknown): SearchCandidateDraft {
  if (!isRecord(value)) fail("검색 후보 입력이 필요합니다.");
  const url = normalizeExternalUrl(trimmedString(value.url, "url"));
  const canonicalUrl = normalizeExternalUrl(trimmedString(value.canonicalUrl, "canonicalUrl"));
  if (canonicalUrl !== url) fail("canonicalUrl은 url의 정규화 값과 같아야 합니다.");
  const documentType = value.documentType;
  if (documentType !== "web_page" && documentType !== "pdf") fail("documentType이 올바르지 않습니다.");
  const proposedTrustTier = value.proposedTrustTier;
  if (proposedTrustTier !== 1 && proposedTrustTier !== 2 && proposedTrustTier !== 3) fail("proposedTrustTier가 올바르지 않습니다.");
  return {
    url,
    canonicalUrl,
    title: trimmedString(value.title, "제목", 200),
    publisher: trimmedString(value.publisher, "게시 기관", 160),
    publishedAt: dateOnly(value.publishedAt),
    documentType,
    quote: trimmedString(value.quote, "인용", 1000),
    relevance: trimmedString(value.relevance, "관련성", 600),
    proposedTrustTier,
  };
}

/** Validates an operator's candidate selection against the server-enforced selection boundary. */
export function parseSearchSelection(value: unknown): SearchSelectionInput {
  if (!isRecord(value)) fail("검색 후보 선택 입력이 필요합니다.");
  const expectedBundleVersion = value.expectedBundleVersion;
  if (typeof expectedBundleVersion !== "number" || !Number.isSafeInteger(expectedBundleVersion) || expectedBundleVersion < 1) {
    fail("expectedBundleVersion은 1 이상의 정수여야 합니다.");
  }
  const selectedIds = idArray(value.selectedIds, "selectedIds");
  const excludedIds = idArray(value.excludedIds, "excludedIds");
  if (selectedIds.length > 5) fail("선택한 후보는 최대 5개여야 합니다.");
  if (selectedIds.some((id) => excludedIds.includes(id))) fail("같은 후보를 선택과 제외에 동시에 넣을 수 없습니다.");
  return { expectedBundleVersion, selectedIds, excludedIds };
}
