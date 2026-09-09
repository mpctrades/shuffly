import { describe, expect, it } from "vitest";
import { nextRunFor } from "./schedule-core";
import { isOverridden, overrideWriteFields, resolveSchedule, shopDefaultSchedule } from "./schedule-resolve";

const shop = {
  defaultScheduleType: "WEEKLY",
  defaultScheduleTime: "06:00",
  defaultScheduleTime2: null,
  defaultScheduleWeekday: 1, // Monday
};

const inheriting = { scheduleType: null, scheduleTime: null, scheduleTime2: null, scheduleWeekday: null };

describe("resolveSchedule", () => {
  it("follows the shop default when the collection stores no schedule", () => {
    expect(resolveSchedule(inheriting, shop)).toEqual({
      scheduleType: "WEEKLY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: 1,
    });
  });

  // The whole point of storing null instead of a copy: change the default and
  // every inheriting collection moves with it, with no write to their rows.
  it("moves an inheriting collection when the shop default changes", () => {
    const before = resolveSchedule(inheriting, shop);
    const after = resolveSchedule(inheriting, {
      ...shop,
      defaultScheduleTime: "18:00",
      defaultScheduleWeekday: 4, // Thursday
    });
    expect(before.scheduleTime).toBe("06:00");
    expect(after.scheduleTime).toBe("18:00");
    expect(after.scheduleWeekday).toBe(4);
  });

  it("leaves an overridden collection untouched when the shop default changes", () => {
    const custom = { scheduleType: "WEEKLY", scheduleTime: "09:30", scheduleTime2: null, scheduleWeekday: 5 };
    const after = resolveSchedule(custom, { ...shop, defaultScheduleTime: "18:00", defaultScheduleWeekday: 4 });
    expect(after).toEqual({
      scheduleType: "WEEKLY",
      scheduleTime: "09:30",
      scheduleTime2: null,
      scheduleWeekday: 5,
    });
  });

  it("treats scheduleType alone as the inheritance flag", () => {
    expect(isOverridden(inheriting)).toBe(false);
    // A daily override legitimately has a null weekday and null second slot —
    // which is exactly why "all four null" could not be the flag.
    expect(isOverridden({ scheduleType: "DAILY", scheduleTime: "07:00", scheduleTime2: null, scheduleWeekday: null })).toBe(true);
  });

  it("falls back to the shop's time if a row somehow has a type but no time", () => {
    const broken = { scheduleType: "WEEKLY", scheduleTime: null, scheduleTime2: null, scheduleWeekday: 2 };
    expect(resolveSchedule(broken, shop).scheduleTime).toBe("06:00");
  });
});

describe("a changed default actually moves the next run", () => {
  it("recomputes to the new day and time", () => {
    const tz = "Asia/Phnom_Penh";
    const now = new Date("2026-09-09T00:00:00Z");
    const before = nextRunFor(now, tz, resolveSchedule(inheriting, shop));
    const after = nextRunFor(now, tz, resolveSchedule(inheriting, { ...shop, defaultScheduleTime: "18:00" }));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.getTime()).not.toBe(before!.getTime());
  });
});

describe("overrideWriteFields", () => {
  it("writes all-null to go back to inheriting", () => {
    expect(overrideWriteFields(null)).toEqual(inheriting);
  });

  it("drops the second slot unless the cadence is twice-daily", () => {
    const written = overrideWriteFields({
      scheduleType: "WEEKLY",
      scheduleTime: "06:00",
      scheduleTime2: "18:00",
      scheduleWeekday: 1,
    });
    expect(written.scheduleTime2).toBeNull();
  });

  it("drops the weekday unless the cadence is weekly", () => {
    const written = overrideWriteFields({
      scheduleType: "DAILY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: 3,
    });
    expect(written.scheduleWeekday).toBeNull();
  });

  it("keeps both when the cadence uses them", () => {
    expect(overrideWriteFields({
      scheduleType: "TWICE_DAILY",
      scheduleTime: "06:00",
      scheduleTime2: "18:00",
      scheduleWeekday: null,
    }).scheduleTime2).toBe("18:00");
  });
});

describe("shopDefaultSchedule", () => {
  it("maps the ShopSettings columns onto the scheduling shape", () => {
    expect(shopDefaultSchedule(shop)).toEqual({
      scheduleType: "WEEKLY",
      scheduleTime: "06:00",
      scheduleTime2: null,
      scheduleWeekday: 1,
    });
  });
});
