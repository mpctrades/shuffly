// The collection card's model (Update 2, brief §7): how a schedule maps to
// the one Frequency dropdown, which options a plan may pick, and when the
// "New arrivals" preset is suggested. Client-safe (no .server) because the
// card renders it; the server re-validates everything it receives.

import { cheapestPlanWith, isScheduleAllowed, planOf } from "./plans";
import type { T } from "../i18n";

/** A schedule as the plan notice and Activity store it (plain data). */
export interface NoticeScheduleLike {
  type: string;
  time?: string | null;
  time2?: string | null;
  weekday?: number | null;
  intervalHours?: number | null;
}

export const INTERVAL_CHOICES = [1, 2, 3, 4, 6, 12] as const;
export const NEW_ON_TOP_CHOICES = [24, 48, 72, 168] as const;

/** One dropdown value per cadence: "INTERVAL:2", "DAILY", "WEEKLY",
 * "TWICE_DAILY" (legacy, only while selected) or "MANUAL". */
export type Cadence = string;

export function cadenceOf(schedule: { scheduleType: string; intervalHours?: number | null }): Cadence {
  return schedule.scheduleType === "INTERVAL" ? `INTERVAL:${schedule.intervalHours ?? 1}` : schedule.scheduleType;
}

export function parseCadence(value: Cadence): { scheduleType: string; intervalHours: number | null } {
  if (value.startsWith("INTERVAL:")) return { scheduleType: "INTERVAL", intervalHours: Number(value.slice(9)) };
  return { scheduleType: value, intervalHours: null };
}

export interface FrequencyOption {
  value: Cadence;
  label: string;
  /** Greyed out: the plan doesn't include it. Picking it never changes the
   * setting; the card offers "Unlock with Pro" instead. */
  disabled: boolean;
  /** The cheapest plan that unlocks it, for the badge text ("Pro", "Starter"). */
  lockedTo: string | null;
}

/**
 * The brief's dropdown, in order: Every 1 h · 2 h · 3 h · 4 h · 6 h · 12 h ·
 * Daily · Weekly — plus two options only some collections see:
 *  - "Twice daily (current)", only while a legacy twice-daily schedule is
 *    selected, so it keeps running exactly as before until the merchant picks
 *    something else, after which it's gone;
 *  - "Only when I press Shuffle", kept because merchants who opted out of
 *    automatic shuffles must not be forced back into them.
 */
export function frequencyOptions(planId: string | null | undefined, current: Cadence, t: T): FrequencyOption[] {
  const option = (value: Cadence, label: string): FrequencyOption => {
    const { scheduleType, intervalHours } = parseCadence(value);
    const allowed = isScheduleAllowed(planId, scheduleType, intervalHours);
    const unlock = allowed ? null : cheapestPlanWith(scheduleType);
    return {
      value,
      label: unlock ? t("freq.locked", { option: label, plan: unlock.name }) : label,
      disabled: !allowed,
      lockedTo: unlock?.name ?? null,
    };
  };
  const options = [
    ...INTERVAL_CHOICES.map((h) => option(`INTERVAL:${h}`, t.plural("freq.interval", h))),
    option("DAILY", t("freq.daily")),
    option("WEEKLY", t("freq.weekly")),
  ];
  if (current === "TWICE_DAILY") {
    // Never disabled: it is what's running now, even after a downgrade race.
    options.push({ value: "TWICE_DAILY", label: t("freq.twiceDailyCurrent"), disabled: false, lockedTo: null });
  }
  options.push(option("MANUAL", t("freq.manual")));
  return options;
}

/** The label of a cadence on its own (activity, notice). */
export function cadenceLabel(value: Cadence, t: T): string {
  const { scheduleType, intervalHours } = parseCadence(value);
  switch (scheduleType) {
    case "INTERVAL":
      return t.plural("freq.interval", intervalHours ?? 1);
    case "DAILY":
      return t("freq.daily");
    case "WEEKLY":
      return t("freq.weekly");
    case "TWICE_DAILY":
      return t("freq.twiceDailyCurrent");
    default:
      return t("freq.manual");
  }
}

/** Brief §7: show the preset as a banner when the title contains "new",
 * "nouveau", "arrival" or "latest", case-insensitive — a plain "contains",
 * as specified. A false positive ("Renewable energy") only costs a
 * dismissible suggestion. */
const NEW_ARRIVALS_TITLE = /new|nouveau|arrival|latest/i;

export function looksLikeNewArrivals(title: string): boolean {
  return NEW_ARRIVALS_TITLE.test(title);
}

/** The preset's three settings, in one place (server and client). */
export const NEW_ARRIVALS_PRESET = {
  cadence: "INTERVAL:2",
  reshuffleOnNew: true,
  keepNewOnTop: true,
  newOnTopHours: 48,
} as const;

export function hasPresetApplied(card: { cadence: Cadence; reshuffleOnNew: boolean; keepNewOnTop: boolean }): boolean {
  return card.cadence === NEW_ARRIVALS_PRESET.cadence && card.reshuffleOnNew && card.keepNewOnTop;
}

/** "42 min" / "3 h 5 min" / "2 d 4 h". */
export function formatDuration(ms: number, t: T): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return t("dur.minutes", { m: minutes });
  const h = Math.floor(minutes / 60);
  if (h < 24) return t("dur.hoursMinutes", { h, m: minutes % 60 });
  return t("dur.daysHours", { d: Math.floor(h / 24), h: h % 24 });
}

/** "today 14:00" / "yesterday 09:30" / "12 Nov 06:00", in the shop's timezone. */
export function formatWhen(at: Date, now: Date, timeZone: string, t: T): string {
  const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat(t.lang, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const diff = Math.round((Date.parse(dayKey(now)) - Date.parse(dayKey(at))) / 86_400_000);
  if (diff === 0) return t("when.today", { time });
  if (diff === 1) return t("when.yesterday", { time });
  const date = new Intl.DateTimeFormat(t.lang, { timeZone, day: "numeric", month: "short" }).format(at);
  return t("when.date", { date, time });
}

/** "Pro" for the PRO badge text in the plan's own name. */
export const proPlanName = () => planOf("PRO").name;

/** "every 2 hours" / "daily at 14:30" / "weekly on Monday at 06:00". */
export function describeNoticeSchedule(s: NoticeScheduleLike | undefined, t: T): string {
  if (!s) return "";
  switch (s.type) {
    case "INTERVAL":
      return t.plural("freq.interval", s.intervalHours ?? 1).toLowerCase();
    case "DAILY":
      return t("sched.dailyAt", { time: s.time ?? "" });
    case "WEEKLY": {
      // 2026-11-01 is a Sunday: day 0..6 → a real date to name it.
      const day = new Intl.DateTimeFormat(t.lang, { weekday: "long", timeZone: "UTC" }).format(
        new Date(Date.UTC(2026, 10, 1 + (s.weekday ?? 1))),
      );
      return t("sched.weeklyAt", { day, time: s.time ?? "" });
    }
    case "TWICE_DAILY":
      return t("sched.twiceDailyAt", { time: s.time ?? "", time2: s.time2 ?? "" });
    default:
      return t("sched.manual");
  }
}
