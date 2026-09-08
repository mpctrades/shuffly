import { describe, expect, it } from "vitest";
import {
  DUE_LOOKBACK_MS,
  activityDayAndTime,
  computeNextRun,
  dueSlots,
  formatActivityTimestamp,
  formatNextRun,
  getLocalHour,
  nextRunFor,
  normalizeHhMm,
  resolveLocalTime,
  scheduleWriteFields,
  slotTimesFor,
  startOfLocalDay,
  timezoneOffsetLabel,
  type SlotSchedule,
} from "./schedule.server";

const UTC = "UTC";
const NY = "America/New_York"; // UTC-5 (EST) / UTC-4 (EDT) — good DST coverage

describe("computeNextRun", () => {
  it("returns null for MANUAL schedules regardless of the time given", () => {
    const now = new Date("2026-08-25T10:00:00Z");
    expect(computeNextRun(now, UTC, "MANUAL", "06:00", null)).toBeNull();
  });

  it("returns later today when the scheduled time hasn't happened yet", () => {
    const now = new Date("2026-08-25T02:00:00Z"); // 02:00 UTC
    const next = computeNextRun(now, UTC, "DAILY", "06:00", null);
    expect(next?.toISOString()).toBe("2026-08-25T06:00:00.000Z");
  });

  it("rolls over to tomorrow when the scheduled time already passed today", () => {
    const now = new Date("2026-08-25T10:00:00Z"); // 10:00 UTC, past 06:00
    const next = computeNextRun(now, UTC, "DAILY", "06:00", null);
    expect(next?.toISOString()).toBe("2026-08-26T06:00:00.000Z");
  });

  it("picks the nearer of the two TWICE_DAILY slots", () => {
    const now = new Date("2026-08-25T10:00:00Z"); // past 06:00, before 18:00
    const next = computeNextRun(now, UTC, "TWICE_DAILY", "06:00", null);
    expect(next?.toISOString()).toBe("2026-08-25T18:00:00.000Z");
  });

  it("wraps TWICE_DAILY to tomorrow's first slot once both today's slots have passed", () => {
    const now = new Date("2026-08-25T20:00:00Z"); // past both 06:00 and 18:00
    const next = computeNextRun(now, UTC, "TWICE_DAILY", "06:00", null);
    expect(next?.toISOString()).toBe("2026-08-26T06:00:00.000Z");
  });

  it("finds the next matching weekday for WEEKLY schedules", () => {
    // 2026-08-25 is a Tuesday (weekday 2); ask for the next Friday (5) at 06:00.
    const now = new Date("2026-08-25T10:00:00Z");
    const next = computeNextRun(now, UTC, "WEEKLY", "06:00", 5);
    expect(next?.toISOString()).toBe("2026-08-28T06:00:00.000Z");
  });

  it("stays on today for a WEEKLY schedule if today matches and the time is still ahead", () => {
    // 2026-08-25 is a Tuesday (weekday 2), asking for Tuesday, time still ahead.
    const now = new Date("2026-08-25T02:00:00Z");
    const next = computeNextRun(now, UTC, "WEEKLY", "06:00", 2);
    expect(next?.toISOString()).toBe("2026-08-25T06:00:00.000Z");
  });

  it("rolls a WEEKLY schedule a full week forward once today's slot has passed", () => {
    const now = new Date("2026-08-25T10:00:00Z"); // Tuesday, past 06:00
    const next = computeNextRun(now, UTC, "WEEKLY", "06:00", 2);
    expect(next?.toISOString()).toBe("2026-09-01T06:00:00.000Z");
  });

  it("defaults to 06:00 when scheduleTime is malformed", () => {
    const now = new Date("2026-08-25T02:00:00Z");
    const next = computeNextRun(now, UTC, "DAILY", "not-a-time", null);
    expect(next?.toISOString()).toBe("2026-08-25T06:00:00.000Z");
  });

  it("computes the correct UTC instant across a non-UTC timezone", () => {
    // 06:00 in America/New_York in late August is EDT (UTC-4) => 10:00 UTC.
    const now = new Date("2026-08-25T02:00:00Z");
    const next = computeNextRun(now, NY, "DAILY", "06:00", null);
    expect(next?.toISOString()).toBe("2026-08-25T10:00:00.000Z");
  });
});

