import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { scenarios } from "@/db/schema";
import { assertReviewTransition, parseScenarioContent } from "@/lib/domain/content";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const expected = process.env.CONTENT_REVIEW_KEY;
  if (!expected || request.headers.get("x-review-key") !== expected) return Response.json({ error: "검수 권한이 필요해요." }, { status: 401 });
  const { status } = await request.json() as { status?: "draft" | "pending" | "reviewed" };
  if (!status || !["draft", "pending", "reviewed"].includes(status)) return Response.json({ error: "검수 상태가 올바르지 않아요." }, { status: 400 });
  const { id } = await context.params;
  if (status === "reviewed") {
    const scenario = await getDb().select({ contentJson: scenarios.contentJson }).from(scenarios).where(eq(scenarios.id, id)).get();
    if (!scenario) return Response.json({ error: "시나리오를 찾을 수 없어요." }, { status: 404 });
    if (scenario.contentJson.trim() === "") return Response.json({ error: "시나리오 구조화 콘텐츠가 필요합니다." }, { status: 409 });
    try {
      assertReviewTransition(status, parseScenarioContent(scenario.contentJson));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "시나리오 검수를 완료할 수 없습니다." }, { status: 409 });
    }
  }
  await getDb().update(scenarios).set({ reviewStatus: status }).where(eq(scenarios.id, id)).run();
  return Response.json({ id, reviewStatus: status });
}
