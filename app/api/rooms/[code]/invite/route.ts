import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { rooms } from "@/db/schema";
import { createRecoveryToken } from "@/lib/domain/identity";
import { RoomError, jsonError } from "@/lib/server/rooms";
import { authFromRequest } from "@/lib/server/training";

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const participant = await authFromRequest(request);
    if (!participant.isOwner) throw new RoomError("방장만 초대 링크를 바꿀 수 있어요.", 403);
    const { code } = await context.params;
    const room = await getDb().select().from(rooms).where(eq(rooms.inviteCode, code.toUpperCase())).get();
    if (!room || room.id !== participant.roomId) throw new RoomError("팀방을 찾을 수 없어요.", 404);
    const inviteCode = createRecoveryToken().slice(0, 10).toUpperCase();
    await getDb().update(rooms).set({ inviteCode }).where(eq(rooms.id, room.id)).run();
    return Response.json({ inviteCode });
  } catch (error) { return jsonError(error); }
}

