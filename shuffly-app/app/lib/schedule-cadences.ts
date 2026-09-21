// The cadence catalogue behind the frequency grid.
//
// One entry per ScheduleType, carrying the copy the cards and the "Next
// runs" summary both need. Kept next to the type rather than inside the
// component so the grid, the summary line and anything else describing a
// cadence read the same words — the failure this replaced was three screens
// calling TWICE_DAILY "Twice daily", "2 shuffles a day" and "twice a day".
//
// What is NOT here: which cadences a merchant may pick. That comes from
// PLANS[].allowedSchedules — the same field the scheduler enforces — so the
// grid cannot offer a cadence the sweep would refuse to run. See
// cheapestPlanWith() in plans.ts.
//
// Order is the order the cards render in: most frequent first, manual last.
import type { ScheduleType } from "./schedule-core";

export interface CadenceOption {
  type: ScheduleType;
  /** Card title. */
  title: string;
  /** One line describing the real-world result, not the setting. */
  subtitle: string;
  /** The right-aligned summary beside the "Next runs" heading. */
  summary: string;
  /** The one carrying the "Best" badge. Exactly one entry has this. */
  recommended?: boolean;
}

export const CADENCES: CadenceOption[] = [
  {
    type: "TWICE_DAILY",
    title: "Twice a day",
    subtitle: "Morning + evening",
    summary: "2 runs a day",
  },
  {
    type: "DAILY",
    title: "Every day",
    subtitle: "1 run a day",
    summary: "1 run a day",
    recommended: true,
  },
  {
    type: "WEEKLY",
    title: "Once a week",
    subtitle: "1 run a week",
    summary: "1 run a week",
  },
  {
    type: "MANUAL",
    title: "Only when I press Shuffle",
    subtitle: "No automatic runs",
    summary: "No automatic runs",
  },
];

export function cadenceOption(type: ScheduleType): CadenceOption {
  return CADENCES.find((c) => c.type === type) ?? CADENCES[1];
}

/** The summary shown beside "Next runs". */
export function cadenceSummary(type: ScheduleType): string {
  return cadenceOption(type).summary;
}
