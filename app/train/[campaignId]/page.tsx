import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { campaigns, scenarios } from "@/db/schema";
import { serializePublicTrainingScenario } from "@/lib/domain/content";
import { CampaignPlayer } from "./CampaignPlayer";

function serializeScenario(item: typeof scenarios.$inferSelect) {
  return serializePublicTrainingScenario(item);
}

export default async function TrainingPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const campaign = await getDb().select().from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.reviewStatus, "reviewed"))).get();
  if (!campaign) notFound();
  const items = await getDb().select().from(scenarios).where(and(eq(scenarios.campaignId, campaignId), eq(scenarios.reviewStatus, "reviewed"))).orderBy(asc(scenarios.orderIndex)).all();
  const publicScenarios = items.flatMap((item) => {
    const serialized = serializeScenario(item);
    return serialized === null ? [] : [serialized];
  });
  return <CampaignPlayer campaign={{ id: campaign.id, title: campaign.title }} scenarios={publicScenarios} />;
}
