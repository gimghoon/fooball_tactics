import { jsonError } from "@/lib/server/rooms";
import { recordAttempt } from "@/lib/server/training";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { eventId?: string; scenarioId?: string; x?: number; y?: number };
    if (!body.eventId || !body.scenarioId || !Number.isFinite(body.x) || !Number.isFinite(body.y)) return Response.json({ error: "답안 좌표가 올바르지 않아요." }, { status: 400 });
    return Response.json(await recordAttempt(request, body as { eventId: string; scenarioId: string; x: number; y: number }));
  } catch (error) { return jsonError(error); }
}

