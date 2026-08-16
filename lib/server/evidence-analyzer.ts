import type { CardAction, TacticCardContent } from "../domain/evidence.ts";

export type EvidenceChunkInput = {
  id: string;
  locationLabel: string;
  content: string;
};

export type ExtractedEvidence = {
  citationIds: string[];
  situation: string;
  conditions: string[];
  cues: string[];
  actions: CardAction[];
  outcomes: string[];
  exceptions: string[];
};

export interface EvidenceAnalyzer {
  readonly modelId: string;
  analyzeExtraction(
    input: { chunks: EvidenceChunkInput[]; promptVersion: string },
    signal: AbortSignal,
  ): Promise<ExtractedEvidence[]>;
  generateCards(
    input: { extracted: ExtractedEvidence[]; allowedCitationIds: string[]; promptVersion: string; schemaVersion: string },
    signal: AbortSignal,
  ): Promise<TacticCardContent[]>;
}

/** A safe, user-visible analyzer failure: it never carries provider bodies or credentials. */
export class EvidenceAnalyzerError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "EvidenceAnalyzerError";
  }
}

const ACTIONS = new Set<CardAction["action"]>(["pass", "dribble", "move"]);
const DEFENSE_TYPES = new Set<TacticCardContent["defenseType"]>([
  "front_press", "central_block", "wide_funnel", "one_v_one", "numerical_advantage", "numerical_disadvantage",
]);
const CONFIDENCES = new Set<TacticCardContent["confidence"]>(["high", "medium", "low"]);

