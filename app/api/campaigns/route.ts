import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { campaigns } from "@/db/schema";

export async function GET() {
  const items = await getDb().select({ id: campaigns.id, title: campaigns.title, formation: campaigns.formation }).from(campaigns).where(eq(campaigns.reviewStatus, "reviewed")).all();
  return Response.json({ campaigns: items });
}
