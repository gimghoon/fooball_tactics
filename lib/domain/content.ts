export type ReviewStatus = "draft" | "pending" | "reviewed";

export function playableScenarios<T extends { reviewStatus: ReviewStatus }>(scenarios: T[]) {
  return scenarios.filter((scenario) => scenario.reviewStatus === "reviewed");
}

export type ActionType = "pass" | "dribble" | "move";
export type DefenseType =
  | "front_press"
  | "central_block"
  | "wide_funnel"
  | "one_v_one"
  | "numerical_advantage"
  | "numerical_disadvantage";
export type ExplanationKind = "observe" | "benefit" | "risk" | "remember";

export type Point = { x: number; y: number };
export type CircleZone = { kind: "circle"; cx: number; cy: number; radius: number };
export type PitchPlayer = Point & { id: string; team: "us" | "them" };
export type PitchState = {
  players: PitchPlayer[];
  ball: Point;
  zones: { id: string; zone: CircleZone }[];
};

export type HighlightRef =
  | { kind: "player"; id: string }
  | { kind: "zone"; id: string }
  | { kind: "path"; id: "selected-path" | "recommended-path" };

export type ScenarioTarget =
  | { kind: "player"; playerId: string }
  | { kind: "zone"; zone: CircleZone };

export type ScenarioAction = {
  actionType: ActionType;
  target: ScenarioTarget;
  reason?: string;
};

export type ScenarioAnswer = {
  preferred: ScenarioAction;
  alternatives: ScenarioAction[];
  hazards: CircleZone[];
};

export type TimelineKeyframe = {
  atMs: number;
  players: Record<string, Point>;
  ball: Point;
};

export type ScenarioTimeline = {
  durationMs: number;
  decisionAtMs: number;
  keyframes: TimelineKeyframe[];
};

export type CoachExplanation = {
  kind: ExplanationKind;
  text: string;
  fromMs: number;
  toMs: number;
  highlights: HighlightRef[];
};

export type ScenarioContent = {
  defenseType: DefenseType;
  actorId: string;
  allowedActions: ActionType[];
  pitch: PitchState;
  answer: ScenarioAnswer;
  timeline: ScenarioTimeline;
  explanations: CoachExplanation[];
  review: { sourceReviewed: boolean; timelineReviewed: boolean; explanationsReviewed: boolean };
};

export type PublicScenarioContent = Pick<ScenarioContent, "defenseType" | "actorId" | "allowedActions" | "pitch"> & {
  setupTimeline: ScenarioTimeline;
};

export type LegacyPassScenarioContent = Omit<ScenarioContent, "defenseType"> & {
  defenseType: null;
};

export type PublicLegacyScenarioContent = Omit<PublicScenarioContent, "defenseType"> & {
  defenseType: null;
};

export type PublicScenarioProjection = PublicScenarioContent | PublicLegacyScenarioContent;

type LegacyPassScenario = {
  pitchJson: string;
  answerJson: string;
};

type ScenarioContentSource = LegacyPassScenario & {
  contentJson: string;
};

const ACTION_TYPES: readonly ActionType[] = ["pass", "dribble", "move"];
const DEFENSE_TYPES: readonly DefenseType[] = [
  "front_press",
  "central_block",
  "wide_funnel",
  "one_v_one",
  "numerical_advantage",
  "numerical_disadvantage",
];
const EXPLANATION_KINDS: readonly ExplanationKind[] = ["observe", "benefit", "risk", "remember"];