describe("formatNextRun", () => {
  it("labels a null next run as manual-only", () => {
    expect(formatNextRun(null, UTC)).toBe("Only when you press Shuffle");
  });

  it("formats a real instant in the given timezone", () => {
    const label = formatNextRun(new Date("2026-08-25T06:00:00Z"), UTC);
    expect(label).toContain("Aug");
    expect(label).toContain("25");
  });
});

describe("getLocalHour", () => {
  it("returns the wall-clock hour in the given timezone", () => {
    expect(getLocalHour(new Date("2026-08-25T06:00:00Z"), UTC)).toBe(6);
    // 06:00 UTC in New York (EDT, UTC-4) is 02:00 local.
    expect(getLocalHour(new Date("2026-08-25T06:00:00Z"), NY)).toBe(2);
  });
});

describe("timezoneOffsetLabel", () => {
  it("renders GMT as UTC+0", () => {
    expect(timezoneOffsetLabel(UTC, new Date("2026-08-25T06:00:00Z"))).toBe("UTC+0");
  });

  it("renders a negative offset for New York in EDT", () => {
    expect(timezoneOffsetLabel(NY, new Date("2026-08-25T06:00:00Z"))).toBe("UTC-4");
  });
});

describe("formatActivityTimestamp", () => {
  const now = new Date("2026-08-25T12:00:00Z");

  it("labels same-day instants as Today", () => {
    expect(formatActivityTimestamp(new Date("2026-08-25T06:00:00Z"), UTC, now)).toBe("Today 06:00");
  });

  it("labels the previous day as Yesterday", () => {
    expect(formatActivityTimestamp(new Date("2026-08-24T06:00:00Z"), UTC, now)).toBe("Yesterday 06:00");
  });

  it("falls back to a day + short-month label for anything older", () => {
    expect(formatActivityTimestamp(new Date("2026-08-20T06:00:00Z"), UTC, now)).toBe("20 Aug 06:00");
  });
});

describe("activityDayAndTime", () => {
  const now = new Date("2026-08-25T12:00:00Z");

  it("returns a stable sortable dayKey alongside the display label", () => {
    const result = activityDayAndTime(new Date("2026-08-25T06:00:00Z"), UTC, now);
    expect(result).toEqual({ dayKey: "2026-08-25", dayLabel: "Today", time: "06:00" });
  });

  it("uses the full month name for older days (unlike formatActivityTimestamp's short form)", () => {
    const result = activityDayAndTime(new Date("2026-08-20T06:00:00Z"), UTC, now);
    expect(result.dayLabel).toBe("20 August");
    expect(result.dayKey).toBe("2026-08-20");
  });
});

