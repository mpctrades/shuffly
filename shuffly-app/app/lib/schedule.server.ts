// Timezone-aware "when should this collection run next" math, using only
// Intl (no extra date library). All schedules are expressed as a local wall
// clock time in the shop's IANA timezone (from Shop.ianaTimezone).

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

/**
 * Given "now", a schedule, and the shop's timezone, return the next UTC
 * instant this collection should shuffle. Returns null for MANUAL schedules
 * (they only ever run when the merchant presses "Shuffle now").
 */
export function computeNextRun(
  now: Date,
  timezone: string,
  scheduleType: ScheduleType,
  scheduleTime: string, // "HH:MM"
  scheduleWeekday: number | null, // 0=Sunday..6=Saturday, WEEKLY only
): Date | null {
  if (scheduleType === "MANUAL") return null;

  const [hh, mm] = scheduleTime.split(":").map((n) => parseInt(n, 10));
  const hour = Number.isFinite(hh) ? hh : 6;
  const minute = Number.isFinite(mm) ? mm : 0;
  const local = localPartsInTz(now, timezone);

  const candidateTimes: Array<{ hour: number; minute: number }> =
    scheduleType === "TWICE_DAILY"
      ? [
          { hour, minute },
          { hour: (hour + 12) % 24, minute },
        ].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
      : [{ hour, minute }];

  // Walk forward day by day (up to 8 days covers weekly + DST edge cases)
  // until we find the first candidate strictly after `now`.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const dayGuess = new Date(now.getTime() + dayOffset * 86_400_000);
    const dp = localPartsInTz(dayGuess, timezone);

    if (scheduleType === "WEEKLY" && scheduleWeekday != null && dp.weekday !== scheduleWeekday) {
      continue;
    }

    for (const t of candidateTimes) {
      const instant = utcInstantFor(dp.year, dp.month, dp.day, t.hour, t.minute, timezone);
      if (instant.getTime() > now.getTime()) {
        // Re-derive using local's own Y/M/D (dp already reflects dayOffset's local date)
        return instant;
      }
    }
    // fall through: none of today's/this-day's candidate times are still ahead of now
    void local;
  }

  // Fallback (shouldn't happen): tomorrow at the first candidate time.
  const tomorrow = localPartsInTz(new Date(now.getTime() + 86_400_000), timezone);
  return utcInstantFor(tomorrow.year, tomorrow.month, tomorrow.day, candidateTimes[0].hour, candidateTimes[0].minute, timezone);
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
