// Pure "HH:MM" helpers and the option list behind the shuffle-time pickers.
//
// Deliberately NOT a `.server.ts` file, for the same reason plans.ts isn't:
// the collection Workspace and the Settings page both render these options
// in client-side components, and React Router refuses to let client-rendered
// code import anything from a `.server.ts` module. The timezone-aware
// scheduling math that consumes these lives in schedule.server.ts, which
// re-exports normalizeHhMm so existing server-side imports keep working.

export function parseHhMm(value: string | null | undefined): { hour: number; minute: number } {
  const [hh, mm] = String(value ?? "").split(":").map((n) => parseInt(n, 10));
  return {
    hour: Number.isFinite(hh) && hh >= 0 && hh <= 23 ? hh : 6,
    minute: Number.isFinite(mm) && mm >= 0 && mm <= 59 ? mm : 0,
  };
}

/** "9:5" / "not-a-time" / "24:99" all become a real, canonical "HH:MM" — the
 * free-text time field this replaced could persist any of them, and a
 * malformed value then silently meant 06:00 at run time. */
export function normalizeHhMm(value: string | null | undefined): string {
  const { hour, minute } = parseHhMm(value);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function shiftHours(time: string, hours: number): string {
  const { hour, minute } = parseHhMm(time);
  return `${String((hour + hours + 24) % 24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Polaris web components have no time field (there's s-date-field and
 * s-date-picker, but no time equivalent), so every shuffle-time picker in
 * the app is an s-select over these half-hour slots. */
export const TIME_OPTIONS: string[] = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = i % 2 === 0 ? "00" : "30";
  return `${String(hour).padStart(2, "0")}:${minute}`;
});

/** A stored time that isn't on the half-hour — seeded by the old free-text
 * field, or by a plan downgrade's fallback — still has to be selectable, or
 * merely opening the page would silently change the merchant's schedule. */
export function timeOptionsIncluding(...values: Array<string | null | undefined>): string[] {
  const extras = values
    .filter((v): v is string => Boolean(v))
    .map((v) => normalizeHhMm(v))
    .filter((v) => !TIME_OPTIONS.includes(v));
  return [...new Set([...TIME_OPTIONS, ...extras])].sort();
}

/** The second slot that twice-daily used to derive on its own: 12 hours
 * after the first. Only a starting suggestion now — the merchant picks the
 * real one — and the fallback for any row written before scheduleTime2
 * existed. */
export function defaultSecondSlot(firstSlot: string): string {
  return shiftHours(normalizeHhMm(firstSlot), 12);
}
