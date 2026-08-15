import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { scenarios } from "@/db/schema";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const expected = process.env.CONTENT_REVIEW_KEY;
  if (!expected || request.headers.get("x-review-key") !== expected) return Response.json({ error: "검수 권한이 필요해요." }, { status: 401 });
  const { status } = await request.json() as { status?: "draft" | "pending" | "reviewed" };
  if (!status || !["draft", "pending", "reviewed"].includes(status)) return Response.json({ error: "검수 상태가 올바르지 않아요." }, { status: 400 });
  const { id } = await context.params;
  await getDb().update(scenarios).set({ reviewStatus: status }).where(eq(scenarios.id, id)).run();
  return Response.json({ id, reviewStatus: status });
}

