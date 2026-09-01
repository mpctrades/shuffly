// DB-touching plan logic. The plan *definitions* themselves (PLANS, PlanId,
// planOf, annual pricing math) live in plans.ts, not here — the Plan
// page's own client-rendered UI needs those directly, and a `.server.ts`
// module can't be imported by client code. Re-exported below so existing
// `from "../lib/plans.server"` imports (loaders/actions) keep working.
import db from "../db.server";
import { defaultScheduleForPlan, planOf, undoRetentionCutoff, type PlanId } from "./plans";
import { computeNextRun } from "./schedule.server";

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

/** Bring persisted collection settings back inside the active plan after a
 * downgrade. New writes are validated in their route actions; this handles
 * settings that were valid on the old plan. */
export async function enforcePlanEntitlements(shop: string, planId: PlanId): Promise<void> {
  const plan = planOf(planId);
  const fallbackSchedule = defaultScheduleForPlan(planId);
  const [disallowed, settings] = await Promise.all([
    db.collectionConfig.findMany({
      where: { shop, scheduleType: { notIn: plan.allowedSchedules } },
      select: { id: true },
    }),
    db.shopSettings.findUnique({ where: { shop } }),
  ]);
  const scheduleTime = settings?.defaultRunTime ?? "06:00";
  const scheduleWeekday = fallbackSchedule === "WEEKLY" ? 1 : null;
  const nextRunAt = settings
    ? computeNextRun(
        new Date(),
        settings.timezone,
        fallbackSchedule,
        scheduleTime,
        scheduleWeekday,
      )
    : null;

  await db.$transaction([
    ...(disallowed.length > 0
      ? [
          db.collectionConfig.updateMany({
            where: { id: { in: disallowed.map(({ id }) => id) } },
            data: {
              scheduleType: fallbackSchedule,
              scheduleTime,
              scheduleWeekday,
              nextRunAt,
            },
          }),
        ]
      : []),
    ...(!plan.canPin
      ? [
          db.collectionConfig.updateMany({
            where: { shop, pins: { gt: 0 } },
            data: { pins: 0 },
          }),
        ]
      : []),
  ]);
}

/** Remove reversible order snapshots after the active plan's retention
 * window. The run record remains available as activity history. */
export async function pruneExpiredUndoSnapshots(
  shop: string,
  planId: PlanId,
  now = new Date(),
): Promise<number> {
  const result = await db.shuffleRun.updateMany({
    where: {
      shop,
      trigger: { in: ["SCHEDULED", "MANUAL"] },
      createdAt: { lt: undoRetentionCutoff(planId, now) },
      previousOrder: { not: null },
    },
    data: { previousOrder: null },
  });
  return result.count;
}
