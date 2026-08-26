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

export type SpatialPoint = { x: number; y: number };
export type SpatialEvidenceAction = {
  order?: number;
  type: "pass" | "dribble" | "move" | "hold" | "shoot" | "screen" | "press" | "cover";
  actorId: string;
  targetId?: string;
  path?: SpatialPoint[];
  durationMs?: number;
  trigger?: string;
  condition?: string;
  reason: string;
};
export type SpatialEvidence = {
  source: { title: string; url: string; startTime: string; endTime: string; coachName: string };
  coordinateSystem: { width: 100; height: 136; attackDirection: "negative_y"; normalized: true };
  scene: {
    title: string;
    decisionTime: string;
    userRole: string;
    ballOwnerId: string;
    defense: { primaryType: string; description: string };
    players: Array<{ id: string; team: "attack" | "defense"; role: string; position: SpatialPoint; hasBall: boolean; confidence: "exact" | "estimated" | "unknown" }>;
    openSpaces: Array<{ id: string; xMin: number; xMax: number; yMin: number; yMax: number }>;
    decisionCues: string[];
    preferredSequence: SpatialEvidenceAction[];
    alternatives: SpatialEvidenceAction[];
    riskyActions: SpatialEvidenceAction[];
    expectedOutcome: string;
    evidence: Array<{ timeRange: string; type: "observation" | "coach_statement"; statement: string }>;
    uncertainties: string[];
  };
};

