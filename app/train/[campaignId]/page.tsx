import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { campaigns, scenarios } from "@/db/schema";
import { CampaignPlayer } from "./CampaignPlayer";

export default async function TrainingPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const campaign = await getDb().select().from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.reviewStatus, "reviewed"))).get();
  if (!campaign) notFound();
  const items = await getDb().select().from(scenarios).where(and(eq(scenarios.campaignId, campaignId), eq(scenarios.reviewStatus, "reviewed"))).orderBy(asc(scenarios.orderIndex)).all();
  return <CampaignPlayer campaign={{ id: campaign.id, title: campaign.title }} scenarios={items.map((item) => ({ id: item.id, campaignId: item.campaignId, role: item.role, principle: item.principle, prompt: item.prompt, hint: item.hint, explanation: item.explanation, pitchJson: item.pitchJson, reviewStatus: item.reviewStatus, orderIndex: item.orderIndex }))} />;
}
