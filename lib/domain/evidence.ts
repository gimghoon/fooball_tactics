import type { DefenseType } from "./content.ts";

export type CardReviewStatus = "analysis_draft" | "owner_reviewed" | "coach_reviewed" | "held" | "rejected";
export type AnalysisJobStatus = "queued" | "running" | "review_ready" | "completed" | "failed";
export type Confidence = "high" | "medium" | "low";
export type CardAction = { action: "pass" | "dribble" | "move"; reason: string; citationIds: string[] };
export type TacticCardContent = {
  situation: string;
  conditions: string[];
  defenseType: DefenseType;
  cues: string[];
  preferred: CardAction[];
  alternatives: CardAction[];
  risky: CardAction[];
  confidence: Confidence;
  uncertainties: string[];
  conflicts: string[];
  scenarioSuitable: boolean;
  animationSuitable: boolean;
};

export type EvidenceBundleInput = {
  title: string;
  purpose: string;
};

export type VideoClipInput = {
  url: string;
  startMs: number;
  endMs: number;
  observation: string;
};

export type EvidenceVersionInput = {
  sourceHashes: string[];
  clips: VideoClipInput[];
  analyzerModel: string;
  promptVersion: string;
  schemaVersion: string;
};

const ACTIONS: readonly CardAction["action"][] = ["pass", "dribble", "move"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];
const DEFENSE_TYPES: readonly DefenseType[] = [
  "front_press",
  "central_block",
  "wide_funnel",
  "one_v_one",
  "numerical_advantage",
  "numerical_disadvantage",
];

export class EvidenceValidationError extends Error {}

function fail(message: string): never {
  throw new EvidenceValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field}는 유한한 숫자여야 합니다.`);
  return value;
}

function parseCardAction(value: unknown, field: string): CardAction {
  if (!isRecord(value)) fail(`${field}가 필요합니다.`);
  if (!ACTIONS.includes(value.action as CardAction["action"])) fail(`${field}.action이 올바르지 않습니다.`);
  return {
    action: value.action as CardAction["action"],
    reason: nonEmptyString(value.reason, `${field}.reason`),
    citationIds: stringArray(value.citationIds, `${field}.citationIds`),
  };
}

function parseCardActions(value: unknown, field: string): CardAction[] {
  if (!Array.isArray(value)) fail(`${field} 배열이 필요합니다.`);
  return value.map((item, index) => parseCardAction(item, `${field}[${index}]`));
}

/** Parses the administrator-provided metadata for a new evidence bundle. */
export function parseBundleInput(input: unknown): EvidenceBundleInput {
  if (!isRecord(input)) fail("근거 묶음 입력이 필요합니다.");
  return {
    title: nonEmptyString(input.title, "title"),
    purpose: nonEmptyString(input.purpose, "purpose"),
  };
}

/** Parses one HTTPS video segment and its operator observation. */
export function parseVideoClip(input: unknown): VideoClipInput {
  if (!isRecord(input)) fail("영상 구간 입력이 필요합니다.");
  const url = nonEmptyString(input.url, "url");
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    fail("url이 올바르지 않습니다.");
  }
  if (protocol !== "https:") fail("영상 URL은 HTTPS여야 합니다.");

  const startMs = finiteNumber(input.startMs, "startMs");
  const endMs = finiteNumber(input.endMs, "endMs");
  if (startMs < 0 || endMs <= startMs) fail("영상 시간 범위가 올바르지 않습니다.");
  return { url, startMs, endMs, observation: nonEmptyString(input.observation, "observation") };
}

/** Parses structured LLM card output before it is stored as an analysis draft. */
export function parseTacticCardContent(input: unknown): TacticCardContent {
  if (typeof input === "string") {
    try {
      return parseTacticCardContent(JSON.parse(input));
    } catch (error) {
      if (error instanceof SyntaxError) fail("카드 JSON을 해석할 수 없습니다.");
      throw error;
    }
  }
  if (!isRecord(input)) fail("카드 콘텐츠가 필요합니다.");
  if (!DEFENSE_TYPES.includes(input.defenseType as DefenseType)) fail("수비 유형이 올바르지 않습니다.");
  if (!CONFIDENCES.includes(input.confidence as Confidence)) fail("확신도가 올바르지 않습니다.");

  return {
    situation: nonEmptyString(input.situation, "situation"),
    conditions: stringArray(input.conditions, "conditions"),
    defenseType: input.defenseType as DefenseType,
    cues: stringArray(input.cues, "cues"),
    preferred: parseCardActions(input.preferred, "preferred"),
    alternatives: parseCardActions(input.alternatives, "alternatives"),
    risky: parseCardActions(input.risky, "risky"),
    confidence: input.confidence as Confidence,
    uncertainties: stringArray(input.uncertainties, "uncertainties"),
    conflicts: stringArray(input.conflicts, "conflicts"),
    scenarioSuitable: booleanValue(input.scenarioSuitable, "scenarioSuitable"),
    animationSuitable: booleanValue(input.animationSuitable, "animationSuitable"),
  };
}

/** Blocks approval when a card has low confidence, unresolved conflict, or unsupported evidence. */
export function assertCardReviewTransition(
  status: CardReviewStatus,
  card: TacticCardContent,
  knownCitationIds: Set<string>,
): void {
  if (status !== "owner_reviewed" && status !== "coach_reviewed") return;
  if (card.confidence === "low" || card.conflicts.length > 0) {
    throw new EvidenceValidationError("낮은 확신도 또는 미해결 충돌이 있어 승인할 수 없습니다.");
  }
  const actions = [...card.preferred, ...card.alternatives, ...card.risky];
  if (actions.some((item) => !item.reason.trim() || item.citationIds.length === 0 || item.citationIds.some((id) => !knownCitationIds.has(id)))) {
    throw new EvidenceValidationError("모든 행동과 이유에는 유효한 근거가 필요합니다.");
  }
}

/** Produces a stable SHA-256 version from the evidence and analysis contract. */
export async function computeEvidenceVersion(input: EvidenceVersionInput): Promise<string> {
  const clips = input.clips.map(parseVideoClip).sort((left, right) => {
    const leftKey = `${left.url}\u0000${left.startMs}\u0000${left.endMs}\u0000${left.observation}`;
    const rightKey = `${right.url}\u0000${right.startMs}\u0000${right.endMs}\u0000${right.observation}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const canonical = JSON.stringify({
    analyzerModel: nonEmptyString(input.analyzerModel, "analyzerModel"),
    clips,
    promptVersion: nonEmptyString(input.promptVersion, "promptVersion"),
    schemaVersion: nonEmptyString(input.schemaVersion, "schemaVersion"),
    sourceHashes: input.sourceHashes.map((hash, index) => nonEmptyString(hash, `sourceHashes[${index}]`)).sort(),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
