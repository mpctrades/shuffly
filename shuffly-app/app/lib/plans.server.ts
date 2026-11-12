// DB-touching plan logic. The plan *definitions* themselves (PLANS, PlanId,
// planOf, annual pricing math) live in plans.ts, not here — the Plan
// page's own client-rendered UI needs those directly, and a `.server.ts`
// module can't be imported by client code. Re-exported below so existing
// `from "../lib/plans.server"` imports (loaders/actions) keep working.
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { defaultScheduleForPlan, isScheduleAllowed, planOf, undoRetentionCutoff, type PlanId } from "./plans";
import { localHhMm, nextRunFor, type SlotSchedule } from "./schedule.server";
import {
  overrideWriteFields,
  resolveSchedule,
  shopDefaultSchedule,
  shopDefaultWriteFields,
  type ShopScheduleDefault,
} from "./schedule-resolve";

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

/** A schedule as the plan notice records it: plain data, rendered in the
 * merchant's language by the UI rather than stored as English. */
export interface NoticeSchedule {
  type: string;
  time?: string | null;
  time2?: string | null;
  weekday?: number | null;
  intervalHours?: number | null;
}

export interface PlanNoticeChange {
  collectionId: string | null; // null = the shop default schedule
  title: string;
  from?: NoticeSchedule;
  to?: NoticeSchedule;
  reshuffleOnNewOff?: boolean;
  keepNewOnTopOff?: boolean;
  pinsCleared?: boolean;
}

export interface PlanNotice {
  from: PlanId;
  to: PlanId;
  at: string;
  changes: PlanNoticeChange[];
}

function noticeSchedule(s: SlotSchedule): NoticeSchedule {
  return {
    type: s.scheduleType,
    time: s.scheduleType === "INTERVAL" || s.scheduleType === "MANUAL" ? null : s.scheduleTime,
    time2: s.scheduleType === "TWICE_DAILY" ? (s.scheduleTime2 ?? null) : null,
    weekday: s.scheduleType === "WEEKLY" ? s.scheduleWeekday : null,
    intervalHours: s.scheduleType === "INTERVAL" ? (s.intervalHours ?? null) : null,
  };
}

/**
 * The best schedule `planId` allows in place of `current` (Update 2 rules):
 * Starter falls back to Daily, Free to Weekly, keeping the time of day the
 * collection already had. An hourly schedule has no time of day of its own,
 * so it keeps the local time its interval was anchored on.
 */
export function fallbackSchedule(planId: PlanId, current: SlotSchedule, timezone: string): SlotSchedule {
  const type = defaultScheduleForPlan(planId);
  const time =
    current.scheduleType === "INTERVAL" && current.intervalAnchorAt
      ? localHhMm(current.intervalAnchorAt, timezone)
      : current.scheduleTime;
  return {
    scheduleType: type,
    scheduleTime: time,
    scheduleTime2: null,
    scheduleWeekday: type === "WEEKLY" ? (current.scheduleType === "WEEKLY" ? (current.scheduleWeekday ?? 1) : 1) : null,
    intervalHours: null,
    intervalAnchorAt: null,
  };
}

/**
 * Bring persisted settings back inside the active plan after a plan change.
 * New writes are validated in parseScheduleForm; this handles settings that
 * were valid on the old plan:
 *
 *  - each collection's schedule (and the shop default) falls back to the
 *    best cadence the new plan allows, keeping its time of day;
 *  - Pro's new-arrivals options (reshuffle on new products, keep new on top)
 *    are switched off;
 *  - pins go when the plan can't pin (unchanged rule);
 *  - and everything that changed is written to a dismissible notice and the
 *    Activity log, so the merchant isn't left guessing why a collection
 *    stopped shuffling hourly.
 *
 * Collection-count caps are handled separately (enforcePlanCollectionCap)
 * and are unchanged by Update 2.
 */
