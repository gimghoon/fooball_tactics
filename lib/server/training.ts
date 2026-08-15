import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { attempts, mastery, participants, reflections, rooms, scenarios } from "@/db/schema";
import { isPointInZone, type CircleZone } from "@/lib/domain/geometry";
import {
  adaptLegacyPassScenario,
  parseScenarioContent,
  reconstructAttemptInput,
  type AttemptInput,
  type CoachExplanation,
  type LegacyAttemptInput,
  type ParsedAttemptInput,
  type Point,
  type ScenarioAction,
  type ScenarioContent,
  type ScenarioTimeline,
} from "@/lib/domain/content";
import { calculateMastery, type Principle } from "@/lib/domain/mastery";
import { evaluateScenarioAction, type ActionEvaluation } from "@/lib/domain/scenario-judging";
import {
  attemptAnalyticsPoint,
  buildStructuredAttemptFeedback,
} from "@/lib/domain/attempt-feedback";
import { RoomError, authenticateParticipant } from "./rooms";

export type AttemptFeedback = {
  correct: boolean;
  grade: "preferred" | "alternative" | "incorrect" | null;
  hint: string | null;
  explanation: string | null;
  selectedPath: Point[] | null;
  recommendedAction: ScenarioAction | null;
  recommendedPath: Point[] | null;
  timeline: ScenarioTimeline | null;
  explanations: CoachExplanation[];
  mastery: Record<string, number>;
  answer?: CircleZone | null;
};

export async function authFromRequest(request: Request) {
  const participantId = request.headers.get("x-participant-id") ?? "";
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!participantId || !token) throw new RoomError("복귀 키가 필요해요.", 401);
  return authenticateParticipant(participantId, token);
}

function isLegacyAttemptInput(input: ParsedAttemptInput): input is LegacyAttemptInput {
  return !("actionType" in input);
}

