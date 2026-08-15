import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { participants, rooms } from "@/db/schema";
import { RoomError, jsonError } from "@/lib/server/rooms";
import { authFromRequest } from "@/lib/server/training";

export async function DELETE(request: Request, context: { params: Promise<{ code: string; id: string }> }) {
  try {
    const owner = await authFromRequest(request);
    if (!owner.isOwner) throw new RoomError("방장만 팀원을 내보낼 수 있어요.", 403);
    const { code, id } = await context.params;
    const room = await getDb().select().from(rooms).where(eq(rooms.inviteCode, code.toUpperCase())).get();
    if (!room || room.id !== owner.roomId) throw new RoomError("팀방을 찾을 수 없어요.", 404);
    if (id === owner.id) throw new RoomError("방장은 자신을 내보낼 수 없어요.");
    await getDb().update(participants).set({ removedAt: new Date() }).where(and(eq(participants.id, id), eq(participants.roomId, room.id))).run();
    return Response.json({ removed: true });
  } catch (error) { return jsonError(error); }
}
