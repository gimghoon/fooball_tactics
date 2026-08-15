import { isPointInZone, segmentIntersectsCircle, type Point } from "./geometry.ts";
import type { ActionType, PitchState, ScenarioAction, ScenarioAnswer, ScenarioContent } from "./content.ts";

export type ScenarioActionInput = {
  actionType: ActionType;
  targetPlayerId?: string;
  destination?: Point;
};

export type ActionEvaluation = {
  correct: boolean;
  grade: "preferred" | "alternative" | "incorrect";
  selectedPath: Point[] | null;
  recommended: ScenarioAction;
  reason: string | null;
};

function isFinitePoint(point: Point | undefined): point is Point {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function findActor(pitch: PitchState, actorId: string) {
  return pitch.players.find((player) => player.id === actorId);
}

function isTeammate(content: ScenarioContent, targetPlayerId: string | undefined): boolean {
  const actor = findActor(content.pitch, content.actorId);
  return Boolean(
    actor &&
      content.pitch.players.some(
        (player) => player.id === targetPlayerId && player.team === actor.team && player.id !== actor.id,
      ),
  );
}

function selectedPath(content: ScenarioContent, input: ScenarioActionInput): Point[] | null {
  const actor = findActor(content.pitch, content.actorId);
  if (!actor) return null;

  if (input.actionType === "pass") {
    const target = content.pitch.players.find(
      (player) => player.id === input.targetPlayerId && player.team === actor.team && player.id !== actor.id,
    );
    if (target) return [{ x: actor.x, y: actor.y }, { x: target.x, y: target.y }];
  }

  return isFinitePoint(input.destination)
    ? [{ x: actor.x, y: actor.y }, { x: input.destination.x, y: input.destination.y }]
    : null;
}

function actionMatches(
  action: ScenarioAction,
  content: ScenarioContent,
  input: ScenarioActionInput,
): boolean {
  if (action.actionType !== input.actionType || !content.allowedActions.includes(input.actionType)) return false;

  if (input.actionType === "pass") {
    if (action.target.kind === "player") {
      return action.target.playerId === input.targetPlayerId && isTeammate(content, input.targetPlayerId);
    }
    return isFinitePoint(input.destination) && isPointInZone(input.destination, action.target.zone);
  }

  return action.target.kind === "zone" && isFinitePoint(input.destination) && isPointInZone(input.destination, action.target.zone);
}

function pathIsUnsafe(content: ScenarioContent, action: ScenarioAction, path: Point[] | null): boolean {
  if ((action.actionType !== "dribble" && action.actionType !== "move") || path === null) return false;
  const [start, end] = path;
  return content.answer.hazards.some((hazard) => segmentIntersectsCircle(start, end, hazard));
}

export function evaluateScenarioAction(content: ScenarioContent, input: ScenarioActionInput): ActionEvaluation {
  const path = selectedPath(content, input);
  const recommended = content.answer.preferred;
  const candidates: { action: ScenarioAction; grade: "preferred" | "alternative" }[] = [
    { action: recommended, grade: "preferred" },
    ...content.answer.alternatives.map((action) => ({ action, grade: "alternative" as const })),
  ];

  for (const candidate of candidates) {
    if (actionMatches(candidate.action, content, input) && !pathIsUnsafe(content, candidate.action, path)) {
      return {
        correct: true,
        grade: candidate.grade,
        selectedPath: path,
        recommended,
        reason: candidate.action.reason ?? null,
      };
    }
  }

  return {
    correct: false,
    grade: "incorrect",
    selectedPath: path,
    recommended,
    reason: null,
  };
}

export type { ScenarioAnswer };
