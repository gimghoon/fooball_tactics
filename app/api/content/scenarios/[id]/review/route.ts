import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { scenarios } from "@/db/schema";
import { handleReviewRequest } from "@/lib/server/scenario-review-route";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleReviewRequest(request, context, {
    env: process.env,
    now: () => new Date(),
    findScenario: async (id) => getDb()
      .select({ contentJson: scenarios.contentJson })
      .from(scenarios)
      .where(eq(scenarios.id, id))
      .get(),
    updateScenario: async (id, values) => {
      await getDb().update(scenarios).set(values).where(eq(scenarios.id, id)).run();
    },
  });
}
