// Inheritance, in one place.
//
// A collection does not store a copy of the shop's default schedule — it
// stores NOTHING, and this module answers "so what time does it actually
// run?" every time anyone asks. That is the whole point: the shop default can
// be changed later and every inheriting collection moves with it. The moment
// a default is copied onto collection rows, changing it stops propagating and
// the feature is dead.
//
// Plain `.ts`, not `.server.ts` — the Collections table and the schedule modal
// both need to render the effective schedule and its live "next run" preview
// client-side, and React Router refuses to let client code import a
// `.server.ts` module.
import { nextRunFor, type ScheduleType, type SlotSchedule } from "./schedule-core";

/** The four schedule columns as they sit on a CollectionConfig row. */
export interface ScheduleOverride {
  scheduleType: string | null;
  scheduleTime: string | null;
  scheduleTime2: string | null;
  scheduleWeekday: number | null;
}

/** The four default columns as they sit on a ShopSettings row. */
export interface ShopScheduleDefault {
  defaultScheduleType: string;
  defaultScheduleTime: string;
  defaultScheduleTime2: string | null;
  defaultScheduleWeekday: number | null;
}

/** True when this collection has its own schedule rather than following the
 * shop default. `scheduleType` is the single flag — see the schema comment
 * for why the other three can't be used for this. */
export function isOverridden(config: ScheduleOverride): boolean {
  return config.scheduleType != null;
}

/** The shop's default, as the shape the scheduling maths takes. */
export function shopDefaultSchedule(settings: ShopScheduleDefault): SlotSchedule {
  return {
    scheduleType: settings.defaultScheduleType as ScheduleType,
    scheduleTime: settings.defaultScheduleTime,
    scheduleTime2: settings.defaultScheduleTime2,
    scheduleWeekday: settings.defaultScheduleWeekday,
  };
}

/** What this collection actually runs on: its own schedule if it has one,
 * otherwise the shop default — resolved live, never cached onto the row.
 *
 * Every caller that used to build this object literal from `config.*` goes
 * through here, so there is exactly one definition of "effective schedule"
 * and the sweep, the countdown and the UI cannot disagree about it. */
export function resolveSchedule(config: ScheduleOverride, settings: ShopScheduleDefault): SlotSchedule {
  if (!isOverridden(config)) return shopDefaultSchedule(settings);
  return {
    scheduleType: config.scheduleType as ScheduleType,
    // Belt and braces: a row with a type but somehow no time still has to
    // produce a usable schedule rather than a crash at sweep time.
    scheduleTime: config.scheduleTime ?? settings.defaultScheduleTime,
    scheduleTime2: config.scheduleTime2,
    scheduleWeekday: config.scheduleWeekday,
  };
}

/** The four columns to write for an override, or all-null to go back to
 * inheriting. Keeping this next to the resolver is what stops a writer
 * somewhere from inventing a fifth way to say "follow the default". */
export function overrideWriteFields(schedule: SlotSchedule | null): ScheduleOverride {
  if (schedule == null) {
    return { scheduleType: null, scheduleTime: null, scheduleTime2: null, scheduleWeekday: null };
  }
  return {
    scheduleType: schedule.scheduleType,
    scheduleTime: schedule.scheduleTime,
    scheduleTime2: schedule.scheduleType === "TWICE_DAILY" ? (schedule.scheduleTime2 ?? null) : null,
    scheduleWeekday: schedule.scheduleType === "WEEKLY" ? (schedule.scheduleWeekday ?? null) : null,
  };
}

/** The schedule columns to write for a NEWLY tracked collection: none at all.
 *
 * A new collection has to START inheriting, or the shop default only ever
 * applies to collections that existed when the default was set — every
 * collection added afterwards would silently carry a frozen copy of whatever
 * the default happened to be that day, which is the exact failure this whole
 * model exists to prevent.
 *
 * `nextRunAt` is still derived here, from the shop default, because it is an
 * advisory cache the countdown reads before the first sweep touches the row.
 */
export function inheritScheduleFields(
  now: Date,
  timezone: string,
  settings: ShopScheduleDefault,
  status: "RUNNING" | "PAUSED" = "RUNNING",
) {
  return {
    scheduleType: null,
    scheduleTime: null,
    scheduleTime2: null,
    scheduleWeekday: null,
    nextRunAt: status === "RUNNING" ? nextRunFor(now, timezone, shopDefaultSchedule(settings)) : null,
  };
}
