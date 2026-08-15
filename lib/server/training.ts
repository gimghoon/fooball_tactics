import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { attempts, mastery, participants, reflections, rooms, scenarios } from "@/db/schema";
import { isPointInZone, type CircleZone } from "@/lib/domain/geometry";
import { calculateMastery, type Principle } from "@/lib/domain/mastery";
import { RoomError, authenticateParticipant } from "./rooms";

export async function authFromRequest(request: Request) {
  const participantId = request.headers.get("x-participant-id") ?? "";
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!participantId || !token) throw new RoomError("복귀 키가 필요해요.", 401);
  return authenticateParticipant(participantId, token);
}

export async function recordAttempt(request: Request, input: { eventId: string; scenarioId: string; x: number; y: number }) {
  const participant = await authFromRequest(request);
  const db = getDb();
  const scenario = await db.select().from(scenarios).where(and(eq(scenarios.id, input.scenarioId), eq(scenarios.reviewStatus, "reviewed"))).get();
  if (!scenario) throw new RoomError("검수되지 않은 문제에는 답안을 제출할 수 없어요.", 409);
  const zone = JSON.parse(scenario.answerJson) as CircleZone;
  const correct = isPointInZone({ x: input.x, y: input.y }, zone);
  await db.insert(attempts).values({ eventId: input.eventId, participantId: participant.id, scenarioId: scenario.id, principle: scenario.principle, correct, touchX: Math.round(input.x * 100), touchY: Math.round(input.y * 100), createdAt: new Date() }).onConflictDoNothing().run();
  if (correct) await db.update(participants).set({ completedStage: scenario.role }).where(eq(participants.id, participant.id)).run();

  const scenarioAttempts = await db.select({ correct: attempts.correct }).from(attempts).where(and(eq(attempts.participantId, participant.id), eq(attempts.scenarioId, scenario.id))).all();
  const misses = scenarioAttempts.filter((attempt) => !attempt.correct).length;

  const allAttempts = await db.select({ principle: attempts.principle, correct: attempts.correct, eventId: attempts.eventId }).from(attempts).where(eq(attempts.participantId, participant.id)).all();
  const scores = calculateMastery(allAttempts.map((attempt) => ({ ...attempt, principle: attempt.principle as Principle })));
  for (const [principle, score] of Object.entries(scores)) {
    await db.insert(mastery).values({ participantId: participant.id, principle, score, updatedAt: new Date() }).onConflictDoUpdate({ target: [mastery.participantId, mastery.principle], set: { score, updatedAt: new Date() } }).run();
  }
  return { correct, hint: correct ? null : scenario.hint, explanation: correct || misses >= 2 ? scenario.explanation : null, answer: !correct && misses >= 2 ? zone : null, mastery: scores };
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
