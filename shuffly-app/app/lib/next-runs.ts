// "When will this actually run?", answered three times over.
//
// The schedule modal used to show a single "Next run: …" line. One line can
// only ever prove the next occurrence is right; it can't show the *rhythm*,
// which is the thing a merchant is actually choosing when they pick a
// cadence. Three occurrences show the rhythm — and for TWICE_DAILY they show
// both slots, which a single line structurally could not.
//
// Pure, and deliberately in its own module rather than inline in the
// component: the modal recomputes this on every keystroke of the time
// picker, before anything is saved, so it has to be cheap and it has to be
// testable without a browser.
//
// Everything here delegates the hard part — turning a local wall clock into
// a real instant across a DST seam — to schedule-core's nextRunFor, the same
// function the cron sweep uses. So the preview cannot promise a time the
// sweep won't honour.
import { nextRunFor, startOfLocalDay, type SlotSchedule } from "./schedule-core";

/** How many occurrences the preview shows. */
export const PREVIEW_COUNT = 3;

/**
 * The next `count` instants this schedule fires at, in order.
 *
 * Empty for MANUAL, which has no automatic runs at all — the caller renders
 * that as a sentence rather than an empty list.
 *
 * Each step asks nextRunFor for the next occurrence strictly after the
 * previous one, so the walk can't stall on a repeated answer and doesn't
 * need its own calendar arithmetic (which is exactly where a second
 * implementation would drift from the sweep).
 */
export function nextRuns(
  now: Date,
  timezone: string,
  schedule: SlotSchedule,
  count: number = PREVIEW_COUNT,
): Date[] {
  const out: Date[] = [];
  let cursor = now;
  for (let i = 0; i < count; i++) {
    const next = nextRunFor(cursor, timezone, schedule);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * How many local days apart two instants are, in `timeZone`.
 *
 * Measured between local midnights, not by dividing the raw gap: a
 * spring-forward day is 23 hours long and a fall-back day is 25, so a naive
 * `/86_400_000` reports "in 0 days" for tomorrow across one seam and "in 2
 * days" across the other. Rounding the midnight-to-midnight difference is
 * exact for both.
 */
export function localDayDiff(target: Date, now: Date, timeZone: string): number {
  const a = startOfLocalDay(now, timeZone).getTime();
  const b = startOfLocalDay(target, timeZone).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** "today" / "tomorrow" / "in 4 days" / "in 2 weeks" — the right-aligned
 * label on each preview row. Day-relative, never hour-relative: "in 14h" is
 * a countdown, and a countdown is wrong the moment the modal has been open
 * for a minute. */
export function relativeDayLabel(target: Date, now: Date, timeZone: string): string {
  const days = localDayDiff(target, now, timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  const weeks = Math.round(days / 7);
  return `in ${weeks} weeks`;
}

/** "Tue 22 Sep 06:00", in the shop's own timezone. 24-hour, because every
 * time the merchant picks in this app is 24-hour.
 *
 * Assembled from parts rather than taken from a locale's own pattern: the
 * obvious `en-GB` spelling of this shape renders September as "Sept", which
 * is one character wider than every other month and visibly jogs the three
 * preview rows out of alignment. Parts also keep the order fixed, instead of
 * inheriting whatever day/month order a locale prefers.
 */
export function formatRunAt(target: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(target)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
}
