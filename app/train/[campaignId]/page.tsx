import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { campaigns, scenarios } from "@/db/schema";
import { serializePublicScenarioContent } from "@/lib/domain/content";
import { CampaignPlayer } from "./CampaignPlayer";

function serializeScenario(item: typeof scenarios.$inferSelect) {
  const contentJson = serializePublicScenarioContent(item);
  if (contentJson === null) return null;
  return {
    id: item.id,
    campaignId: item.campaignId,
    role: item.role,
    principle: item.principle,
    prompt: item.prompt,
    hint: item.hint,
    explanation: item.explanation,
    pitchJson: item.pitchJson,
    contentJson,
    orderIndex: item.orderIndex,
  };
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
