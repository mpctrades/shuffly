import { describe, expect, it } from "vitest";
import {
  formatRunAt,
  localDayDiff,
  nextRuns,
  relativeDayLabel,
} from "./next-runs";
import type { SlotSchedule } from "./schedule-core";

const UTC = "UTC";
const NY = "America/New_York"; // EST (UTC-5) / EDT (UTC-4)
const SEOUL = "Asia/Seoul"; // UTC+9, no DST at all — the control case

/** The preview only ever shows local wall clocks, so asserting on those
 * (rather than on ISO strings) is asserting the thing the merchant reads. */
function localTimes(runs: Date[], timeZone: string): string[] {
  return runs.map((d) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(d)
      .replace(",", ""),
  );
}

describe("nextRuns — one case per cadence", () => {
  it("DAILY returns the same wall clock on three consecutive days", () => {
    const now = new Date("2026-09-21T10:00:00Z"); // past 06:00 UTC already
    const schedule: SlotSchedule = {
      scheduleType: "DAILY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: null,
    };
    expect(nextRuns(now, UTC, schedule)).toHaveLength(3);
    expect(nextRuns(now, UTC, schedule).map((d) => d.toISOString())).toEqual([
      "2026-09-22T06:00:00.000Z",
      "2026-09-23T06:00:00.000Z",
      "2026-09-24T06:00:00.000Z",
    ]);
  });

  it("TWICE_DAILY alternates the two slots rather than repeating the first", () => {
    const now = new Date("2026-09-21T00:00:00Z");
    const runs = nextRuns(now, UTC, {
      scheduleType: "TWICE_DAILY",
      scheduleTime: "09:00",
      scheduleTime2: "18:00",
      scheduleWeekday: null,
    });
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-09-21T09:00:00.000Z",
      "2026-09-21T18:00:00.000Z",
      "2026-09-22T09:00:00.000Z",
    ]);
  });

  it("TWICE_DAILY with a null second slot still yields two distinct runs a day", () => {
    // Pre-Update-1 rows derived the second slot at +12h. slotTimesFor still
    // does, so the preview must not collapse to one run a day for them.
    const runs = nextRuns(new Date("2026-09-21T00:00:00Z"), UTC, {
      scheduleType: "TWICE_DAILY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: null,
    });
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-09-21T06:00:00.000Z",
      "2026-09-21T18:00:00.000Z",
      "2026-09-22T06:00:00.000Z",
    ]);
  });

  it("WEEKLY returns three occurrences exactly a week apart, all on the chosen day", () => {
    const now = new Date("2026-09-21T10:00:00Z"); // a Monday
    const runs = nextRuns(now, UTC, {
      scheduleType: "WEEKLY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: 3, // Wednesday
    });
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-09-23T06:00:00.000Z",
      "2026-09-30T06:00:00.000Z",
      "2026-10-07T06:00:00.000Z",
    ]);
    for (const run of runs) expect(run.getUTCDay()).toBe(3);
  });

  it("MANUAL has no occurrences at all", () => {
    expect(
      nextRuns(new Date("2026-09-21T10:00:00Z"), UTC, {
        scheduleType: "MANUAL",
        scheduleTime: "06:00",
        scheduleTime2: null,
        scheduleWeekday: null,
      }),
    ).toEqual([]);
  });

  it("honours a count other than the default three", () => {
    const runs = nextRuns(
      new Date("2026-09-21T10:00:00Z"),
      UTC,
      { scheduleType: "DAILY", scheduleTime: "06:00", scheduleTime2: null, scheduleWeekday: null },
      5,
    );
    expect(runs).toHaveLength(5);
  });

  it("never returns an occurrence at or before `now`", () => {
    // 06:00 exactly: the run happening this very instant is not a *next* run.
    const now = new Date("2026-09-21T06:00:00Z");
    const runs = nextRuns(now, UTC, {
      scheduleType: "DAILY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: null,
    });
    expect(runs[0].toISOString()).toBe("2026-09-22T06:00:00.000Z");
    for (const run of runs) expect(run.getTime()).toBeGreaterThan(now.getTime());
  });

  it("returns strictly increasing instants for every cadence", () => {
    const schedules: SlotSchedule[] = [
      { scheduleType: "DAILY", scheduleTime: "06:00", scheduleTime2: null, scheduleWeekday: null },
      { scheduleType: "TWICE_DAILY", scheduleTime: "09:00", scheduleTime2: "18:00", scheduleWeekday: null },
      { scheduleType: "WEEKLY", scheduleTime: "06:00", scheduleTime2: null, scheduleWeekday: 0 },
    ];
    for (const schedule of schedules) {
      const runs = nextRuns(new Date("2026-09-21T10:00:00Z"), SEOUL, schedule);
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i].getTime()).toBeGreaterThan(runs[i - 1].getTime());
      }
    }
  });
});

