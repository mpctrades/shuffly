// Timezone-aware "when should this collection run next" math, using only
// Intl (no extra date library). All schedules are expressed as a local wall
// clock time in the shop's IANA timezone (from Shop.ianaTimezone).

import { defaultSecondSlot, normalizeHhMm, parseHhMm } from "./time-slots";

// Re-exported so server-side callers can keep importing it from here.
export { normalizeHhMm };

export type ScheduleType = "DAILY" | "TWICE_DAILY" | "WEEKLY" | "MANUAL";

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sunday..6=Saturday
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localPartsInTz(instant: Date, timeZone: string): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(instant).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Offset in minutes such that `localWallClockMs = utcMs + offsetMinutes*60000`. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const p = localPartsInTz(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60000;
}

/** Build the UTC instant for a given local Y/M/D + HH:MM wall clock time in `timeZone`. */
function utcInstantFor(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  // First guess using an offset computed near that date (noon UTC avoids DST-edge weirdness).
  const guess = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offset = tzOffsetMinutes(guess, timeZone);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - offset * 60000);
}

export interface SlotSchedule {
  scheduleType: ScheduleType;
  /** "HH:MM" local time — the first (or only) slot. */
  scheduleTime: string;
  /** "HH:MM" local time for the second slot. Only meaningful for
   * TWICE_DAILY; null means "derive it", which is what pre-Update-1 rows
   * relied on. */
  scheduleTime2?: string | null;
  scheduleWeekday: number | null; // 0=Sunday..6=Saturday, WEEKLY only
}

/** What happened when a wall-clock time was turned into a real instant.
 * Both non-"exact" cases only ever occur on a DST transition day. */
export type LocalTimeResolution =
  /** The requested wall clock exists exactly once that day. */
  | "exact"
  /** Fall-back day: it happens twice, and we deliberately took the first. */
  | "ambiguous"
  /** Spring-forward day: it never happens, so we took the moment the clock
   * jumped past it. */
  | "skipped";

/** A local Y/M/D + H:M rendered as a comparable stamp, so two wall clocks
 * can be ordered without caring which offset produced them. */
function localStamp(instant: Date, timeZone: string): number {
  const p = localPartsInTz(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
}

/**
 * Turn a local wall-clock time into the UTC instant it actually happens at,
 * handling both DST edges explicitly instead of hoping a mid-day offset
 * guess lands right:
 *
 *   - Normal day: exactly one instant matches. Return it.
 *   - Fall-back day (e.g. 01:30 in America/New_York on 1 Nov): the wall
 *     clock happens twice, an hour apart. Always return the FIRST, so the
 *     answer is identical on every sweep and the second occurrence can never
 *     be mistaken for a separate run.
 *   - Spring-forward day (e.g. 02:30 in America/New_York on 8 Mar): the wall
 *     clock never happens. Return the instant the clock jumps past it
 *     (03:00 local), so the run still fires once that day and never *early* —
 *     the old mid-day-offset guess resolved it to 01:30, an hour before the
 *     merchant asked for.
 */
export function resolveLocalTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): { at: Date; resolution: LocalTimeResolution } {
  const pseudoUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  // The offset in force can change *within* this local day, so try the one
  // from either side of it rather than a single sample.
  const offsets = Array.from(
    new Set([
      tzOffsetMinutes(new Date(pseudoUtc - 86_400_000), timeZone),
      tzOffsetMinutes(new Date(pseudoUtc + 86_400_000), timeZone),
    ]),
  );

  const matches = offsets
    .map((offset) => new Date(pseudoUtc - offset * 60_000))
    .filter((instant) => localStamp(instant, timeZone) === pseudoUtc)
    .sort((a, b) => a.getTime() - b.getTime());

  if (matches.length === 1) return { at: matches[0], resolution: "exact" };
  if (matches.length > 1) return { at: matches[0], resolution: "ambiguous" };

  // Nothing matched: the requested wall clock falls inside a spring-forward
  // gap. Binary-search the (at most ~2h) window the transition must lie in
  // for the first instant whose local time has reached the requested one.
  let low = pseudoUtc - Math.max(...offsets) * 60_000;
  let high = pseudoUtc - Math.min(...offsets) * 60_000;
  while (high - low > 60_000) {
    const mid = low + Math.floor((high - low) / 2 / 60_000) * 60_000;
    if (mid <= low) break;
    if (localStamp(new Date(mid), timeZone) >= pseudoUtc) high = mid;
    else low = mid;
  }
  const at = localStamp(new Date(low), timeZone) >= pseudoUtc ? new Date(low) : new Date(high);
  return { at, resolution: "skipped" };
}