function fail(message: string): never {
  throw new EvidenceAnalyzerError(message, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const unexpected = Object.keys(value).find((key) => !expected.includes(key));
  if (unexpected) fail(`${field}에 알 수 없는 필드가 있습니다.`);
  const missing = expected.find((key) => !(key in value));
  if (missing) fail(`${field}.${missing}이 필요합니다.`);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field}이 필요합니다.`);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} 배열이 필요합니다.`);
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field}는 불리언이어야 합니다.`);
  return value;
}

function citationIds(value: unknown, field: string, allowed: Set<string>): string[] {
  const ids = stringArray(value, field);
  if (ids.length === 0) fail(`${field}에는 하나 이상의 근거가 필요합니다.`);
  if (ids.some((id) => !allowed.has(id))) fail(`${field}에 허용되지 않은 근거가 있습니다.`);
  return ids;
}

function parseAction(value: unknown, field: string, allowed: Set<string>): CardAction {
  if (!isRecord(value)) fail(`${field}가 필요합니다.`);
  exactKeys(value, ["action", "reason", "citationIds"], field);
  if (!ACTIONS.has(value.action as CardAction["action"])) fail(`${field}.action 행동이 올바르지 않습니다.`);
  return {
    action: value.action as CardAction["action"],
    reason: nonEmptyString(value.reason, `${field}.reason`),
    citationIds: citationIds(value.citationIds, `${field}.citationIds`, allowed),
  };
}

function parseActions(value: unknown, field: string, allowed: Set<string>): CardAction[] {
  if (!Array.isArray(value)) fail(`${field} 배열이 필요합니다.`);
  return value.map((item, index) => parseAction(item, `${field}[${index}]`, allowed));
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail(`${field} JSON을 해석할 수 없습니다.`);
  }
}

function knownCitationIds(known: readonly EvidenceChunkInput[] | readonly string[] | Set<string>): Set<string> {
  if (known instanceof Set) return new Set(known);
  return new Set(known.map((item) => typeof item === "string" ? item : item.id));
}

/** Validates first-stage input before evidence is sent to the provider. */
export function parseEvidenceChunks(chunks: readonly EvidenceChunkInput[]): EvidenceChunkInput[] {
  if (chunks.length === 0) fail("분석할 근거 청크가 필요합니다.");
  return chunks.map((chunk, index) => {
    const field = `chunks[${index}]`;
    if (!isRecord(chunk)) fail(`${field}가 필요합니다.`);
    exactKeys(chunk, ["id", "locationLabel", "content"], field);
    return {
      id: nonEmptyString(chunk.id, `${field}.id`),
      locationLabel: nonEmptyString(chunk.locationLabel, `${field}.locationLabel`),
      content: nonEmptyString(chunk.content, `${field}.content`),
    };
  });
}

/** Returns only citation IDs represented by the validated first-stage evidence. */
export function extractedCitationIds(extracted: readonly ExtractedEvidence[]): Set<string> {
  return new Set(extracted.flatMap((item) => [
    ...item.citationIds,
    ...item.actions.flatMap((action) => action.citationIds),
  ]));
}

function cardArray(value: unknown): unknown[] {
  const parsed = parseJson(value, "카드");
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) fail("카드 배열이 필요합니다.");
  exactKeys(parsed, ["cards"], "카드 결과");
  if (!Array.isArray(parsed.cards)) fail("카드 결과.cards 배열이 필요합니다.");
  return parsed.cards;
}

/** Validates provider output at the trust boundary before any card can be persisted. */
export function parseAnalyzerCards(
  value: unknown,
  known: readonly EvidenceChunkInput[] | readonly string[] | Set<string>,
  extractedCitations?: ReadonlySet<string>,
): TacticCardContent[] {
  const callerAllowed = knownCitationIds(known);
  const allowed = extractedCitations === undefined
    ? callerAllowed
    : new Set([...callerAllowed].filter((id) => extractedCitations.has(id)));
  const cards = cardArray(value).map((candidate, index) => {
    const field = `cards[${index}]`;
    if (!isRecord(candidate)) fail(`${field}가 필요합니다.`);
    exactKeys(candidate, [
      "situation", "conditions", "defenseType", "cues", "preferred", "alternatives", "risky", "confidence",
      "uncertainties", "conflicts", "scenarioSuitable", "animationSuitable",
    ], field);
    if (!DEFENSE_TYPES.has(candidate.defenseType as TacticCardContent["defenseType"])) fail(`${field}.defenseType 수비 유형이 올바르지 않습니다.`);
    if (!CONFIDENCES.has(candidate.confidence as TacticCardContent["confidence"])) fail(`${field}.confidence 확신도가 올바르지 않습니다.`);
    const preferred = parseActions(candidate.preferred, `${field}.preferred`, allowed);
    const alternatives = parseActions(candidate.alternatives, `${field}.alternatives`, allowed);
    const risky = parseActions(candidate.risky, `${field}.risky`, allowed);
    if (preferred.length + alternatives.length + risky.length === 0) {
      fail(`${field}에는 하나 이상의 행동이 필요합니다.`);
    }
    return {
      situation: nonEmptyString(candidate.situation, `${field}.situation`),
      conditions: stringArray(candidate.conditions, `${field}.conditions`),
      defenseType: candidate.defenseType as TacticCardContent["defenseType"],
      cues: stringArray(candidate.cues, `${field}.cues`),
      preferred,
      alternatives,
      risky,
      confidence: candidate.confidence as TacticCardContent["confidence"],
      uncertainties: stringArray(candidate.uncertainties, `${field}.uncertainties`),
      conflicts: stringArray(candidate.conflicts, `${field}.conflicts`),
      scenarioSuitable: booleanValue(candidate.scenarioSuitable, `${field}.scenarioSuitable`),
      animationSuitable: booleanValue(candidate.animationSuitable, `${field}.animationSuitable`),
    };
  });
  if (cards.length === 0) fail("카드 결과에는 하나 이상의 행동이 필요합니다.");
  return cards;
}

/** Parses the first-stage evidence extraction without allowing provider-specific fields through. */
export function parseExtractedEvidence(
  value: unknown,
  known: readonly EvidenceChunkInput[] | readonly string[] | Set<string>,
): ExtractedEvidence[] {
  const parsed = parseJson(value, "추출 결과");
  const records = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && (exactKeys(parsed, ["extracted"], "추출 결과"), Array.isArray(parsed.extracted))
      ? parsed.extracted
      : fail("추출 결과 배열이 필요합니다.");
  const allowed = knownCitationIds(known);
  if (records.length === 0) fail("추출 결과에는 하나 이상의 근거가 필요합니다.");
  return records.map((candidate, index) => {
    const field = `extracted[${index}]`;
    if (!isRecord(candidate)) fail(`${field}가 필요합니다.`);
    exactKeys(candidate, ["citationIds", "situation", "conditions", "cues", "actions", "outcomes", "exceptions"], field);
    return {
      citationIds: citationIds(candidate.citationIds, `${field}.citationIds`, allowed),
      situation: nonEmptyString(candidate.situation, `${field}.situation`),
      conditions: stringArray(candidate.conditions, `${field}.conditions`),
      cues: stringArray(candidate.cues, `${field}.cues`),
      actions: parseActions(candidate.actions, `${field}.actions`, allowed),
      outcomes: stringArray(candidate.outcomes, `${field}.outcomes`),
      exceptions: stringArray(candidate.exceptions, `${field}.exceptions`),
    };
  });
}
