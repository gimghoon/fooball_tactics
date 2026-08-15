import { jsonError } from "@/lib/server/rooms";
import { saveReflection } from "@/lib/server/training";

export async function POST(request: Request) {
  try { return Response.json(await saveReflection(request, await request.json() as { missionId: string; result: "worked" | "difficult"; note?: string }), { status: 201 }); }
  catch (error) { return jsonError(error); }
}
