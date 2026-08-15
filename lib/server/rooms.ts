import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { campaigns, participants, rooms } from "@/db/schema";
import { createRecoveryToken, hashRecoveryToken, normalizeNickname } from "@/lib/domain/identity";

export class RoomError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function inviteCode() {
  return createRecoveryToken().slice(0, 10).toUpperCase();
}

export async function createRoom(campaignId: string, rawNickname: string) {
  const db = getDb();
  const campaign = await db.select().from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.reviewStatus, "reviewed"))).get();
  if (!campaign) throw new RoomError("코치 검수가 끝난 캠페인만 팀방을 만들 수 있어요.", 409);

  const nickname = normalizeNickname(rawNickname);
  const roomId = crypto.randomUUID();
  const participantId = crypto.randomUUID();
  const token = createRecoveryToken();
  const code = inviteCode();
  const now = new Date();

  await db.insert(rooms).values({ id: roomId, inviteCode: code, campaignId, ownerParticipantId: participantId, createdAt: now }).run();
  await db.insert(participants).values({ id: participantId, roomId, nickname, tokenHash: await hashRecoveryToken(token), isOwner: true, createdAt: now }).run();
  return { roomId, inviteCode: code, participantId, recoveryToken: token };
}

export async function joinRoom(code: string, rawNickname: string) {
  const db = getDb();
  const room = await db.select().from(rooms).where(eq(rooms.inviteCode, code.toUpperCase())).get();
  if (!room) throw new RoomError("유효하지 않은 초대 링크예요.", 404);
  const nickname = normalizeNickname(rawNickname);
  const duplicate = await db.select({ id: participants.id }).from(participants).where(and(eq(participants.roomId, room.id), eq(participants.nickname, nickname), isNull(participants.removedAt))).get();
  if (duplicate) throw new RoomError("이 팀방에서 이미 사용 중인 닉네임이에요.", 409);

  const participantId = crypto.randomUUID();
  const token = createRecoveryToken();
  await db.insert(participants).values({ id: participantId, roomId: room.id, nickname, tokenHash: await hashRecoveryToken(token), createdAt: new Date() }).run();
  return { roomId: room.id, participantId, recoveryToken: token };
}

export async function authenticateParticipant(participantId: string, token: string) {
  const db = getDb();
  const participant = await db.select().from(participants).where(and(eq(participants.id, participantId), isNull(participants.removedAt))).get();
  if (!participant || participant.tokenHash !== await hashRecoveryToken(token)) throw new RoomError("복귀 키가 유효하지 않아요.", 401);
  return participant;
}

export function jsonError(error: unknown) {
  const roomError = error instanceof RoomError ? error : new RoomError("요청을 처리하지 못했어요.", 500);
  return Response.json({ error: roomError.message }, { status: roomError.status });
}