function fail(message: string): never {
  throw new Error(`시나리오 ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field}가 필요합니다.`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field}는 유한한 숫자여야 합니다.`);
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (number < 0) fail(`${field}는 음수가 될 수 없습니다.`);
  return number;
}

function pointValue(value: unknown, field: string): Point {
  if (!isRecord(value)) fail(`${field}가 필요합니다.`);
  return {
    x: finiteNumber(value.x, `${field}.x`),
    y: finiteNumber(value.y, `${field}.y`),
  };
}

function circleZoneValue(value: unknown, field: string): CircleZone {
  if (!isRecord(value) || value.kind !== "circle") fail(`${field}는 원형 영역이어야 합니다.`);
  return {
    kind: "circle",
    cx: finiteNumber(value.cx, `${field}.cx`),
    cy: finiteNumber(value.cy, `${field}.cy`),
    radius: nonNegativeNumber(value.radius, `${field}.radius`),
  };
}

function actionTypeValue(value: unknown, field: string): ActionType {
  if (!ACTION_TYPES.includes(value as ActionType)) fail(`${field}가 올바르지 않습니다.`);
  return value as ActionType;
}

function targetValue(value: unknown, field: string): ScenarioTarget {
  if (!isRecord(value) || (value.kind !== "player" && value.kind !== "zone")) {
    fail(`${field}가 올바르지 않습니다.`);
  }
  if (value.kind === "player") {
    return { kind: "player", playerId: stringValue(value.playerId, `${field}.playerId`) };
  }
  return { kind: "zone", zone: circleZoneValue(value.zone, `${field}.zone`) };
}

function actionValue(value: unknown, field: string): ScenarioAction {
  if (!isRecord(value)) fail(`${field}가 필요합니다.`);
  const action: ScenarioAction = {
    actionType: actionTypeValue(value.actionType, `${field}.actionType`),
    target: targetValue(value.target, `${field}.target`),
  };
  if (value.reason !== undefined) {
    action.reason = stringValue(value.reason, `${field}.reason`);
  }
  return action;
}

function parseContentObject(input: unknown): ScenarioContent {
  if (!isRecord(input)) fail("콘텐츠 객체가 필요합니다.");
  if (!DEFENSE_TYPES.includes(input.defenseType as DefenseType)) fail("수비 유형이 올바르지 않습니다.");
  const actorId = stringValue(input.actorId, "actorId");

  if (!Array.isArray(input.allowedActions) || input.allowedActions.length === 0) {
    fail("허용 행동이 필요합니다.");
  }
  const allowedActions = input.allowedActions.map((action, index) => actionTypeValue(action, `allowedActions[${index}]`));
  if (new Set(allowedActions).size !== allowedActions.length) fail("허용 행동이 중복됩니다.");

  if (!isRecord(input.pitch)) fail("pitch가 필요합니다.");
  if (!Array.isArray(input.pitch.players) || input.pitch.players.length === 0) fail("pitch.players가 필요합니다.");
  const playerIds = new Set<string>();
  const players = input.pitch.players.map((value, index) => {
    if (!isRecord(value)) fail(`pitch.players[${index}]가 필요합니다.`);
    const id = stringValue(value.id, `pitch.players[${index}].id`);
    if (playerIds.has(id)) fail("시각 ID가 중복됩니다.");
    playerIds.add(id);
    if (value.team !== "us" && value.team !== "them") fail(`pitch.players[${index}].team이 올바르지 않습니다.`);
    return {
      id,
      x: finiteNumber(value.x, `pitch.players[${index}].x`),
      y: finiteNumber(value.y, `pitch.players[${index}].y`),
      team: value.team,
    } as PitchPlayer;
  });
  if (!playerIds.has(actorId)) fail("actorId가 선수 목록에 없습니다.");

  const ball = pointValue(input.pitch.ball, "pitch.ball");
  if (!Array.isArray(input.pitch.zones)) fail("pitch.zones가 필요합니다.");
  const zoneIds = new Set<string>();
  const zones = input.pitch.zones.map((value, index) => {
    if (!isRecord(value)) fail(`pitch.zones[${index}]가 필요합니다.`);
    const id = stringValue(value.id, `pitch.zones[${index}].id`);
    if (zoneIds.has(id) || playerIds.has(id)) fail("시각 ID가 중복됩니다.");
    zoneIds.add(id);
    return { id, zone: circleZoneValue(value.zone, `pitch.zones[${index}].zone`) };
  });
  const pitch: PitchState = { players, ball, zones };

  if (!isRecord(input.answer)) fail("answer가 필요합니다.");
  if (!Array.isArray(input.answer.alternatives)) fail("answer.alternatives가 필요합니다.");
  if (!Array.isArray(input.answer.hazards)) fail("answer.hazards가 필요합니다.");
  const answer: ScenarioAnswer = {
    preferred: actionValue(input.answer.preferred, "answer.preferred"),
    alternatives: input.answer.alternatives.map((value, index) => actionValue(value, `answer.alternatives[${index}]`)),
    hazards: input.answer.hazards.map((value, index) => circleZoneValue(value, `answer.hazards[${index}]`)),
  };
  const actions = [answer.preferred, ...answer.alternatives];
  for (const [index, action] of actions.entries()) {
    if (action.target.kind === "player" && !playerIds.has(action.target.playerId)) {
      fail(`answer[${index}]의 선수가 존재하지 않습니다.`);
    }
    if (action.target.kind === "zone" && (action.target.zone.radius < 0 || !Number.isFinite(action.target.zone.radius))) {
      fail(`answer[${index}]의 영역이 올바르지 않습니다.`);
    }
  }

  if (!isRecord(input.timeline)) fail("timeline이 필요합니다.");
  const durationMs = nonNegativeNumber(input.timeline.durationMs, "timeline.durationMs");
  const decisionAtMs = finiteNumber(input.timeline.decisionAtMs, "timeline.decisionAtMs");
  if (decisionAtMs < 0 || decisionAtMs > durationMs) fail("timeline.decisionAtMs가 범위를 벗어났습니다.");
  if (!Array.isArray(input.timeline.keyframes) || input.timeline.keyframes.length === 0) fail("timeline.keyframes가 필요합니다.");
  const keyframes = input.timeline.keyframes.map((value, index) => {
    if (!isRecord(value)) fail(`timeline.keyframes[${index}]가 필요합니다.`);
    const atMs = finiteNumber(value.atMs, `timeline.keyframes[${index}].atMs`);
    if (atMs < 0 || atMs > durationMs) fail(`timeline.keyframes[${index}].atMs가 범위를 벗어났습니다.`);
    if (!isRecord(value.players)) fail(`timeline.keyframes[${index}].players가 필요합니다.`);
    const framePlayers: Record<string, Point> = {};
    for (const [playerId, position] of Object.entries(value.players)) {
      if (!playerIds.has(playerId)) fail(`timeline의 선수가 존재하지 않습니다.`);
      framePlayers[playerId] = pointValue(position, `timeline.keyframes[${index}].players.${playerId}`);
    }
    return { atMs, players: framePlayers, ball: pointValue(value.ball, `timeline.keyframes[${index}].ball`) };
  });
  for (let index = 1; index < keyframes.length; index += 1) {
    if (keyframes[index].atMs < keyframes[index - 1].atMs) fail("timeline.keyframes 시간이 정렬되지 않았습니다.");
  }
  const timeline: ScenarioTimeline = { durationMs, decisionAtMs, keyframes };

  if (!Array.isArray(input.explanations)) fail("explanations가 필요합니다.");
  const explanations = input.explanations.map((value, index) => {
    if (!isRecord(value) || !EXPLANATION_KINDS.includes(value.kind as ExplanationKind)) {
      fail(`explanations[${index}]의 종류가 올바르지 않습니다.`);
    }
    const text = stringValue(value.text, `explanations[${index}].text`);
    const fromMs = finiteNumber(value.fromMs, `explanations[${index}].fromMs`);
    const toMs = finiteNumber(value.toMs, `explanations[${index}].toMs`);
    if (fromMs < 0 || fromMs > toMs || toMs > durationMs) fail(`explanations[${index}] 시간 범위가 올바르지 않습니다.`);
    if (!Array.isArray(value.highlights)) fail(`explanations[${index}].highlights가 필요합니다.`);
    const highlights = value.highlights.map((highlight, highlightIndex) => {
      if (!isRecord(highlight) || (highlight.kind !== "player" && highlight.kind !== "zone" && highlight.kind !== "path")) {
        fail(`explanations[${index}].highlights[${highlightIndex}]가 올바르지 않습니다.`);
      }
      const id = stringValue(highlight.id, `explanations[${index}].highlights[${highlightIndex}].id`);
      if (highlight.kind === "player" && !playerIds.has(id)) fail(`강조 대상 선수 ${id}가 존재하지 않습니다.`);
      if (highlight.kind === "zone" && !zoneIds.has(id)) fail(`강조 대상 영역 ${id}가 존재하지 않습니다.`);
      if (highlight.kind === "path" && id !== "selected-path" && id !== "recommended-path") fail(`강조 대상 경로 ${id}가 올바르지 않습니다.`);
      return highlight.kind === "path" ? { kind: "path", id: id as "selected-path" | "recommended-path" } : { kind: highlight.kind, id };
    }) as HighlightRef[];
    return { kind: value.kind as ExplanationKind, text, fromMs, toMs, highlights };
  });
  if (explanations.length !== EXPLANATION_KINDS.length || new Set(explanations.map(({ kind }) => kind)).size !== EXPLANATION_KINDS.length) {
    fail("설명은 네 종류를 각각 정확히 하나씩 포함해야 합니다.");
  }

  if (!isRecord(input.review)) fail("review가 필요합니다.");
  const reviewKeys = ["sourceReviewed", "timelineReviewed", "explanationsReviewed"] as const;
  for (const key of reviewKeys) {
    if (typeof input.review[key] !== "boolean") fail(`review.${key}는 불리언이어야 합니다.`);
  }
  return {
    defenseType: input.defenseType as DefenseType,
    actorId,
    allowedActions,
    pitch,
    answer,
    timeline,
    explanations,
    review: {
      sourceReviewed: input.review.sourceReviewed,
      timelineReviewed: input.review.timelineReviewed,
      explanationsReviewed: input.review.explanationsReviewed,
    },
  };
}

export function parseScenarioContent(input: unknown): ScenarioContent {
  if (typeof input === "string") {
    try {
      return parseContentObject(JSON.parse(input));
    } catch (error) {
      if (error instanceof SyntaxError) fail("JSON을 해석할 수 없습니다.");
      throw error;
    }
  }
  return parseContentObject(input);
}

export function isScenarioPublishable(input: unknown): boolean {
  try {
    const content = parseScenarioContent(input);
    return content.review.sourceReviewed && content.review.timelineReviewed && content.review.explanationsReviewed;
  } catch {
    return false;
  }
}

export function adaptLegacyPassScenario({ pitchJson, answerJson }: LegacyPassScenario): LegacyPassScenarioContent {
  let rawPitch: unknown;
  let rawAnswer: unknown;
  try {
    rawPitch = JSON.parse(pitchJson);
    rawAnswer = JSON.parse(answerJson);
  } catch {
    fail("기존 문제 JSON을 해석할 수 없습니다.");
  }

  if (!isRecord(rawPitch)) fail("기존 문제의 pitch가 필요합니다.");
  const ball = pointValue(rawPitch.ball, "기존 문제 pitch.ball");
  const rawPlayers = Array.isArray(rawPitch.players) ? rawPitch.players : [];
  const players: PitchPlayer[] = rawPlayers.map((value, index) => {
    if (!isRecord(value) || (value.team !== "us" && value.team !== "them")) {
      fail(`기존 문제 pitch.players[${index}]가 올바르지 않습니다.`);
    }
    return {
      id: `legacy-player-${index + 1}`,
      x: finiteNumber(value.x, `기존 문제 pitch.players[${index}].x`),
      y: finiteNumber(value.y, `기존 문제 pitch.players[${index}].y`),
      team: value.team,
    };
  });
  const actor = players.find((player) => player.x === ball.x && player.y === ball.y) ?? {
    id: "legacy-actor",
    x: ball.x,
    y: ball.y,
    team: "us" as const,
  };
  if (!players.some((player) => player.id === actor.id)) players.unshift(actor);

  const targetZone = circleZoneValue(rawAnswer, "기존 문제 answer");
  return {
    defenseType: null,
    actorId: actor.id,
    allowedActions: ["pass"],
    pitch: { players, ball, zones: [] },
    answer: {
      preferred: { actionType: "pass", target: { kind: "zone", zone: targetZone } },
      alternatives: [],
      hazards: [],
    },
    timeline: { durationMs: 0, decisionAtMs: 0, keyframes: [{ atMs: 0, players: {}, ball }] },
    explanations: [],
    review: { sourceReviewed: false, timelineReviewed: false, explanationsReviewed: false },
  };
}

export function toPublicScenarioContent(content: ScenarioContent | LegacyPassScenarioContent): PublicScenarioProjection {
  return {
    defenseType: content.defenseType,
    actorId: content.actorId,
    allowedActions: content.allowedActions,
    pitch: content.pitch,
    setupTimeline: {
      durationMs: content.timeline.decisionAtMs,
      decisionAtMs: content.timeline.decisionAtMs,
      keyframes: content.timeline.keyframes.filter((keyframe) => keyframe.atMs <= content.timeline.decisionAtMs),
    },
  };
}

export function serializePublicScenarioContent(source: ScenarioContentSource): string | null {
  if (source.contentJson === "") {
    return JSON.stringify(toPublicScenarioContent(adaptLegacyPassScenario(source)));
  }
  if (!isScenarioPublishable(source.contentJson)) return null;
  return JSON.stringify(toPublicScenarioContent(parseScenarioContent(source.contentJson)));
}
