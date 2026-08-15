import { jsonError } from "@/lib/server/rooms";
import { teamProgress } from "@/lib/server/training";

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  try { return Response.json(await teamProgress(request, (await context.params).code)); }
  catch (error) { return jsonError(error); }
}