export async function recordAttempt(request: Request, input: ParsedAttemptInput): Promise<AttemptFeedback> {
  const participant = await authFromRequest(request);
  const db = getDb();
  const scenario = await db.select().from(scenarios).where(and(eq(scenarios.id, input.scenarioId), eq(scenarios.reviewStatus, "reviewed"))).get();
  if (!scenario) throw new RoomError("검수되지 않은 문제에는 답안을 제출할 수 없어요.", 409);
  const existing = await db.select().from(attempts).where(eq(attempts.eventId, input.eventId)).get();
  if (existing && (existing.participantId !== participant.id || existing.scenarioId !== scenario.id)) {
    throw new RoomError("이미 사용된 답안 ID예요.", 409);
  }

  let correct: boolean;
  let evaluation: ActionEvaluation | null = null;
  let content: ScenarioContent | null = null;
  let zone: CircleZone | null = null;
  let actionType: AttemptInput["actionType"] = "pass";
  let targetPlayerId: string | null = null;
  let selectedPath: Point[] | null = null;
  let recordedPoint: Point;

  if (scenario.contentJson === "") {
    const legacy = adaptLegacyPassScenario(scenario);
    if (legacy.answer.preferred.target.kind !== "zone") throw new RoomError("기존 문제 답안을 확인할 수 없어요.", 409);
    zone = legacy.answer.preferred.target.zone;
    if (isLegacyAttemptInput(input)) {
      recordedPoint = { x: input.x, y: input.y };
    } else {
      if (input.actionType !== "pass" || input.destination === undefined) {
        throw new RoomError("기존 문제는 패스 도착 지점으로 제출해주세요.", 400);
      }
      actionType = input.actionType;
      targetPlayerId = input.targetPlayerId ?? null;
      recordedPoint = input.destination;
    }
    if (existing) recordedPoint = { x: existing.touchX / 100, y: existing.touchY / 100 };
    correct = existing?.correct ?? isPointInZone(recordedPoint, zone);
  } else {
    if (isLegacyAttemptInput(input)) throw new RoomError("행동 유형을 포함해 답안을 제출해주세요.", 400);
    content = parseScenarioContent(scenario.contentJson);
    if (!content.review.sourceReviewed || !content.review.timelineReviewed || !content.review.explanationsReviewed) {
      throw new RoomError("검수가 완료되지 않은 문제에는 답안을 제출할 수 없어요.", 409);
    }
    const actionInput = existing
      ? reconstructAttemptInput({ eventId: input.eventId, scenarioId: input.scenarioId }, existing)
      : input;
    evaluation = evaluateScenarioAction(content, actionInput);
    correct = existing?.correct ?? evaluation.correct;
    actionType = actionInput.actionType;
    targetPlayerId = actionInput.targetPlayerId ?? null;
    selectedPath = evaluation.selectedPath;
    recordedPoint = attemptAnalyticsPoint(content, actionInput, selectedPath);
  }

  if (!existing) {
    await db.insert(attempts).values({
      eventId: input.eventId,
      participantId: participant.id,
      scenarioId: scenario.id,
      principle: scenario.principle,
      correct,
      touchX: Math.round(recordedPoint.x * 100),
      touchY: Math.round(recordedPoint.y * 100),
      actionType,
      targetPlayerId,
      pathJson: selectedPath === null ? null : JSON.stringify(selectedPath),
      createdAt: new Date(),
    }).onConflictDoNothing().run();
  }
  const persisted = await db.select().from(attempts).where(eq(attempts.eventId, input.eventId)).get();
  if (!persisted || persisted.participantId !== participant.id || persisted.scenarioId !== scenario.id) {
    throw new RoomError("이미 사용된 답안 ID예요.", 409);
  }
  correct = persisted.correct;
  if (content && !isLegacyAttemptInput(input)) {
    evaluation = evaluateScenarioAction(
      content,
      reconstructAttemptInput({ eventId: input.eventId, scenarioId: input.scenarioId }, persisted),
    );
    selectedPath = evaluation.selectedPath;
  }
  if (correct) await db.update(participants).set({ completedStage: scenario.role }).where(eq(participants.id, participant.id)).run();

  const scenarioAttempts = await db.select({ correct: attempts.correct }).from(attempts).where(and(eq(attempts.participantId, participant.id), eq(attempts.scenarioId, scenario.id))).all();
  const misses = scenarioAttempts.filter((attempt) => !attempt.correct).length;

  const allAttempts = await db.select({ principle: attempts.principle, correct: attempts.correct, eventId: attempts.eventId }).from(attempts).where(eq(attempts.participantId, participant.id)).all();
  const scores = calculateMastery(allAttempts.map((attempt) => ({ ...attempt, principle: attempt.principle as Principle })));
  for (const [principle, score] of Object.entries(scores)) {
    await db.insert(mastery).values({ participantId: participant.id, principle, score, updatedAt: new Date() }).onConflictDoUpdate({ target: [mastery.participantId, mastery.principle], set: { score, updatedAt: new Date() } }).run();
  }
  if (content && evaluation) return buildStructuredAttemptFeedback(scenario.hint, { ...evaluation, correct }, content, misses, scores);
  return {
    correct,
    grade: null,
    hint: correct ? null : scenario.hint,
    explanation: correct || misses >= 2 ? scenario.explanation : null,
    selectedPath: null,
    recommendedAction: null,
    recommendedPath: null,
    timeline: null,
    explanations: [],
    answer: !correct && misses >= 2 ? zone : null,
    mastery: scores,
  };
}

export async function teamProgress(request: Request, inviteCode: string) {
  const viewer = await authFromRequest(request);
  const db = getDb();
  const room = await db.select().from(rooms).where(eq(rooms.inviteCode, inviteCode.toUpperCase())).get();
  if (!room || room.id !== viewer.roomId) throw new RoomError("이 팀방을 볼 권한이 없어요.", 403);
  const members = await db.select({ id: participants.id, nickname: participants.nickname, completedStage: participants.completedStage }).from(participants).where(and(eq(participants.roomId, room.id), isNull(participants.removedAt))).all();
  const scores = await db.select().from(mastery).all();
  const roomScores = scores.filter((score) => members.some((member) => member.id === score.participantId));
  const principles = ["width", "support", "pivot", "transition"];
  const teamMastery = Object.fromEntries(principles.map((principle) => {
    const matching = roomScores.filter((score) => score.principle === principle);
    return [principle, matching.length ? Math.round(matching.reduce((sum, item) => sum + item.score, 0) / matching.length) : 0];
  }));
  return { members, teamMastery };
}

export async function saveReflection(request: Request, input: { missionId: string; result: "worked" | "difficult"; note?: string }) {
  const participant = await authFromRequest(request);
  if (!input.missionId || !["worked", "difficult"].includes(input.result)) throw new RoomError("회고 내용을 확인해주세요.");
  const note = (input.note ?? "").trim().slice(0, 280);
  await getDb().insert(reflections).values({ id: crypto.randomUUID(), participantId: participant.id, missionId: input.missionId, result: input.result, note, createdAt: new Date() }).run();
  return { saved: true };
}