export type EvidenceVersionInput = {
  sourceHashes: string[];
  clips: VideoClipInput[];
  purpose: string;
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

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} 객체가 필요합니다.`);
  return value;
}

function recordArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail(`${field} 배열이 필요합니다.`);
  return value.map((item, index) => recordValue(item, `${field}[${index}]`));
}

function spatialPoint(value: unknown, field: string): SpatialPoint {
  const point = recordValue(value, field);
  const x = finiteNumber(point.x, `${field}.x`);
  const y = finiteNumber(point.y, `${field}.y`);
  if (x < 0 || x > 100) fail(`${field}.x는 0~100 범위여야 합니다.`);
  if (y < 0 || y > 136) fail(`${field}.y는 0~136 범위여야 합니다.`);
  return { x, y };
}

function timecodeMs(value: unknown, field: string): number {
  const text = nonEmptyString(value, field);
  const match = /^(\d{2,}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) fail(`${field}는 HH:MM:SS 또는 HH:MM:SS.mmm 형식이어야 합니다.`);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) fail(`${field}의 분과 초는 0~59 범위여야 합니다.`);
  return ((Number(match[1]) * 60 + minutes) * 60 + seconds) * 1000 + Number((match[4] ?? "0").padEnd(3, "0"));
}

const SPATIAL_ACTIONS = ["pass", "dribble", "move", "hold", "shoot", "screen", "press", "cover"] as const;
const SPATIAL_DEFENSES = ["front_press", "central_block", "wide_trap", "man_to_man", "zonal", "double_team", "cover_shadow", "transition_defense", "numerical_superiority", "numerical_inferiority", "unknown"] as const;

function parseSpatialAction(value: Record<string, unknown>, field: string, playerIds: Set<string>, defaultActorId: string): SpatialEvidenceAction {
  const type = value.type;
  if (!SPATIAL_ACTIONS.includes(type as SpatialEvidenceAction["type"])) fail(`${field}.type이 올바르지 않습니다.`);
  const actorId = value.actorId === undefined ? defaultActorId : nonEmptyString(value.actorId, `${field}.actorId`);
  if (!playerIds.has(actorId)) fail(`${field}.actorId가 scene.players에 없습니다.`);
  const targetId = value.targetId === undefined ? undefined : nonEmptyString(value.targetId, `${field}.targetId`);
  if (targetId !== undefined && !playerIds.has(targetId)) fail(`${field}.targetId가 scene.players에 없습니다.`);
  const path = value.path === undefined ? undefined : recordArray(value.path, `${field}.path`).map((point, index) => spatialPoint(point, `${field}.path[${index}]`));
  if ((type === "dribble" || type === "move") && (!path || path.length < 2)) fail(`${field}.path에는 시작점과 도착점이 필요합니다.`);
  if (type === "pass" && targetId === undefined) fail(`${field}.targetId가 필요합니다.`);
  const durationMs = value.durationMs === undefined ? undefined : finiteNumber(value.durationMs, `${field}.durationMs`);
  if (durationMs !== undefined && durationMs <= 0) fail(`${field}.durationMs는 0보다 커야 합니다.`);
  const order = value.order === undefined ? undefined : finiteNumber(value.order, `${field}.order`);
  return {
    ...(order === undefined ? {} : { order }),
    type: type as SpatialEvidenceAction["type"], actorId,
    ...(targetId === undefined ? {} : { targetId }),
    ...(path === undefined ? {} : { path }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(value.trigger === undefined ? {} : { trigger: nonEmptyString(value.trigger, `${field}.trigger`) }),
    ...(value.condition === undefined ? {} : { condition: nonEmptyString(value.condition, `${field}.condition`) }),
    reason: nonEmptyString(value.reason, `${field}.reason`),
  };
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

/** Validates the coach-facing spatial JSON before it becomes cited evidence. */
export function parseSpatialEvidenceJson(input: unknown): SpatialEvidence {
  let value = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); }
    catch { fail("공간 근거 JSON을 해석할 수 없습니다."); }
  }
  const root = recordValue(value, "root");
  const source = recordValue(root.source, "source");
  const url = nonEmptyString(source.url, "source.url");
  try {
    if (new URL(url).protocol !== "https:") fail("source.url은 HTTPS여야 합니다.");
  } catch (error) {
    if (error instanceof EvidenceValidationError) throw error;
    fail("source.url이 올바르지 않습니다.");
  }
  const startTime = nonEmptyString(source.startTime, "source.startTime");
  const endTime = nonEmptyString(source.endTime, "source.endTime");
  const startMs = timecodeMs(startTime, "source.startTime");
  const endMs = timecodeMs(endTime, "source.endTime");
  if (endMs <= startMs) fail("source.endTime은 source.startTime보다 늦어야 합니다.");

  const coordinates = recordValue(root.coordinateSystem, "coordinateSystem");
  if (coordinates.width !== 100 || coordinates.height !== 136 || coordinates.attackDirection !== "negative_y" || coordinates.normalized !== true) {
    fail("coordinateSystem은 100×136, negative_y, normalized:true여야 합니다.");
  }
  const scene = recordValue(root.scene, "scene");
  const decisionTime = nonEmptyString(scene.decisionTime, "scene.decisionTime");
  const decisionMs = timecodeMs(decisionTime, "scene.decisionTime");
  if (decisionMs < startMs || decisionMs > endMs) fail("scene.decisionTime은 출처 시간 범위 안에 있어야 합니다.");

  const players = recordArray(scene.players, "scene.players").map((player, index) => {
    const field = `scene.players[${index}]`;
    const id = nonEmptyString(player.id, `${field}.id`);
    if (player.team !== "attack" && player.team !== "defense") fail(`${field}.team이 올바르지 않습니다.`);
    if (player.confidence !== "exact" && player.confidence !== "estimated" && player.confidence !== "unknown") fail(`${field}.confidence가 올바르지 않습니다.`);
    return {
      id, team: player.team, role: nonEmptyString(player.role, `${field}.role`),
      position: spatialPoint(player.position, `${field}.position`),
      hasBall: booleanValue(player.hasBall, `${field}.hasBall`), confidence: player.confidence,
    };
  });
  if (players.length === 0) fail("scene.players에는 한 명 이상 필요합니다.");
  const playerIds = new Set(players.map((player) => player.id));
  if (playerIds.size !== players.length) fail("scene.players의 id는 중복될 수 없습니다.");
  const ballOwnerId = nonEmptyString(scene.ballOwnerId, "scene.ballOwnerId");
  if (!playerIds.has(ballOwnerId)) fail("scene.ballOwnerId가 scene.players에 없습니다.");
  if (!players.some((player) => player.id === ballOwnerId && player.hasBall)) fail("scene.ballOwnerId 선수의 hasBall은 true여야 합니다.");

  const defense = recordValue(scene.defense, "scene.defense");
  if (!SPATIAL_DEFENSES.includes(defense.primaryType as typeof SPATIAL_DEFENSES[number])) fail("scene.defense.primaryType이 올바르지 않습니다.");
  const openSpaces = recordArray(scene.openSpaces ?? [], "scene.openSpaces").map((space, index) => {
    const field = `scene.openSpaces[${index}]`;
    const xMin = finiteNumber(space.xMin, `${field}.xMin`); const xMax = finiteNumber(space.xMax, `${field}.xMax`);
    const yMin = finiteNumber(space.yMin, `${field}.yMin`); const yMax = finiteNumber(space.yMax, `${field}.yMax`);
    if (xMin < 0 || xMax > 100 || xMin >= xMax) fail(`${field}의 x 범위가 올바르지 않습니다.`);
    if (yMin < 0 || yMax > 136 || yMin >= yMax) fail(`${field}의 y 범위가 올바르지 않습니다.`);
    return { id: nonEmptyString(space.id, `${field}.id`), xMin, xMax, yMin, yMax };
  });
  const preferredRecords = recordArray(scene.preferredSequence, "scene.preferredSequence");
  if (preferredRecords.length === 0) fail("scene.preferredSequence에는 한 개 이상의 행동이 필요합니다.");
  const actions = (value: unknown, field: string) => recordArray(value ?? [], field).map((action, index) => parseSpatialAction(action, `${field}[${index}]`, playerIds, ballOwnerId));
  const evidence = recordArray(scene.evidence, "scene.evidence").map((item, index) => {
    const field = `scene.evidence[${index}]`;
    if (item.type !== "observation" && item.type !== "coach_statement") fail(`${field}.type이 올바르지 않습니다.`);
    return { timeRange: nonEmptyString(item.timeRange, `${field}.timeRange`), type: item.type, statement: nonEmptyString(item.statement, `${field}.statement`) };
  });
  if (evidence.length === 0) fail("scene.evidence에는 한 개 이상의 근거가 필요합니다.");

  return {
    source: { title: nonEmptyString(source.title, "source.title"), url, startTime, endTime, coachName: nonEmptyString(source.coachName, "source.coachName") },
    coordinateSystem: { width: 100, height: 136, attackDirection: "negative_y", normalized: true },
    scene: {
      title: nonEmptyString(scene.title, "scene.title"), decisionTime, userRole: nonEmptyString(scene.userRole, "scene.userRole"), ballOwnerId,
      defense: { primaryType: defense.primaryType as string, description: nonEmptyString(defense.description, "scene.defense.description") },
      players, openSpaces, decisionCues: stringArray(scene.decisionCues, "scene.decisionCues"),
      preferredSequence: preferredRecords.map((action, index) => parseSpatialAction(action, `scene.preferredSequence[${index}]`, playerIds, ballOwnerId)),
      alternatives: actions(scene.alternatives, "scene.alternatives"), riskyActions: actions(scene.riskyActions, "scene.riskyActions"),
      expectedOutcome: nonEmptyString(scene.expectedOutcome, "scene.expectedOutcome"), evidence,
      uncertainties: stringArray(scene.uncertainties ?? [], "scene.uncertainties"),
    },
  };
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
  if (actions.length === 0 || actions.some((item) => !item.reason.trim() || item.citationIds.length === 0 || item.citationIds.some((id) => !knownCitationIds.has(id)))) {
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
    purpose: nonEmptyString(input.purpose, "purpose"),
    promptVersion: nonEmptyString(input.promptVersion, "promptVersion"),
    schemaVersion: nonEmptyString(input.schemaVersion, "schemaVersion"),
    sourceHashes: input.sourceHashes.map((hash, index) => nonEmptyString(hash, `sourceHashes[${index}]`)).sort(),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