/**
 * The time slots this schedule actually has, as { slot index, "HH:MM" }.
 *
 * The slot index is tied to the *field* (0 = scheduleTime, 1 = scheduleTime2),
 * never to chronological order — that keeps a slot's identity stable when a
 * merchant edits one of the two times, so re-ordering 09:00/18:00 to
 * 18:00/09:00 can't make an already-fired slot look unfired.
 */
export function slotTimesFor(schedule: SlotSchedule): Array<{ slot: number; time: string }> {
  if (schedule.scheduleType === "MANUAL") return [];
  const first = { slot: 0, time: normalizeHhMm(schedule.scheduleTime) };
  if (schedule.scheduleType !== "TWICE_DAILY") return [first];
  // Null scheduleTime2 = a row from before merchants could pick the second
  // slot, which derived it as +12h. The migration backfilled these, so this
  // is belt-and-braces for anything written outside it.
  const second = {
    slot: 1,
    time: normalizeHhMm(schedule.scheduleTime2 ?? defaultSecondSlot(first.time)),
  };
  // Both slots on the same minute is one run, not two.
  return second.time === first.time ? [first] : [first, second];
}

/** How late a slot may still run. Long enough to ride out a deploy or a
 * short outage, short enough that a container down overnight never wakes up
 * and fires hours of backlog at once — past this the slot is missed, and
 * the sweep says so rather than running it. */
export const GRACE_WINDOW_MS = 2 * 3_600_000;

/** Two slots on one collection have to be at least this far apart. Runs
 * serialize per collection (overlapping reorders throw
 * TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS), so slots minutes apart would just
 * queue behind each other and report confusing times. */
export const MIN_SLOT_GAP_MS = 3_600_000;

