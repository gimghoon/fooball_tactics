import { createRoom, jsonError } from "@/lib/server/rooms";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { campaignId?: string; nickname?: string };
    if (!body.campaignId || !body.nickname) return Response.json({ error: "캠페인과 닉네임이 필요해요." }, { status: 400 });
    return Response.json(await createRoom(body.campaignId, body.nickname), { status: 201 });
  } catch (error) { return jsonError(error); }
}

