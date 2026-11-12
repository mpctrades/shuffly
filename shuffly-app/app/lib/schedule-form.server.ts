// The one parser for a posted schedule, used by every action that writes
// one: the collections list (per row, bulk, shop default), the collection
// card, the Workspace and Settings.
//
// Before Update 2 each of those four actions carried its own copy of this
// logic, and plan enforcement lived in those copies. With a fifth cadence
// (INTERVAL) and an interval value to validate, one copy is the only way to
// be sure every path rejects the same things: a Starter shop posting
// `scheduleType=INTERVAL&intervalHours=1` gets the same 403 whichever URL it
// hits.

import { isScheduleAllowed, planOf, timeSlots } from "./plans";
import {
  isIntervalHours,
  normalizeHhMm,
  slotsFarEnoughApart,
  type ScheduleType,
  type SlotSchedule,
} from "./schedule-core";

const SCHEDULE_TYPES: readonly ScheduleType[] = ["DAILY", "TWICE_DAILY", "WEEKLY", "MANUAL", "INTERVAL"];

export type ScheduleFormError =
  | "UNKNOWN_SCHEDULE"
  | "PLAN_SCHEDULE"
  | "BAD_INTERVAL"
  | "PLAN_SECOND_SLOT"
  | "SLOTS_TOO_CLOSE";

export type ScheduleFormResult =
  | { ok: true; schedule: SlotSchedule }
  | { ok: false; code: ScheduleFormError; error: string; status: 400 | 403 };

/**
 * Read a schedule out of a form post and check it against the shop's plan.
 *
 * `planId` must be the server's own record of the plan (ShopSettings.plan,
 * as last reconciled with Shopify Billing) — never anything the client sent.
 *
 * The returned schedule carries no interval anchor: the anchor depends on
 * what the collection was running before, which only the caller knows. Pass
 * it through `withIntervalAnchor` before writing.
 */
export function parseScheduleForm(
  formData: FormData,
  planId: string | null | undefined,
  fallbackType: ScheduleType = "WEEKLY",
): ScheduleFormResult {
  const rawType = String(formData.get("scheduleType") ?? fallbackType);
  if (!SCHEDULE_TYPES.includes(rawType as ScheduleType)) {
    return { ok: false, code: "UNKNOWN_SCHEDULE", error: "That isn't a schedule Shuffly knows.", status: 400 };
  }
  const scheduleType = rawType as ScheduleType;

  let intervalHours: number | null = null;
  if (scheduleType === "INTERVAL") {
    intervalHours = Number(formData.get("intervalHours"));
    // Checked before the plan, so "every 15 minutes" on Pro is a 400 (no
    // plan allows it), not a 403 that suggests upgrading would help.
    if (!isIntervalHours(intervalHours)) {
      return {
        ok: false,
        code: "BAD_INTERVAL",
        error: "Shuffles can run at most once an hour.",
        status: 400,
      };
    }
  }

  // A plan entitlement, enforced here and not only by the greyed-out
  // options: a hand-rolled POST must not be able to buy a cadence.
  if (!isScheduleAllowed(planId, scheduleType, intervalHours)) {
    return {
      ok: false,
      code: "PLAN_SCHEDULE",
      error: `Your ${planOf(planId).name} plan doesn't include that schedule.`,
      status: 403,
    };
  }

  const scheduleTime = normalizeHhMm(String(formData.get("scheduleTime") ?? "06:00"));
  const rawTime2 = formData.get("scheduleTime2");
  const scheduleTime2 =
    scheduleType === "TWICE_DAILY" && rawTime2 != null && rawTime2 !== "" ? normalizeHhMm(String(rawTime2)) : null;
  if (scheduleTime2 != null && timeSlots(planId) < 2) {
    return { ok: false, code: "PLAN_SECOND_SLOT", error: "Two shuffles a day is a Pro feature.", status: 403 };
  }
  if (scheduleTime2 != null && !slotsFarEnoughApart(scheduleTime, scheduleTime2)) {
    return {
      ok: false,
      code: "SLOTS_TOO_CLOSE",
      error: "Keep the two shuffle times at least an hour apart.",
      status: 400,
    };
  }

  const rawWeekday = formData.get("scheduleWeekday");
  const weekday = rawWeekday != null && rawWeekday !== "" ? Number(rawWeekday) : null;

  return {
    ok: true,
    schedule: {
      scheduleType,
      scheduleTime,
      scheduleTime2,
      scheduleWeekday:
        scheduleType === "WEEKLY" && weekday != null && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
          ? weekday
          : scheduleType === "WEEKLY"
            ? 1
            : null,
      intervalHours,
      intervalAnchorAt: null,
    },
  };
}

/**
 * Decide the anchor an interval schedule is written with.
 *
 *  - Same interval as the collection already runs on: keep its anchor. A
 *    merchant ticking a checkbox and saving must not push their next shuffle
 *    an hour into the future.
 *  - Anything else: anchor on the save moment ("hourly intervals start from
 *    the time the merchant saves"), plus `staggerMs` — which bulk writes use
 *    so 200 collections switched to "every hour" in one click don't all fire
 *    on the same minute.
 *
 * Non-interval schedules are returned unchanged.
 */
export function withIntervalAnchor(
  before: SlotSchedule | null,
  after: SlotSchedule,
  now: Date,
  staggerMs = 0,
): SlotSchedule {
  if (after.scheduleType !== "INTERVAL") return { ...after, intervalHours: null, intervalAnchorAt: null };
  const sameInterval =
    before?.scheduleType === "INTERVAL" &&
    before.intervalHours === after.intervalHours &&
    before.intervalAnchorAt != null;
  return {
    ...after,
    intervalAnchorAt: sameInterval ? before!.intervalAnchorAt! : new Date(now.getTime() + staggerMs),
  };
}

/** Bulk writes spread their anchors this far apart, wrapping every 10
 * minutes — enough to keep a big shop's collections off the same minute
 * without making any of them visibly late. */
export function bulkStaggerMs(index: number): number {
  return (index % 10) * 60_000;
}
