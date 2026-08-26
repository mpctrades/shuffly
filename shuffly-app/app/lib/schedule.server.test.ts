import { describe, expect, it } from "vitest";
import {
  activityDayAndTime,
  computeNextRun,
  formatActivityTimestamp,
  formatNextRun,
  getLocalHour,
  startOfLocalDay,
  timezoneOffsetLabel,
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