export async function enforcePlanEntitlements(shop: string, planId: PlanId, previousPlanId?: PlanId): Promise<PlanNotice | null> {
  const plan = planOf(planId);
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const now = new Date();
  const timezone = settings?.timezone ?? "UTC";
  const scheduleDefaults = settings ?? {
    defaultScheduleType: "WEEKLY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: 1,
  };

  // An upgrade only ever adds choices: nothing to clamp, and any old
  // downgrade notice is now out of date.
  if (previousPlanId && planOf(previousPlanId).price < plan.price) {
    if (settings?.planNotice) {
      await db.shopSettings.update({ where: { shop }, data: { planNotice: null, planNoticeDismissedAt: null } });
    }
    return null;
  }

  const allowed = (s: SlotSchedule) => isScheduleAllowed(planId, s.scheduleType, s.intervalHours);
  const changes: PlanNoticeChange[] = [];
  const writes: Prisma.PrismaPromise<unknown>[] = [];

  // The shop default first: an inheriting collection stores NULL, so it is
  // only brought inside the plan by clamping the default it follows.
  const currentDefault = shopDefaultSchedule(scheduleDefaults);
  let defaultsAfter: ShopScheduleDefault = scheduleDefaults;
  if (settings && !allowed(currentDefault)) {
    const next = fallbackSchedule(planId, currentDefault, timezone);
    const fields = shopDefaultWriteFields(next);
    defaultsAfter = { ...scheduleDefaults, ...fields };
    writes.push(db.shopSettings.update({ where: { shop }, data: fields }));
    changes.push({ collectionId: null, title: "Shop default schedule", from: noticeSchedule(currentDefault), to: noticeSchedule(next) });
  }

  const collections = await db.collectionConfig.findMany({ where: { shop } });
  for (const c of collections) {
    const change: PlanNoticeChange = { collectionId: c.id, title: c.title };
    const data: Prisma.CollectionConfigUpdateInput = {};
    let activity: string | null = null;

    if (c.scheduleType != null) {
      const own = resolveSchedule(c, scheduleDefaults);
      if (!allowed(own)) {
        const next = fallbackSchedule(planId, own, timezone);
        Object.assign(data, overrideWriteFields(next), {
          nextRunAt: c.status === "RUNNING" ? nextRunFor(now, timezone, next) : null,
          // So the sweep reads this as "just reconfigured", not a missed run.
          scheduleUpdatedAt: now,
        });
        change.from = noticeSchedule(own);
        change.to = noticeSchedule(next);
        activity = `${scheduleText(own)} → ${scheduleText(next)}`;
      }
    } else if (defaultsAfter !== scheduleDefaults) {
      // Inheriting: its countdown moves with the clamped default.
      data.nextRunAt = c.status === "RUNNING" ? nextRunFor(now, timezone, resolveSchedule(c, defaultsAfter)) : null;
      data.scheduleUpdatedAt = now;
    }

    if (!plan.newArrivalsFeatures && (c.reshuffleOnNew || c.keepNewOnTop)) {
      data.reshuffleOnNew = false;
      data.keepNewOnTop = false;
      change.reshuffleOnNewOff = c.reshuffleOnNew || undefined;
      change.keepNewOnTopOff = c.keepNewOnTop || undefined;
    }
    if (!plan.canPin && c.pins > 0) {
      data.pins = 0;
      change.pinsCleared = true;
    }

    if (Object.keys(data).length === 0) continue;
    writes.push(db.collectionConfig.update({ where: { id: c.id }, data }));
    if (change.from || change.reshuffleOnNewOff || change.keepNewOnTopOff || change.pinsCleared) {
      changes.push(change);
      writes.push(
        db.shuffleRun.create({
          data: {
            shop,
            collectionId: c.id,
            trigger: "SCHEDULE_CHANGED",
            status: "OK",
            messageCode: "PLAN_DOWNGRADE",
            messageParams: JSON.stringify({ plan: planId, ...change, title: undefined, collectionId: undefined }),
            message: `Changed for the ${plan.name} plan${activity ? `: ${activity}` : ""}${
              change.reshuffleOnNewOff || change.keepNewOnTopOff ? " · new-arrivals options turned off" : ""
            }`,
          },
        }),
      );
    }
  }

  const notice: PlanNotice | null =
    changes.length > 0 ? { from: previousPlanId ?? planId, to: planId, at: now.toISOString(), changes } : null;
  if (notice) {
    writes.push(
      db.shopSettings.update({ where: { shop }, data: { planNotice: JSON.stringify(notice), planNoticeDismissedAt: null } }),
    );
  }
  if (writes.length > 0) await db.$transaction(writes);
  return notice;
}

/** English fallback for the Activity `message` column. */
function scheduleText(s: SlotSchedule): string {
  switch (s.scheduleType) {
    case "INTERVAL":
      return s.intervalHours === 1 ? "every hour" : `every ${s.intervalHours} hours`;
    case "TWICE_DAILY":
      return "twice daily";
    case "DAILY":
      return `daily at ${s.scheduleTime}`;
    case "WEEKLY":
      return `weekly at ${s.scheduleTime}`;
    default:
      return "manual only";
  }
}

/** pruneExpiredUndoSnapshots for every shop — run by each scheduler sweep,
 * so a plan's retention window holds for shops whose merchant never opens
 * the app, not only when a page happens to load. */
export async function pruneExpiredUndoSnapshotsForAllShops(now = new Date()): Promise<number> {
  const shops = await db.shopSettings.findMany({ select: { shop: true, plan: true } });
  let pruned = 0;
  for (const { shop, plan } of shops) {
    pruned += await pruneExpiredUndoSnapshots(shop, planOf(plan).id, now);
  }
  return pruned;
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
