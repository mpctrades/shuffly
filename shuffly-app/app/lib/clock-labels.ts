// Wall-clock labels for instants, ALWAYS in the shop's timezone.
//
// Every schedule in Shuffly is a local time in the shop's timezone, so a
// label for "when the next run is" or "when the last run was" must be
// formatted in that timezone too — never in whatever timezone the code
// happens to run in. An Intl.DateTimeFormat without `timeZone` uses the
// runtime's own: UTC on the server, the merchant's laptop in the browser.
// That is how a 06:00 New York run came to read "18:00" on the Activity page
// for someone viewing from UTC+7 (and "11:00" in the server-rendered HTML).
// Both functions here take the timezone as a required argument for exactly
// that reason; clock-labels.test.ts guards the rest of app/ against it.

/** "06:00", the 24-hour wall clock of `instant` in `timeZone`. */
export function clockTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
}

/** "today at 06:00" / "tomorrow at 06:00" / "11/16 at 06:00", with the day
 * worked out in `timeZone` too — 01:00 UTC is still "today" in New York the
 * evening before. */
export function dayRelativeClockLabel(target: Date, timeZone: string, now: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const partsOf = (d: Date) =>
    dtf.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const t = partsOf(target);
  const n = partsOf(now);
  const time = `${t.hour}:${t.minute}`;
  const dayDiff = Math.round(
    (Date.UTC(Number(t.year), Number(t.month) - 1, Number(t.day)) - Date.UTC(Number(n.year), Number(n.month) - 1, Number(n.day))) /
      86_400_000,
  );
  const dayLabel = dayDiff === 0 ? "today" : dayDiff === 1 ? "tomorrow" : `${t.month}/${t.day}`;
  return `${dayLabel} at ${time}`;
}
