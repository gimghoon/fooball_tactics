import { jsonError } from "@/lib/server/rooms";
import { recordAttempt } from "@/lib/server/training";
import { parseAttemptInput } from "@/lib/domain/content";

export async function POST(request: Request) {
  try {
    return Response.json(await recordAttempt(request, parseAttemptInput(await request.json())));
  } catch (error) { return jsonError(error); }
}
