import type { ActionProvenance, CardAction, Confidence, SpatialPoint, TacticalIntent, TacticCardContent } from "../domain/evidence.ts";

export type EvidenceChunkOrigin = "uploaded" | "external_web" | "video_observation";

type ExternalEvidenceChunkMetadata = {
  canonicalUrl: string;
  publisher: string;
  publishedAt: string;
  retrievedAt: number;
};

type EvidenceChunkBase = {
  id: string;
  locationLabel: string;
  content: string;
};

export type EvidenceChunkInput = EvidenceChunkBase & ({
  origin: "external_web";
} & ExternalEvidenceChunkMetadata | {
  origin: "uploaded" | "video_observation";
  canonicalUrl?: never;
  publisher?: never;
  publishedAt?: never;
  retrievedAt?: never;
});

export type ExtractedEvidence = {
  citationIds: string[];
  situation: string;
  conditions: string[];
  defenseType?: TacticCardContent["defenseType"];
  ballOwnerId?: string | null;
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

const ACTIONS = new Set<CardAction["action"]>(["pass", "dribble", "move", "hold", "shoot"]);
const TACTICAL_INTENTS = new Set<TacticalIntent>(["support", "cover", "press", "delay", "block_lane", "hold_shape", "intercept", "create_width", "progress", "retain_possession", "transition_attack"]);
const PROVENANCES = new Set<ActionProvenance>(["coach_statement", "observation", "inferred", "simulation_assumption"]);
const DEFENSE_TYPES = new Set<TacticCardContent["defenseType"]>([
  "front_press", "central_block", "wide_funnel", "one_v_one", "numerical_advantage", "numerical_disadvantage",
  "zonal", "man_to_man", "double_team", "cover_shadow", "transition_defense", "wide_trap",
  "numerical_superiority", "numerical_inferiority", "unknown",
]);
const CONFIDENCES = new Set<TacticCardContent["confidence"]>(["high", "medium", "low"]);
const CHUNK_ORIGINS = new Set<EvidenceChunkOrigin>(["uploaded", "external_web", "video_observation"]);
const MAX_EXTERNAL_CANONICAL_URL_BYTES = 4 * 1024;
const MAX_EXTERNAL_PUBLISHER_LENGTH = 160;

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

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : nonEmptyString(value, field);
}

function validPublishedAt(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function externalChunkMetadata(chunk: Record<string, unknown>, field: string): ExternalEvidenceChunkMetadata {
  const canonicalUrl = nonEmptyString(chunk.canonicalUrl, `${field}.canonicalUrl`);
  const publisher = nonEmptyString(chunk.publisher, `${field}.publisher`);
  const publishedAt = nonEmptyString(chunk.publishedAt, `${field}.publishedAt`);
  const retrievedAt = chunk.retrievedAt;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(canonicalUrl);
  } catch {
    fail(`${field}.canonicalUrl이 올바르지 않습니다.`);
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password
    || new TextEncoder().encode(canonicalUrl).byteLength > MAX_EXTERNAL_CANONICAL_URL_BYTES) {
    fail(`${field}.canonicalUrl이 올바르지 않습니다.`);
  }
  if (publisher.length > MAX_EXTERNAL_PUBLISHER_LENGTH || !validPublishedAt(publishedAt)
    || typeof retrievedAt !== "number" || !Number.isSafeInteger(retrievedAt) || retrievedAt < 0) {
    fail(`${field} 외부 출처 메타데이터가 올바르지 않습니다.`);
  }
  return { canonicalUrl, publisher, publishedAt, retrievedAt };
}

function pathValue(value: unknown, field: string): SpatialPoint[] {
  if (!Array.isArray(value)) fail(`${field} 배열이 필요합니다.`);
  return value.map((item, index) => {
    if (!isRecord(item)) fail(`${field}[${index}] 좌표가 필요합니다.`);
    exactKeys(item, ["x", "y"], `${field}[${index}]`);
    const x = item.x;
    const y = item.y;
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 100) fail(`${field}[${index}].x가 올바르지 않습니다.`);
    if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 136) fail(`${field}[${index}].y가 올바르지 않습니다.`);
    return { x, y };
  });
}

function citationIds(value: unknown, field: string, allowed: Set<string>): string[] {
  const ids = stringArray(value, field);
  if (ids.length === 0) fail(`${field}에는 하나 이상의 근거가 필요합니다.`);
  if (ids.some((id) => !allowed.has(id))) fail(`${field}에 허용되지 않은 근거가 있습니다.`);
  return ids;
}

