import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { campaigns, scenarios } from "@/db/schema";
import { serializePublicTrainingScenario } from "@/lib/domain/content";

function serializeScenario(item: typeof scenarios.$inferSelect) {
  return serializePublicTrainingScenario(item);
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const campaign = await getDb().select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.reviewStatus, "reviewed"))).get();
  if (!campaign) return Response.json({ error: "공개된 캠페인이 아니에요." }, { status: 404 });
  const items = await getDb().select().from(scenarios).where(and(eq(scenarios.campaignId, id), eq(scenarios.reviewStatus, "reviewed"))).orderBy(asc(scenarios.orderIndex)).all();
  return Response.json({ campaign, scenarios: items.flatMap((item) => {
    const serialized = serializeScenario(item);
    return serialized === null ? [] : [serialized];
  }) });
}
