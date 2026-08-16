import { reconstructAttemptInput } from "./content.ts";
import type {
  AttemptInput,
  CoachExplanation,
  LegacyPassScenarioContent,
  ParsedAttemptInput,
  PersistedAttemptChoice,
  Point,
  ScenarioAction,
  ScenarioContent,
  ScenarioTimeline,
} from "./content.ts";
import type { ActionEvaluation } from "./scenario-judging.ts";

type PersistedLegacyChoice = PersistedAttemptChoice & { touchX: number; touchY: number };

export type StructuredAttemptFeedback = {
  correct: boolean;
  grade: "preferred" | "alternative" | "incorrect";
  hint: string | null;
  explanation: string | null;
  selectedPath: Point[] | null;
  recommendedAction: ScenarioAction | null;
  recommendedPath: Point[] | null;
  timeline: ScenarioTimeline | null;
  explanations: CoachExplanation[];
  mastery: Record<string, number>;
};

function actionPath(content: ScenarioContent, action: ScenarioAction): Point[] | null {
  const actor = content.pitch.players.find((player) => player.id === content.actorId);
  if (!actor) return null;
  const start = { x: actor.x, y: actor.y };
  if (action.target.kind === "player") {
    const target = content.pitch.players.find((player) => player.id === action.target.playerId);
    return target ? [start, { x: target.x, y: target.y }] : null;
  }
  return [start, { x: action.target.zone.cx, y: action.target.zone.cy }];
}

export function attemptAnalyticsPoint(
  content: ScenarioContent,
  input: Pick<AttemptInput, "actionType" | "targetPlayerId" | "destination">,
  selectedPath: Point[] | null,
): Point {
  if (input.destination) return input.destination;
  const endpoint = selectedPath?.at(-1);
  if (endpoint) return endpoint;
  if (input.targetPlayerId) {
    const target = content.pitch.players.find((player) => player.id === input.targetPlayerId);
    if (target) return { x: target.x, y: target.y };
  }
  return { x: 0, y: 0 };
}

export function resolveLegacyAttemptChoice(
  content: LegacyPassScenarioContent,
  input: ParsedAttemptInput,
  persisted: PersistedLegacyChoice | null,
): { point: Point; path: Point[] } {
  let point: Point;
  if (persisted?.pathJson) {
    const reconstructed = reconstructAttemptInput(
      { eventId: input.eventId, scenarioId: input.scenarioId },
      persisted,
    );
    if (!reconstructed.destination) throw new Error("저장된 기존 문제 답안을 확인할 수 없어요.");
    point = reconstructed.destination;
  } else if (persisted) {
    point = { x: persisted.touchX / 100, y: persisted.touchY / 100 };
  } else if ("actionType" in input) {
    if (!input.destination) throw new Error("기존 문제 패스 도착 지점이 필요해요.");
    point = input.destination;
  } else {
    point = { x: input.x, y: input.y };
  }

  const actor = content.pitch.players.find((player) => player.id === content.actorId);
  if (!actor) throw new Error("기존 문제 행동 선수를 확인할 수 없어요.");
  return { point, path: [{ x: actor.x, y: actor.y }, point] };
}

export function buildStructuredAttemptFeedback(
  hint: string,
  evaluation: ActionEvaluation,
  content: ScenarioContent,
  misses: number,
  mastery: Record<string, number>,
): StructuredAttemptFeedback {
  const revealResult = evaluation.correct || misses >= 2;
  const observe = content.explanations.find((explanation) => explanation.kind === "observe");
  return {
    correct: evaluation.correct,
    grade: evaluation.grade,
    hint: evaluation.correct ? null : hint,
    explanation: revealResult ? evaluation.reason : null,
    selectedPath: evaluation.selectedPath,
    recommendedAction: revealResult ? evaluation.recommended : null,
    recommendedPath: revealResult ? actionPath(content, evaluation.recommended) : null,
    timeline: revealResult ? content.timeline : null,
    explanations: revealResult ? content.explanations : observe ? [observe] : [],
    mastery,
  };
}