function parseAction(value: unknown, field: string, allowed: Set<string>): CardAction {
  if (!isRecord(value)) fail(`${field}가 필요합니다.`);
  const enriched = ["tacticalIntent", "actorId", "targetId", "trigger", "path", "provenance", "confidence"].some((key) => key in value);
  exactKeys(value, enriched
    ? ["action", "tacticalIntent", "actorId", "targetId", "trigger", "path", "provenance", "confidence", "reason", "citationIds"]
    : ["action", "reason", "citationIds"], field);
  if (!ACTIONS.has(value.action as CardAction["action"])) fail(`${field}.action 행동이 올바르지 않습니다.`);
  if (!enriched) return {
    action: value.action as CardAction["action"],
    reason: nonEmptyString(value.reason, `${field}.reason`),
    citationIds: citationIds(value.citationIds, `${field}.citationIds`, allowed),
  };
  if (!TACTICAL_INTENTS.has(value.tacticalIntent as TacticalIntent)) fail(`${field}.tacticalIntent 전술 의도가 올바르지 않습니다.`);
  if (!PROVENANCES.has(value.provenance as ActionProvenance)) fail(`${field}.provenance 근거 수준이 올바르지 않습니다.`);
  if (!CONFIDENCES.has(value.confidence as Confidence)) fail(`${field}.confidence 확신도가 올바르지 않습니다.`);
  return {
    action: value.action as CardAction["action"],
    tacticalIntent: value.tacticalIntent as TacticalIntent,
    actorId: nullableString(value.actorId, `${field}.actorId`),
    targetId: nullableString(value.targetId, `${field}.targetId`),
    trigger: nullableString(value.trigger, `${field}.trigger`),
    path: pathValue(value.path, `${field}.path`),
    provenance: value.provenance as ActionProvenance,
    confidence: value.confidence as Confidence,
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
  return chunks.map((chunk, index): EvidenceChunkInput => {
    const field = `chunks[${index}]`;
    if (!isRecord(chunk)) fail(`${field}가 필요합니다.`);
    if (!CHUNK_ORIGINS.has(chunk.origin as EvidenceChunkOrigin)) fail(`${field}.origin이 올바르지 않습니다.`);
    const origin = chunk.origin as EvidenceChunkOrigin;
    exactKeys(chunk, ["id", "locationLabel", "content", "origin", ...(origin === "external_web"
      ? ["canonicalUrl", "publisher", "publishedAt", "retrievedAt"]
      : [])], field);
    const base = {
      id: nonEmptyString(chunk.id, `${field}.id`),
      locationLabel: nonEmptyString(chunk.locationLabel, `${field}.locationLabel`),
      content: nonEmptyString(chunk.content, `${field}.content`),
    };
    if (origin === "external_web") {
      return { ...base, origin, ...externalChunkMetadata(chunk, field) };
    }
    return { ...base, origin };
  });
}

/** Applies source-origin rules after strict model-output parsing and before persistence. */
export function enforceExternalEvidenceRules(
  card: TacticCardContent,
  originsByChunkId: ReadonlyMap<string, EvidenceChunkOrigin>,
): TacticCardContent {
  const cited = [...card.preferred, ...card.alternatives, ...card.risky]
    .flatMap((action) => action.citationIds);
  const externalOnly = cited.length > 0
    && cited.every((id) => originsByChunkId.get(id) === "external_web");
  return {
    ...card,
    confidence: externalOnly && card.confidence === "high" ? "medium" : card.confidence,
    scenarioSuitable: card.conflicts.length > 0 ? false : card.scenarioSuitable,
    animationSuitable: card.conflicts.length > 0 ? false : card.animationSuitable,
  };
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
    const enriched = "ballOwnerId" in candidate;
    exactKeys(candidate, [
      "situation", "conditions", "defenseType", "cues", "preferred", "alternatives", "risky", "confidence",
      "uncertainties", "conflicts", "scenarioSuitable", "animationSuitable",
      ...(enriched ? ["ballOwnerId"] : []),
    ], field);
    if (!DEFENSE_TYPES.has(candidate.defenseType as TacticCardContent["defenseType"])) fail(`${field}.defenseType 수비 유형이 올바르지 않습니다.`);
    if (!CONFIDENCES.has(candidate.confidence as TacticCardContent["confidence"])) fail(`${field}.confidence 확신도가 올바르지 않습니다.`);
    const preferred = parseActions(candidate.preferred, `${field}.preferred`, allowed);
    const alternatives = parseActions(candidate.alternatives, `${field}.alternatives`, allowed);
    const risky = parseActions(candidate.risky, `${field}.risky`, allowed);
    if (preferred.length + alternatives.length + risky.length === 0) {
      fail(`${field}에는 하나 이상의 행동이 필요합니다.`);
    }
    const ballOwnerId = enriched ? nullableString(candidate.ballOwnerId, `${field}.ballOwnerId`) : undefined;
    const actions = [...preferred, ...alternatives, ...risky];
    const defensiveIntents = new Set<TacticalIntent>(["cover", "press", "delay", "block_lane", "hold_shape", "intercept"]);
    for (const action of actions) {
      if (action.tacticalIntent && defensiveIntents.has(action.tacticalIntent) && !["move", "hold"].includes(action.action)) {
        fail(`${field}의 수비 전술 의도는 드리블·패스·슛으로 표현할 수 없습니다.`);
      }
      if (enriched && action.action === "dribble" && typeof ballOwnerId === "string" && action.actorId !== ballOwnerId) {
        fail(`${field}의 드리블 선수는 공 소유자여야 합니다.`);
      }
      if (enriched && action.action === "pass" && ((typeof ballOwnerId === "string" && action.actorId !== ballOwnerId) || (action.targetId !== null && action.targetId === action.actorId))) {
        fail(`${field}의 패스는 공 소유자가 다른 선수에게 해야 합니다.`);
      }
      if (action.provenance === "simulation_assumption" && action.confidence === "high") action.confidence = "medium";
    }
    const conflicts = stringArray(candidate.conflicts, `${field}.conflicts`);
    const hasAnimationData = enriched && ballOwnerId !== null && actions.every((action) =>
      Boolean(action.actorId)
      && ((action.action === "move" || action.action === "dribble") ? (action.path?.length ?? 0) >= 2 : true)
      && (action.action === "pass" ? Boolean(action.targetId) : true));
    return {
      situation: nonEmptyString(candidate.situation, `${field}.situation`),
      conditions: stringArray(candidate.conditions, `${field}.conditions`),
      defenseType: candidate.defenseType as TacticCardContent["defenseType"],
      ...(enriched ? { ballOwnerId } : {}),
      cues: stringArray(candidate.cues, `${field}.cues`),
      preferred,
      alternatives,
      risky,
      confidence: candidate.confidence as TacticCardContent["confidence"],
      uncertainties: stringArray(candidate.uncertainties, `${field}.uncertainties`),
      conflicts,
      scenarioSuitable: booleanValue(candidate.scenarioSuitable, `${field}.scenarioSuitable`) && conflicts.length === 0,
      animationSuitable: booleanValue(candidate.animationSuitable, `${field}.animationSuitable`) && conflicts.length === 0 && (!enriched || hasAnimationData),
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
    const enriched = "defenseType" in candidate || "ballOwnerId" in candidate;
    exactKeys(candidate, ["citationIds", "situation", "conditions", ...(enriched ? ["defenseType", "ballOwnerId"] : []), "cues", "actions", "outcomes", "exceptions"], field);
    if (enriched && !DEFENSE_TYPES.has(candidate.defenseType as TacticCardContent["defenseType"])) fail(`${field}.defenseType 수비 유형이 올바르지 않습니다.`);
    return {
      citationIds: citationIds(candidate.citationIds, `${field}.citationIds`, allowed),
      situation: nonEmptyString(candidate.situation, `${field}.situation`),
      conditions: stringArray(candidate.conditions, `${field}.conditions`),
      ...(enriched ? {
        defenseType: candidate.defenseType as TacticCardContent["defenseType"],
        ballOwnerId: nullableString(candidate.ballOwnerId, `${field}.ballOwnerId`),
      } : {}),
      cues: stringArray(candidate.cues, `${field}.cues`),
      actions: parseActions(candidate.actions, `${field}.actions`, allowed),
      outcomes: stringArray(candidate.outcomes, `${field}.outcomes`),
      exceptions: stringArray(candidate.exceptions, `${field}.exceptions`),
    };
  });
}