describe("nextRuns — DST boundaries", () => {
  // US DST 2026: forward 08 Mar, back 01 Nov.
  it("keeps the merchant's wall clock across spring forward, shifting the UTC instant", () => {
    const now = new Date("2026-03-06T12:00:00Z"); // Friday, before the seam
    const runs = nextRuns(now, NY, {
      scheduleType: "DAILY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: null,
    });
    // 06:00 local every day — that is the promise, and it does not move.
    expect(localTimes(runs, NY)).toEqual([
      "2026-03-07 06:00",
      "2026-03-08 06:00",
      "2026-03-09 06:00",
    ]);
    // The UTC instants therefore must shift by an hour at the seam: EST
    // (UTC-5) before, EDT (UTC-4) from the 8th on.
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-03-07T11:00:00.000Z",
      "2026-03-08T10:00:00.000Z",
      "2026-03-09T10:00:00.000Z",
    ]);
  });

  it("keeps the merchant's wall clock across fall back too", () => {
    const now = new Date("2026-10-30T12:00:00Z"); // before the 01 Nov seam
    const runs = nextRuns(now, NY, {
      scheduleType: "DAILY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: null,
    });
    expect(localTimes(runs, NY)).toEqual([
      "2026-10-31 06:00",
      "2026-11-01 06:00",
      "2026-11-02 06:00",
    ]);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-10-31T10:00:00.000Z",
      "2026-11-01T11:00:00.000Z",
      "2026-11-02T11:00:00.000Z",
    ]);
  });

  it("still yields a run on a day whose chosen wall clock does not exist", () => {
    // 02:30 never happens in New York on 08 Mar 2026 — the clock jumps
    // 02:00 -> 03:00. The day must not silently lose its run, and the run
    // must not fire *early* (01:30, which a mid-day offset guess produced).
    const runs = nextRuns(new Date("2026-03-07T12:00:00Z"), NY, {
      scheduleType: "DAILY",
      scheduleTime: "02:30",
      scheduleTime2: null,
      scheduleWeekday: null,
    });
    expect(runs).toHaveLength(3);
    // `now` is already past 02:30 on the 7th, so the seam day is the FIRST
    // occurrence, not the second.
    const springForward = runs[0];
    expect(springForward.toISOString()).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT
    expect(localTimes([springForward], NY)).toEqual(["2026-03-08 03:00"]);
    // Never earlier than the wall clock the merchant asked for.
    expect(springForward.getTime()).toBeGreaterThan(
      new Date("2026-03-08T06:30:00.000Z").getTime(), // what 01:30 EST would have been
    );
  });

  it("fires an ambiguous fall-back wall clock exactly once, not twice", () => {
    // 01:30 happens twice in New York on 01 Nov 2026. Two preview rows an
    // hour apart on the same day would be a lie — it is one run.
    const runs = nextRuns(new Date("2026-10-31T12:00:00Z"), NY, {
      scheduleType: "DAILY",
      scheduleTime: "01:30",
      scheduleTime2: null,
      scheduleWeekday: null,
    });
    const onSeamDay = runs.filter((d) => localTimes([d], NY)[0].startsWith("2026-11-01"));
    expect(onSeamDay).toHaveLength(1);
    expect(onSeamDay[0].toISOString()).toBe("2026-11-01T05:30:00.000Z"); // the FIRST 01:30 (EDT)
  });

  it("a weekly schedule crossing the seam stays on its weekday", () => {
    const runs = nextRuns(new Date("2026-02-27T12:00:00Z"), NY, {
      scheduleType: "WEEKLY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: 0, // Sunday — 08 Mar IS the spring-forward Sunday
    });
    expect(localTimes(runs, NY)).toEqual([
      "2026-03-01 06:00",
      "2026-03-08 06:00",
      "2026-03-15 06:00",
    ]);
  });
});

