import { describe, expect, it } from "vitest";
import {
  dueSlots,
  intervalDateKey,
  latestIntervalSlot,
  nextIntervalSlot,
  nextRunFor,
  type SlotSchedule,
} from "./schedule-core";
import { inheritedIntervalOffsetMs, resolveSchedule } from "./schedule-resolve";
import { bulkStaggerMs, parseScheduleForm, withIntervalAnchor } from "./schedule-form.server";
import { nextRuns } from "./next-runs";

const H = 3_600_000;

function every(hours: number, anchor: string): SlotSchedule {
  return {
    scheduleType: "INTERVAL",
    scheduleTime: "06:00",
    scheduleWeekday: null,
    intervalHours: hours,
    intervalAnchorAt: new Date(anchor),
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("interval next_run_at maths", () => {
  it("first run is one interval after the save moment, not at it", () => {
    const s = every(2, "2026-11-12T10:07:00Z");
    expect(nextIntervalSlot(new Date("2026-11-12T10:07:00Z"), s).toISOString()).toBe("2026-11-12T12:07:00.000Z");
    expect(latestIntervalSlot(new Date("2026-11-12T11:59:00Z"), s)).toBeNull();
  });

  it("stays on the anchor's grid however late it is asked", () => {
    const s = every(3, "2026-11-12T10:07:00Z");
    const now = new Date("2026-11-13T05:30:00Z"); // 19h23m after the anchor
    expect(latestIntervalSlot(now, s)?.toISOString()).toBe("2026-11-13T04:07:00.000Z");
    expect(nextIntervalSlot(now, s).toISOString()).toBe("2026-11-13T07:07:00.000Z");
  });

  it("a run exactly on a slot moves next_run_at a full interval on", () => {
    const s = every(1, "2026-11-12T10:00:00Z");
    expect(nextIntervalSlot(new Date("2026-11-12T13:00:00Z"), s).toISOString()).toBe("2026-11-12T14:00:00.000Z");
  });

  it("is DST-safe: every hour stays 60 real minutes apart across a fall-back night", () => {
    // Europe/London falls back at 01:00 UTC on 25 Oct 2026.
    const s = every(1, "2026-10-24T22:30:00Z");
    const runs = nextRuns(new Date("2026-10-24T22:30:00Z"), "Europe/London", s, 6);
    const gaps = runs.slice(1).map((r, i) => r.getTime() - runs[i].getTime());
    expect(gaps.every((g) => g === H)).toBe(true);
    expect(runs).toHaveLength(6);
  });

  it("is DST-safe across spring-forward too (America/New_York, 8 Mar 2026)", () => {
    const s = every(4, "2026-03-07T20:00:00Z");
    const runs = nextRuns(new Date("2026-03-07T20:00:00Z"), "America/New_York", s, 5);
    expect(runs.slice(1).every((r, i) => r.getTime() - runs[i].getTime() === 4 * H)).toBe(true);
  });

  it("nextRunFor dispatches INTERVAL without a timezone lookup", () => {
    const s = every(6, "2026-11-12T00:00:00Z");
    expect(nextRunFor(new Date("2026-11-12T07:00:00Z"), "Asia/Phnom_Penh", s)?.toISOString()).toBe(
      "2026-11-12T12:00:00.000Z",
    );
  });

  it("clamps a stored interval below the floor to one hour", () => {
    const s = { ...every(1, "2026-11-12T10:00:00Z"), intervalHours: 0 };
    expect(nextIntervalSlot(new Date("2026-11-12T10:10:00Z"), s).toISOString()).toBe("2026-11-12T11:00:00.000Z");
  });
});

describe("interval due slots", () => {
  it("is due once the latest slot has passed, keyed by its own instant", () => {
    const s = every(1, "2026-11-12T10:00:00Z");
    const { due, missed } = dueSlots(new Date("2026-11-12T12:00:30Z"), "UTC", s);
    expect(missed).toEqual([]);
    expect(due).toHaveLength(1);
    expect(due[0].dateKey).toBe(intervalDateKey(new Date("2026-11-12T12:00:00Z")));
    expect(due[0].late).toBe(false);
  });

  it("an outage collapses into one run (only the latest slot is offered)", () => {
    const s = every(1, "2026-11-12T00:00:00Z");
    const { due } = dueSlots(new Date("2026-11-12T05:20:00Z"), "UTC", s);
    expect(due.map((d) => d.at.toISOString())).toEqual(["2026-11-12T05:00:00.000Z"]);
    expect(due[0].late).toBe(true); // 20 minutes behind
  });

  it("a long interval whose slot passed outside the grace window is reported missed", () => {
    const s = every(12, "2026-11-12T00:00:00Z");
    const { due, missed } = dueSlots(new Date("2026-11-12T15:00:00Z"), "UTC", s);
    expect(due).toEqual([]);
    expect(missed).toHaveLength(1);
  });

  it("interval keys never collide with daily YYYY-MM-DD keys", () => {
    expect(intervalDateKey(new Date("2026-11-12T00:00:00Z"))).toMatch(/^I2026-11-12T/);
  });
});

describe("inheriting an interval default", () => {
  const settings = {
    defaultScheduleType: "INTERVAL",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: null,
    defaultIntervalHours: 1,
    defaultIntervalAnchorAt: new Date("2026-11-12T10:00:00Z"),
  };
  const inheriting = (id: string) => ({
    id,
    scheduleType: null,
    scheduleTime: null,
    scheduleTime2: null,
    scheduleWeekday: null,
  });

  it("spreads collections across the hour instead of one burst", () => {
    const minutes = new Set(
      Array.from({ length: 200 }, (_, i) => resolveSchedule(inheriting(`col${i}`), settings).intervalAnchorAt!.getUTCMinutes()),
    );
    expect(minutes.size).toBeGreaterThan(40);
  });

  it("gives the same collection the same offset every time", () => {
    expect(inheritedIntervalOffsetMs("abc", 1)).toBe(inheritedIntervalOffsetMs("abc", 1));
    expect(inheritedIntervalOffsetMs("abc", 12)).toBeLessThan(H);
  });

  it("leaves a collection with its own interval exactly on its own anchor", () => {
    const own = { ...inheriting("x"), scheduleType: "INTERVAL", intervalHours: 2, intervalAnchorAt: new Date("2026-11-12T10:07:00Z") };
    expect(resolveSchedule(own, settings).intervalAnchorAt?.toISOString()).toBe("2026-11-12T10:07:00.000Z");
  });
});

describe("parseScheduleForm — server-side plan enforcement", () => {
  it("rejects an hourly schedule from a Starter shop with 403", () => {
    const r = parseScheduleForm(form({ scheduleType: "INTERVAL", intervalHours: "1" }), "STARTER");
    expect(r).toMatchObject({ ok: false, code: "PLAN_SCHEDULE", status: 403 });
  });

  it("rejects every interval on Free, and daily on Free", () => {
    for (const h of ["1", "2", "3", "4", "6", "12"]) {
      expect(parseScheduleForm(form({ scheduleType: "INTERVAL", intervalHours: h }), "FREE").ok).toBe(false);
    }
    expect(parseScheduleForm(form({ scheduleType: "DAILY" }), "FREE").ok).toBe(false);
  });

  it("accepts every interval on Pro", () => {
    for (const h of [1, 2, 3, 4, 6, 12]) {
      const r = parseScheduleForm(form({ scheduleType: "INTERVAL", intervalHours: String(h) }), "PRO");
      expect(r.ok && r.schedule.intervalHours).toBe(h);
    }
  });

  it("never allows anything faster than hourly, even on Pro (400, not an upsell)", () => {
    for (const h of ["0.25", "0", "-1", "5", "24", ""]) {
      expect(parseScheduleForm(form({ scheduleType: "INTERVAL", intervalHours: h }), "PRO")).toMatchObject({
        ok: false,
        code: "BAD_INTERVAL",
        status: 400,
      });
    }
  });

  it("rejects unknown cadences outright", () => {
    expect(parseScheduleForm(form({ scheduleType: "EVERY_15_MIN" }), "PRO")).toMatchObject({ ok: false, code: "UNKNOWN_SCHEDULE" });
  });

  it("a weekly post with no weekday becomes Monday, not 'every day'", () => {
    // dueSlots treats a null weekday as "any day", which made a bare WEEKLY
    // post a free daily schedule on the Free plan.
    const r = parseScheduleForm(form({ scheduleType: "WEEKLY", scheduleTime: "09:00" }), "FREE");
    expect(r.ok && r.schedule.scheduleWeekday).toBe(1);
  });

  it("legacy twice-daily stays valid on Pro and is still refused below it", () => {
    expect(parseScheduleForm(form({ scheduleType: "TWICE_DAILY", scheduleTime: "06:00", scheduleTime2: "18:00" }), "PRO").ok).toBe(true);
    expect(parseScheduleForm(form({ scheduleType: "TWICE_DAILY" }), "STARTER").ok).toBe(false);
  });
});

describe("interval anchors", () => {
  const now = new Date("2026-11-12T14:00:00Z");
  const parsed: SlotSchedule = { scheduleType: "INTERVAL", scheduleTime: "06:00", scheduleWeekday: null, intervalHours: 2, intervalAnchorAt: null };

  it("anchors a newly chosen interval on the save moment", () => {
    expect(withIntervalAnchor(null, parsed, now).intervalAnchorAt?.toISOString()).toBe(now.toISOString());
  });

  it("keeps the anchor when the same interval is saved again", () => {
    const before = every(2, "2026-11-12T09:13:00Z");
    expect(withIntervalAnchor(before, parsed, now).intervalAnchorAt?.toISOString()).toBe("2026-11-12T09:13:00.000Z");
  });

  it("re-anchors when the interval changes", () => {
    const before = every(1, "2026-11-12T09:13:00Z");
    expect(withIntervalAnchor(before, parsed, now).intervalAnchorAt?.toISOString()).toBe(now.toISOString());
  });

  it("staggers bulk writes across up to ten minutes", () => {
    const anchors = Array.from({ length: 30 }, (_, i) => withIntervalAnchor(null, parsed, now, bulkStaggerMs(i)).intervalAnchorAt!.getTime());
    expect(new Set(anchors).size).toBe(10);
    expect(Math.max(...anchors) - now.getTime()).toBe(9 * 60_000);
  });

  it("drops interval fields from non-interval schedules", () => {
    const daily: SlotSchedule = { scheduleType: "DAILY", scheduleTime: "06:00", scheduleWeekday: null, intervalHours: 3 };
    expect(withIntervalAnchor(every(3, "2026-11-12T00:00:00Z"), daily, now)).toMatchObject({ intervalHours: null, intervalAnchorAt: null });
  });
});
