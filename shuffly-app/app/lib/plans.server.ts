// DB-touching plan logic. The plan *definitions* themselves (PLANS, PlanId,
// planOf, annual pricing math) live in plans.ts, not here — the Plan
// page's own client-rendered UI needs those directly, and a `.server.ts`
// module can't be imported by client code. Re-exported below so existing
// `from "../lib/plans.server"` imports (loaders/actions) keep working.
import db from "../db.server";
import { defaultScheduleForPlan, planOf, undoRetentionCutoff, type PlanId } from "./plans";
import { scheduleWriteFields, nextRunFor } from "./schedule.server";
import { shopDefaultSchedule } from "./schedule-resolve";

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
  // Dropping to a schedule the new plan allows also drops the second time
  // slot, since only the top tier has one — scheduleWriteFields nulls it for
  // any non-TWICE_DAILY type, so that can't be forgotten here.
  const scheduleFields = scheduleWriteFields(new Date(), settings?.timezone ?? "UTC", {
    scheduleType: fallbackSchedule,
    scheduleTime,
    scheduleTime2: null,
    scheduleWeekday,
  });

  // The shop default has to be clamped too, and it is the more important of
  // the two: an inheriting collection stores NULL, so `scheduleType notIn
  // (...)` never matches it (SQL NULL is not "not in" anything). Without this
  // a shop downgrading from Pro would keep a TWICE_DAILY default, and every
  // collection following that default would go on shuffling twice a day on a
  // plan that doesn't allow it.
  const defaultDisallowed =
    settings != null && !plan.allowedSchedules.includes(settings.defaultScheduleType as (typeof plan.allowedSchedules)[number]);
  const clampedDefault = {
    defaultScheduleType: fallbackSchedule,
    defaultScheduleTime: scheduleTime,
    defaultScheduleTime2: null,
    defaultScheduleWeekday: scheduleWeekday,
  };
  // Everything inheriting is about to run at a different time, so its
  // advisory countdown is repaired in the same transaction.
  const inheriting = defaultDisallowed
    ? await db.collectionConfig.findMany({ where: { shop, scheduleType: null }, select: { id: true, status: true } })
    : [];
  const inheritedNextRunAt = nextRunFor(
    new Date(),
    settings?.timezone ?? "UTC",
    shopDefaultSchedule({ ...clampedDefault }),
  );

  await db.$transaction([
    ...(defaultDisallowed
      ? [
          db.shopSettings.update({ where: { shop }, data: clampedDefault }),
          ...inheriting.map((c) =>
            db.collectionConfig.update({
              where: { id: c.id },
              data: { nextRunAt: c.status === "RUNNING" ? inheritedNextRunAt : null },
            }),
          ),
        ]
      : []),
    ...(disallowed.length > 0
      ? [
          db.collectionConfig.updateMany({
            where: { id: { in: disallowed.map(({ id }) => id) } },
            data: scheduleFields,
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