/** Whether two "HH:MM" slots are far enough apart to both be useful. */
export function slotsFarEnoughApart(first: string, second: string): boolean {
  const a = parseHhMm(first);
  const b = parseHhMm(second);
  const minutes = Math.abs((a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
  // Compare across midnight too: 23:30 and 00:15 are 45 minutes apart.
  const gap = Math.min(minutes, 1440 - minutes);
  return gap * 60_000 >= MIN_SLOT_GAP_MS;
}

export interface DueSlot {
  slot: number;
  /** "YYYY-MM-DD" of the slot's own local day — half of the idempotency key. */
  dateKey: string;
  /** The UTC instant this slot resolved to. */
  at: Date;
  resolution: LocalTimeResolution;
  /** True when the slot's time has already passed by more than a sweep
   * interval — it is running inside the grace window, not on time, and the
   * run record says so. */
  late: boolean;
}

/** A slot whose time has passed by more than the grace window. Reported so
 * the sweep can log it as missed instead of silently running it late or
 * silently doing nothing. */
export interface MissedSlot {
  slot: number;
  dateKey: string;
  at: Date;
}

/**
 * Which of this collection's slots are due right now, decided from the
 * schedule as it is stored *at this moment*. This is what makes a merchant's
 * time change take effect immediately: nothing is queued ahead of time, so
 * there is never a leftover run pointing at the old time.
 *
 * `scheduleUpdatedAt` is what stops a change from back-firing. A slot whose
 * time has already passed looks identical whether the worker was down or the
 * merchant just moved that slot into the past — the only thing telling them
 * apart is whether the schedule changed after the slot was due. So the grace
 * window is honoured only for slots due *after* the last schedule change;
 * anything earlier is treated as never having been scheduled at that time
 * at all, and the next run is the next future occurrence.
 */
export function dueSlots(
  now: Date,
  timezone: string,
  schedule: SlotSchedule,
  scheduleUpdatedAt: Date | null = null,
  graceMs = GRACE_WINDOW_MS,
): { due: DueSlot[]; missed: MissedSlot[] } {
  const slots = slotTimesFor(schedule);
  if (slots.length === 0) return { due: [], missed: [] };

  const due: DueSlot[] = [];
  const missed: MissedSlot[] = [];

  // Today and yesterday, in the shop's own local terms: a slot late in the
  // local evening is still inside the grace window shortly after local
  // midnight has rolled the date over.
  for (const dayOffset of [0, -1]) {
    const p = localPartsInTz(new Date(now.getTime() + dayOffset * 86_400_000), timezone);
    if (
      schedule.scheduleType === "WEEKLY" &&
      schedule.scheduleWeekday != null &&
      p.weekday !== schedule.scheduleWeekday
    ) {
      continue;
    }
    const dateKey = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    for (const { slot, time } of slots) {
      const { hour, minute } = parseHhMm(time);
      const { at, resolution } = resolveLocalTime(p.year, p.month, p.day, hour, minute, timezone);
      const age = now.getTime() - at.getTime();
      if (age < 0) continue; // still ahead of us

      // The merchant moved this slot to a time that had already passed
      // today. Not a missed run and not a catch-up — it simply was never
      // scheduled for that moment. Next run is the next future occurrence.
      if (scheduleUpdatedAt && at.getTime() < scheduleUpdatedAt.getTime()) continue;

      if (age <= graceMs) {
        due.push({ slot, dateKey, at, resolution, late: age > SWEEP_TOLERANCE_MS });
      } else if (dayOffset === 0) {
        // Only today's local day is reported as missed. Yesterday's slots are
        // scanned purely so a late-evening one is still catchable just after
        // local midnight — a slot that went unrun yesterday must not produce a
        // fresh "missed" record on every sweep from here on.
        missed.push({ slot, dateKey, at });
      }
    }
  }
  return {
    due: due.sort((a, b) => a.at.getTime() - b.at.getTime()),
    missed: missed.sort((a, b) => a.at.getTime() - b.at.getTime()),
  };
}

/** A run starting within this of its slot time counts as on time — the sweep
 * only polls every 60s, so a slot is essentially never hit to the second. */
const SWEEP_TOLERANCE_MS = 5 * 60_000;

/**
 * The next UTC instant this collection should shuffle. Null for MANUAL.
 *
 * This is now a *display and prefilter* value, not the scheduling decision —
 * `dueSlots` is what the cron sweep actually acts on. It still drives the
 * "next run in 4h 12m" countdown, and it keeps the sweep's candidate query
 * index-backed instead of scanning every RUNNING collection.
 */
export function nextRunFor(now: Date, timezone: string, schedule: SlotSchedule): Date | null {
  const slots = slotTimesFor(schedule);
  if (slots.length === 0) return null;

  // 8 days covers weekly, plus any DST edge that shifts a day boundary.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const p = localPartsInTz(new Date(now.getTime() + dayOffset * 86_400_000), timezone);
    if (
      schedule.scheduleType === "WEEKLY" &&
      schedule.scheduleWeekday != null &&
      p.weekday !== schedule.scheduleWeekday
    ) {
      continue;
    }
    const ahead = slots
      .map(({ time }) => {
        const { hour, minute } = parseHhMm(time);
        return resolveLocalTime(p.year, p.month, p.day, hour, minute, timezone).at;
      })
      .filter((at) => at.getTime() > now.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    if (ahead.length > 0) return ahead[0];
  }
  return null;
}

/**
 * The one place a schedule change becomes database fields. Every write that
 * touches a schedule goes through this, so `nextRunAt` cannot be left behind
 * pointing at a time the merchant has already changed — the failure mode of
 * having this recomputed by hand at a dozen separate call sites.
 */
export function scheduleWriteFields(
  now: Date,
  timezone: string,
  schedule: SlotSchedule,
  status: "RUNNING" | "PAUSED" = "RUNNING",
) {
  const normalized: SlotSchedule = {
    scheduleType: schedule.scheduleType,
    scheduleTime: normalizeHhMm(schedule.scheduleTime),
    scheduleTime2:
      schedule.scheduleType === "TWICE_DAILY" && schedule.scheduleTime2
        ? normalizeHhMm(schedule.scheduleTime2)
        : null,
    scheduleWeekday: schedule.scheduleWeekday,
  };
  return {
    scheduleType: normalized.scheduleType,
    scheduleTime: normalized.scheduleTime,
    scheduleTime2: normalized.scheduleTime2,
    scheduleWeekday: normalized.scheduleWeekday,
    nextRunAt: status === "RUNNING" ? nextRunFor(now, timezone, normalized) : null,
  };
}

/**
 * Back-compatible 5-argument wrapper around `nextRunFor`, kept because most
 * callers only ever had one time to give it.
 */
export function computeNextRun(
  now: Date,
  timezone: string,
  scheduleType: ScheduleType,
  scheduleTime: string, // "HH:MM"
  scheduleWeekday: number | null, // 0=Sunday..6=Saturday, WEEKLY only
  scheduleTime2: string | null = null,
): Date | null {
  return nextRunFor(now, timezone, { scheduleType, scheduleTime, scheduleTime2, scheduleWeekday });
}

export function formatNextRun(nextRunAt: Date | null, timezone: string): string {
  if (!nextRunAt) return "Only when you press Shuffle";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(nextRunAt);
}

/** The wall-clock hour (0-23) `instant` falls on in `timeZone` — used to pick
 * a "Morning/Afternoon/Evening" label for grouped Activity feed entries. */
export function getLocalHour(instant: Date, timeZone: string): number {
  return localPartsInTz(instant, timeZone).hour;
}

/** "UTC+7" / "UTC-5" / "UTC+5:30" — for showing an IANA timezone name with
 * its current offset, e.g. "Asia/Phnom_Penh (UTC+7)" on the Settings page. */
export function timezoneOffsetLabel(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(at);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  return raw.replace("GMT", "UTC");
}

/** Activity feed timestamp, in the shop's timezone: "Today 06:00",
 * "Yesterday 14:22", then "20 Aug 06:00". Still used by the Workspace
 * history tab (app.collections.$id.tsx) — kept as-is; the Activity feed
 * itself uses activityDayAndTime below instead, which splits this same
 * logic into a separate day heading + time-only row label. */
export function formatActivityTimestamp(instant: Date, timeZone: string, now: Date): string {
  const t = localPartsInTz(instant, timeZone);
  const n = localPartsInTz(now, timeZone);
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  const dayDiff = Math.round(
    (Date.UTC(n.year, n.month - 1, n.day) - Date.UTC(t.year, t.month - 1, t.day)) / 86_400_000,
  );
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Yesterday ${time}`;
  const month = new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(instant);
  return `${t.day} ${month} ${time}`;
}

/** Same day-relative logic as formatActivityTimestamp, but split into a
 * grouping key + heading label ("Today" / "Yesterday" / "20 August", full
 * month name for a day heading) and a time-only row label ("06:00") — for
 * the Activity feed's day-grouped, compact-row layout. */
export function activityDayAndTime(
  instant: Date,
  timeZone: string,
  now: Date,
): { dayKey: string; dayLabel: string; time: string } {
  const t = localPartsInTz(instant, timeZone);
  const n = localPartsInTz(now, timeZone);
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  const dayKey = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  const dayDiff = Math.round(
    (Date.UTC(n.year, n.month - 1, n.day) - Date.UTC(t.year, t.month - 1, t.day)) / 86_400_000,
  );
  const dayLabel =
    dayDiff === 0
      ? "Today"
      : dayDiff === 1
        ? "Yesterday"
        : `${t.day} ${new Intl.DateTimeFormat("en-US", { timeZone, month: "long" }).format(instant)}`;
  return { dayKey, dayLabel, time };
}

/** The UTC instant for local midnight, today, in `timeZone` — the lower
 * bound for "today"-scoped queries (the Activity feed's "N runs today"
 * subtitle stat). */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const p = localPartsInTz(instant, timeZone);
  return utcInstantFor(p.year, p.month, p.day, 0, 0, timeZone);
}
