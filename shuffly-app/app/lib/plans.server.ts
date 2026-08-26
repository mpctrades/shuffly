// DB-touching plan logic. The plan *definitions* themselves (PLANS, PlanId,
// planOf, annual pricing math) live in plans.ts, not here — the Plan
// page's own client-rendered UI needs those directly, and a `.server.ts`
// module can't be imported by client code. Re-exported below so existing
// `from "../lib/plans.server"` imports (loaders/actions) keep working.
import db from "../db.server";
import { planOf, type PlanId } from "./plans";

export * from "./plans";

/** A plan change (upgrade, downgrade, or cancellation back to Free) took
 * effect — pause whichever currently-running collections no longer fit
 * under the new cap (oldest-tracked keep their spot), and log why. Returns
 * the titles of whatever got paused, for reference/logging. */
export async function enforcePlanCollectionCap(
  shop: string,
  planId: PlanId,
): Promise<string[]> {
  const plan = planOf(planId);
  if (plan.maxCollections === Infinity) return [];

  const running = await db.collectionConfig.findMany({
    where: { shop, status: "RUNNING" },
    orderBy: { createdAt: "asc" },
  });
  const toPause = running.slice(plan.maxCollections);
  if (toPause.length === 0) return [];

  await db.$transaction([
    db.collectionConfig.updateMany({
      where: { id: { in: toPause.map((c) => c.id) } },
      data: { status: "PAUSED", nextRunAt: null },
    }),
    ...toPause.map((c) =>
      db.shuffleRun.create({
        data: {
          shop,
          collectionId: c.id,
          trigger: "PAUSED",
          status: "OK",
          message: `${c.title} paused — over the ${plan.name} plan's collection limit`,
        },
      }),
    ),
  ]);
  return toPause.map((c) => c.title);
}
