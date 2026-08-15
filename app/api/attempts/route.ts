import { jsonError } from "@/lib/server/rooms";
import { recordAttempt } from "@/lib/server/training";
import { mapAttemptInputError, parseAttemptInput } from "@/lib/domain/content";

export async function POST(request: Request) {
  try {
    return Response.json(await recordAttempt(request, parseAttemptInput(await request.json())));
  } catch (error) {
    const inputError = mapAttemptInputError(error);
    return inputError ? Response.json({ error: inputError.error }, { status: inputError.status }) : jsonError(error);
  }
}