describe("nextRuns — weekly, chosen day is today", () => {
  it("waits a full week when today is the chosen day but the time has passed", () => {
    // Monday 21 Sep 2026, 10:00 local in Seoul. Weekly Monday 06:00 is four
    // hours gone — the next one is next Monday, not four hours ago and not
    // later today.
    const now = new Date("2026-09-21T01:00:00Z"); // 10:00 Asia/Seoul
    const runs = nextRuns(now, SEOUL, {
      scheduleType: "WEEKLY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: 1, // Monday
    });
    expect(localTimes(runs, SEOUL)).toEqual([
      "2026-09-28 06:00",
      "2026-10-05 06:00",
      "2026-10-12 06:00",
    ]);
    expect(runs[0].getTime()).toBeGreaterThan(now.getTime());
  });

  it("runs later the same day when today is the chosen day and the time is still ahead", () => {
    const now = new Date("2026-09-20T22:00:00Z"); // Monday 07:00 Seoul... no: 07:00 on the 21st
    const runs = nextRuns(now, SEOUL, {
      scheduleType: "WEEKLY",
      scheduleTime: "18:00",
      scheduleTime2: null,
      scheduleWeekday: 1, // Monday — and it IS Monday in Seoul right now
    });
    expect(localTimes(runs, SEOUL)[0]).toBe("2026-09-21 18:00");
  });

  it("treats the chosen time passing by one minute the same as by ten hours", () => {
    const now = new Date("2026-09-20T21:01:00Z"); // 06:01 Monday in Seoul
    const runs = nextRuns(now, SEOUL, {
      scheduleType: "WEEKLY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: 1,
    });
    expect(localTimes(runs, SEOUL)[0]).toBe("2026-09-28 06:00");
  });
});

describe("localDayDiff", () => {
  it("counts local days, not 24-hour blocks, across a 23-hour day", () => {
    // 07 Mar 06:00 -> 08 Mar 06:00 in New York is only 23 real hours.
    const from = new Date("2026-03-07T11:00:00Z");
    const to = new Date("2026-03-08T10:00:00Z");
    expect(to.getTime() - from.getTime()).toBe(23 * 3_600_000);
    expect(localDayDiff(to, from, NY)).toBe(1);
  });

  it("counts local days across a 25-hour day", () => {
    const from = new Date("2026-10-31T10:00:00Z");
    const to = new Date("2026-11-01T11:00:00Z");
    expect(to.getTime() - from.getTime()).toBe(25 * 3_600_000);
    expect(localDayDiff(to, from, NY)).toBe(1);
  });

  it("is 0 for two instants on the same local day", () => {
    expect(
      localDayDiff(new Date("2026-09-21T20:00:00Z"), new Date("2026-09-21T01:00:00Z"), UTC),
    ).toBe(0);
  });

  it("uses the shop's local day, not UTC's", () => {
    // 22:00 UTC on the 21st is already 07:00 on the 22nd in Seoul.
    expect(
      localDayDiff(new Date("2026-09-21T22:00:00Z"), new Date("2026-09-21T10:00:00Z"), SEOUL),
    ).toBe(1);
  });
});

describe("relativeDayLabel", () => {
  const now = new Date("2026-09-21T10:00:00Z");

  it("names today and tomorrow rather than counting", () => {
    expect(relativeDayLabel(new Date("2026-09-21T20:00:00Z"), now, UTC)).toBe("today");
    expect(relativeDayLabel(new Date("2026-09-22T06:00:00Z"), now, UTC)).toBe("tomorrow");
  });

  it("counts days up to a fortnight, then weeks", () => {
    expect(relativeDayLabel(new Date("2026-09-23T06:00:00Z"), now, UTC)).toBe("in 2 days");
    expect(relativeDayLabel(new Date("2026-09-28T06:00:00Z"), now, UTC)).toBe("in 7 days");
    expect(relativeDayLabel(new Date("2026-10-05T06:00:00Z"), now, UTC)).toBe("in 2 weeks");
  });
});

describe("formatRunAt", () => {
  it("renders a 24-hour wall clock in the shop's own timezone", () => {
    expect(formatRunAt(new Date("2026-09-21T21:00:00Z"), SEOUL)).toBe("Tue 22 Sep 06:00");
  });

  it("renders the same instant differently for a different shop timezone", () => {
    expect(formatRunAt(new Date("2026-09-21T21:00:00Z"), NY)).toBe("Mon 21 Sep 17:00");
  });
});
