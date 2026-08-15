import { joinRoom, jsonError } from "@/lib/server/rooms";

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const body = await request.json() as { nickname?: string };
    if (!body.nickname) return Response.json({ error: "닉네임이 필요해요." }, { status: 400 });
    return Response.json(await joinRoom(code, body.nickname), { status: 201 });
  } catch (error) { return jsonError(error); }
}