describe("startOfLocalDay", () => {
  it("returns local midnight for UTC", () => {
    const result = startOfLocalDay(new Date("2026-08-25T15:30:00Z"), UTC);
    expect(result.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("returns local midnight converted to UTC for a non-UTC timezone", () => {
    // Local midnight in New York (EDT, UTC-4) on 2026-08-25 is 04:00 UTC.
    const result = startOfLocalDay(new Date("2026-08-25T15:30:00Z"), NY);
    expect(result.toISOString()).toBe("2026-08-25T04:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Update 1: merchant-picked slots, and the two DST edges the brief didn't
// mention. 2026 US transitions: DST starts Sun 8 Mar (02:00 EST -> 03:00
// EDT, i.e. 07:00 UTC) and ends Sun 1 Nov (02:00 EDT -> 01:00 EST, i.e.
// 06:00 UTC).
// ---------------------------------------------------------------------------

describe("resolveLocalTime", () => {
  it("resolves an ordinary local time to the one instant it happens at", () => {
    const { at, resolution } = resolveLocalTime(2026, 8, 25, 6, 0, NY);
    // 06:00 EDT (UTC-4) => 10:00 UTC.
    expect(at.toISOString()).toBe("2026-08-25T10:00:00.000Z");
    expect(resolution).toBe("exact");
  });

  it("reports a spring-forward time as skipped and fires it as the clock passes it", () => {
    // 02:30 never exists on 8 Mar 2026 in New York — the clock jumps 02:00 -> 03:00.
    const { at, resolution } = resolveLocalTime(2026, 3, 8, 2, 30, NY);
    expect(resolution).toBe("skipped");
    // 07:00 UTC is the transition itself, i.e. 03:00 EDT: the first moment
    // the wall clock has reached the requested time. Crucially it is NOT
    // 06:30 UTC (01:30 EST), which would run an hour EARLY.
    expect(at.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(getLocalHour(at, NY)).toBe(3);
  });

  it("reports a fall-back time as ambiguous and always picks the first occurrence", () => {
    // 01:30 happens twice on 1 Nov 2026: 05:30 UTC (EDT) and 06:30 UTC (EST).
    const { at, resolution } = resolveLocalTime(2026, 11, 1, 1, 30, NY);
    expect(resolution).toBe("ambiguous");
    expect(at.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("is stable — the same inputs always give the same instant", () => {
    const a = resolveLocalTime(2026, 11, 1, 1, 30, NY).at.getTime();
    const b = resolveLocalTime(2026, 11, 1, 1, 30, NY).at.getTime();
    expect(a).toBe(b);
  });
});

describe("slotTimesFor", () => {
  it("gives one slot for a daily schedule", () => {
    expect(slotTimesFor({ scheduleType: "DAILY", scheduleTime: "09:00", scheduleTime2: "18:00", scheduleWeekday: null }))
      .toEqual([{ slot: 0, time: "09:00" }]);
  });

  it("gives no slots for a manual schedule", () => {
    expect(slotTimesFor({ scheduleType: "MANUAL", scheduleTime: "09:00", scheduleTime2: null, scheduleWeekday: null }))
      .toEqual([]);
  });

  it("gives two merchant-picked slots for twice daily", () => {
    expect(slotTimesFor({ scheduleType: "TWICE_DAILY", scheduleTime: "09:00", scheduleTime2: "14:30", scheduleWeekday: null }))
      .toEqual([
        { slot: 0, time: "09:00" },
        { slot: 1, time: "14:30" },
      ]);
  });

  it("keeps slot indices tied to the field, not to chronological order", () => {
    // Slot 1 being earlier in the day than slot 0 must not renumber them —
    // that's what stops an already-fired slot looking unfired after an edit.
    expect(slotTimesFor({ scheduleType: "TWICE_DAILY", scheduleTime: "18:00", scheduleTime2: "09:00", scheduleWeekday: null }))
      .toEqual([
        { slot: 0, time: "18:00" },
        { slot: 1, time: "09:00" },
      ]);
  });

  it("falls back to the old derived +12h second slot when none is stored", () => {
    expect(slotTimesFor({ scheduleType: "TWICE_DAILY", scheduleTime: "06:00", scheduleTime2: null, scheduleWeekday: null }))
      .toEqual([
        { slot: 0, time: "06:00" },
        { slot: 1, time: "18:00" },
      ]);
  });

  it("collapses two identical times into a single run", () => {
    expect(slotTimesFor({ scheduleType: "TWICE_DAILY", scheduleTime: "09:00", scheduleTime2: "09:00", scheduleWeekday: null }))
      .toEqual([{ slot: 0, time: "09:00" }]);
  });
});

describe("dueSlots", () => {
  const daily = (time: string): SlotSchedule => ({
    scheduleType: "DAILY",
    scheduleTime: time,
    scheduleTime2: null,
    scheduleWeekday: null,
  });

  it("reports nothing due before the chosen time", () => {
    // 08:00 UTC = 04:00 EDT, before a 09:00 local slot.
    expect(dueSlots(new Date("2026-08-25T08:00:00Z"), NY, daily("09:00"))).toEqual([]);
  });

  it("reports the slot due just after the chosen time", () => {
    // 09:00 EDT = 13:00 UTC.
    const due = dueSlots(new Date("2026-08-25T13:01:00Z"), NY, daily("09:00"));
    expect(due).toHaveLength(1);
    expect(due[0].slot).toBe(0);
    expect(due[0].dateKey).toBe("2026-08-25");
  });

  it("stops reporting a slot once it falls outside the lookback window", () => {
    const wellPast = new Date("2026-08-25T13:00:00Z").getTime() + DUE_LOOKBACK_MS + 60_000;
    expect(dueSlots(new Date(wellPast), NY, daily("09:00"))).toEqual([]);
  });

  it("follows a changed time immediately, with nothing left over at the old one", () => {
    const now = new Date("2026-08-25T13:01:00Z"); // 09:01 local
    // Stored as 09:00: due.
    expect(dueSlots(now, NY, daily("09:00"))).toHaveLength(1);
    // The merchant moves it to 18:00 — the very same instant now has
    // nothing due, because the sweep reads the stored time rather than a
    // job queued when they saved.
    expect(dueSlots(now, NY, daily("18:00"))).toEqual([]);
  });

  it("still runs a spring-forward-skipped time once that day", () => {
    // 02:30 local doesn't exist on 8 Mar; it resolves to 07:00 UTC.
    const due = dueSlots(new Date("2026-03-08T07:01:00Z"), NY, daily("02:30"));
    expect(due).toHaveLength(1);
    expect(due[0].resolution).toBe("skipped");
    expect(due[0].dateKey).toBe("2026-03-08");
  });

  it("gives a fall-back repeated hour the SAME claim key at both occurrences", () => {
    // 01:30 local happens at 05:30 UTC and again at 06:30 UTC on 1 Nov.
    // Both must produce the same (dateKey, slot) so the unique constraint on
    // ShuffleSlotClaim rejects the second one — that's what stops a double
    // run, rather than relying on the timing working out.
    const first = dueSlots(new Date("2026-11-01T05:31:00Z"), NY, daily("01:30"));
    const second = dueSlots(new Date("2026-11-01T06:31:00Z"), NY, daily("01:30"));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].dateKey).toBe(first[0].dateKey);
    expect(second[0].slot).toBe(first[0].slot);
    expect(first[0].dateKey).toBe("2026-11-01");
  });

  it("reports both twice-daily slots when a sweep comes back after an outage", () => {
    // 09:00 and 12:00 local, checked at 14:00 local (18:00 UTC) — both
    // inside the lookback window.
    const due = dueSlots(new Date("2026-08-25T18:00:00Z"), NY, {
      scheduleType: "TWICE_DAILY",
      scheduleTime: "09:00",
      scheduleTime2: "12:00",
      scheduleWeekday: null,
    });
    expect(due.map((d) => d.slot)).toEqual([0, 1]);
  });

  it("keeps a late-evening slot due just after local midnight rolls the date", () => {
    // 23:30 local on 25 Aug = 03:30 UTC on 26 Aug. At 04:00 UTC the local
    // date is still 25 Aug (00:00 EDT), so this also proves the dateKey is
    // the slot's own local day.
    const due = dueSlots(new Date("2026-08-26T04:00:00Z"), NY, daily("23:30"));
    expect(due).toHaveLength(1);
    expect(due[0].dateKey).toBe("2026-08-25");
  });

  it("only reports a weekly slot on its own weekday", () => {
    const weekly: SlotSchedule = {
      scheduleType: "WEEKLY",
      scheduleTime: "09:00",
      scheduleTime2: null,
      scheduleWeekday: 2, // Tuesday
    };
    // 25 Aug 2026 is a Tuesday.
    expect(dueSlots(new Date("2026-08-25T13:01:00Z"), NY, weekly)).toHaveLength(1);
    // 26 Aug is a Wednesday.
    expect(dueSlots(new Date("2026-08-26T13:01:00Z"), NY, weekly)).toEqual([]);
  });

  it("reports nothing for a manual schedule, whatever the time", () => {
    expect(
      dueSlots(new Date("2026-08-25T13:01:00Z"), NY, {
        scheduleType: "MANUAL",
        scheduleTime: "09:00",
        scheduleTime2: null,
        scheduleWeekday: null,
      }),
    ).toEqual([]);
  });
});

describe("nextRunFor", () => {
  it("picks the sooner of two merchant-chosen slots", () => {
    const now = new Date("2026-08-25T12:00:00Z"); // 08:00 local
    const next = nextRunFor(now, NY, {
      scheduleType: "TWICE_DAILY",
      scheduleTime: "18:00",
      scheduleTime2: "09:00",
      scheduleWeekday: null,
    });
    // 09:00 EDT = 13:00 UTC, ahead of 18:00 EDT = 22:00 UTC.
    expect(next?.toISOString()).toBe("2026-08-25T13:00:00.000Z");
  });

  it("rolls to the first slot of the next day once both have passed", () => {
    const now = new Date("2026-08-25T23:00:00Z"); // 19:00 local
    const next = nextRunFor(now, NY, {
      scheduleType: "TWICE_DAILY",
      scheduleTime: "09:00",
      scheduleTime2: "18:00",
      scheduleWeekday: null,
    });
    expect(next?.toISOString()).toBe("2026-08-26T13:00:00.000Z");
  });

  it("returns null for a manual schedule", () => {
    expect(
      nextRunFor(new Date("2026-08-25T12:00:00Z"), NY, {
        scheduleType: "MANUAL",
        scheduleTime: "09:00",
        scheduleTime2: null,
        scheduleWeekday: null,
      }),
    ).toBeNull();
  });
});

describe("normalizeHhMm", () => {
  it("canonicalizes a sloppy but valid time", () => {
    expect(normalizeHhMm("9:5")).toBe("09:05");
  });

  it("falls back to 06:00 for anything unparseable, matching the old field's behaviour", () => {
    expect(normalizeHhMm("not-a-time")).toBe("06:00");
    expect(normalizeHhMm(null)).toBe("06:00");
  });

  it("rejects out-of-range values instead of storing them", () => {
    expect(normalizeHhMm("25:99")).toBe("06:00");
  });
});

describe("scheduleWriteFields", () => {
  it("derives nextRunAt from the schedule it is writing, in one step", () => {
    const fields = scheduleWriteFields(new Date("2026-08-25T12:00:00Z"), NY, {
      scheduleType: "DAILY",
      scheduleTime: "09:00",
      scheduleTime2: null,
      scheduleWeekday: null,
    });
    expect(fields.scheduleTime).toBe("09:00");
    expect(fields.nextRunAt?.toISOString()).toBe("2026-08-25T13:00:00.000Z");
  });

  it("drops the second slot for any schedule that isn't twice daily", () => {
    const fields = scheduleWriteFields(new Date("2026-08-25T12:00:00Z"), NY, {
      scheduleType: "DAILY",
      scheduleTime: "09:00",
      scheduleTime2: "18:00",
      scheduleWeekday: null,
    });
    expect(fields.scheduleTime2).toBeNull();
  });

  it("keeps and normalizes the second slot for twice daily", () => {
    const fields = scheduleWriteFields(new Date("2026-08-25T12:00:00Z"), NY, {
      scheduleType: "TWICE_DAILY",
      scheduleTime: "9:00",
      scheduleTime2: "18:0",
      scheduleWeekday: null,
    });
    expect(fields.scheduleTime).toBe("09:00");
    expect(fields.scheduleTime2).toBe("18:00");
  });

  it("clears nextRunAt for a paused collection", () => {
    const fields = scheduleWriteFields(
      new Date("2026-08-25T12:00:00Z"),
      NY,
      { scheduleType: "DAILY", scheduleTime: "09:00", scheduleTime2: null, scheduleWeekday: null },
      "PAUSED",
    );
    expect(fields.nextRunAt).toBeNull();
  });
});
