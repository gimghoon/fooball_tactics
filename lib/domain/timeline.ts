import type { CoachExplanation, ExplanationKind, Point, ScenarioTimeline, TimelineKeyframe } from "./content";

export type PitchFrame = TimelineKeyframe;
export type ExplanationStage = "상황" | "판단" | "결과";

export function explanationStage(kind: ExplanationKind): ExplanationStage {
  if (kind === "observe") return "상황";
  if (kind === "remember") return "결과";
  return "판단";
}

export function initialExplanationIndex(explanations: CoachExplanation[]): number {
  const observeIndex = explanations.findIndex(({ kind }) => kind === "observe");
  return observeIndex < 0 ? 0 : observeIndex;
}

function interpolatePoint(from: Point, to: Point, progress: number): Point {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

export function frameAt(timeline: ScenarioTimeline, atMs: number): PitchFrame {
  const keyframes = [...timeline.keyframes].sort((left, right) => left.atMs - right.atMs);
  if (keyframes.length === 0) throw new Error("타임라인 키프레임이 필요합니다.");

  const currentMs = Math.min(Math.max(atMs, 0), timeline.durationMs);
  const before = [...keyframes].reverse().find((keyframe) => keyframe.atMs <= currentMs) ?? keyframes[0];
  const after = keyframes.find((keyframe) => keyframe.atMs >= currentMs) ?? keyframes.at(-1)!;

  if (before.atMs === after.atMs) {
    return {
      atMs: currentMs,
      players: Object.fromEntries(Object.entries(before.players).map(([id, point]) => [id, { ...point }])),
      ball: { ...before.ball },
    };
  }

  const progress = (currentMs - before.atMs) / (after.atMs - before.atMs);
  const playerIds = new Set([...Object.keys(before.players), ...Object.keys(after.players)]);
  const players = Object.fromEntries([...playerIds].map((id) => {
    const from = before.players[id];
    const to = after.players[id];
    return [id, from && to ? interpolatePoint(from, to, progress) : { ...(from ?? to) }];
  }));

  return {
    atMs: currentMs,
    players,
    ball: interpolatePoint(before.ball, after.ball, progress),
  };
}
