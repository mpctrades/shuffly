import { beforeEach, describe, expect, it, vi } from "vitest";

// Records every write enforcePlanEntitlements queues into its transaction.
const state = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  collections: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ kind: string; args: { where?: { id?: string }; data: Record<string, unknown> } }>,
}));

vi.mock("../db.server", () => {
  const record = (kind: string) => (args: { data: Record<string, unknown> }) => {
    state.writes.push({ kind, args });
    return Promise.resolve(args);
  };
  return {
    default: {
      shopSettings: { findUnique: async () => state.settings, update: record("settings") },
      collectionConfig: { findMany: async () => state.collections, update: record("collection") },
      shuffleRun: { create: record("run") },
      $transaction: async (ops: unknown[]) => Promise.all(ops),
    },
  };
});

import { enforcePlanEntitlements, fallbackSchedule, type PlanNotice } from "./plans.server";

const SHOP = "s.myshopify.com";
const TZ = "Europe/London";

function settings(overrides: Record<string, unknown> = {}) {
  return {
    shop: SHOP,
    timezone: TZ,
    plan: "STARTER",
    defaultScheduleType: "DAILY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: null,
    defaultIntervalHours: null,
    defaultIntervalAnchorAt: null,
    planNotice: null,
    ...overrides,
  };
}

function collection(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    shop: SHOP,
    title: `Collection ${id}`,
    status: "RUNNING",
    pins: 0,
    scheduleType: null,
    scheduleTime: null,
    scheduleTime2: null,
    scheduleWeekday: null,
    intervalHours: null,
    intervalAnchorAt: null,
    reshuffleOnNew: false,
    keepNewOnTop: false,
    ...overrides,
  };
}

const collectionWrite = (id: string) => state.writes.find((w) => w.kind === "collection" && w.args.where?.id === id)?.args.data;
const notice = (): PlanNotice | null => {
  const w = state.writes.find((x) => x.kind === "settings" && "planNotice" in x.args.data);
  return w ? JSON.parse(w.args.data.planNotice as string) : null;
};

beforeEach(() => {
  state.settings = settings();
  state.collections = [];
  state.writes = [];
});

describe("fallbackSchedule", () => {
  it("Starter: an hourly schedule becomes Daily at the local time it was anchored on", () => {
    // 14:30 UTC on 12 Nov is 14:30 in London (GMT).
    const s = fallbackSchedule(
      "STARTER",
      { scheduleType: "INTERVAL", scheduleTime: "06:00", scheduleWeekday: null, intervalHours: 1, intervalAnchorAt: new Date("2026-11-12T14:30:00Z") },
      TZ,
    );
    expect(s).toMatchObject({ scheduleType: "DAILY", scheduleTime: "14:30", intervalHours: null, intervalAnchorAt: null });
  });

  it("Free: falls back to Weekly, keeping the time of day", () => {
    const s = fallbackSchedule("FREE", { scheduleType: "DAILY", scheduleTime: "09:00", scheduleWeekday: null }, TZ);
    expect(s).toMatchObject({ scheduleType: "WEEKLY", scheduleTime: "09:00", scheduleWeekday: 1 });
  });

  it("legacy twice-daily keeps its first time", () => {
    const s = fallbackSchedule("STARTER", { scheduleType: "TWICE_DAILY", scheduleTime: "07:00", scheduleTime2: "19:00", scheduleWeekday: null }, TZ);
    expect(s).toMatchObject({ scheduleType: "DAILY", scheduleTime: "07:00", scheduleTime2: null });
  });
});

describe("downgrade Pro → Starter", () => {
  it("moves hourly collections to Daily, turns off B and C, and writes a notice", async () => {
    state.collections = [
      collection("hourly", {
        scheduleType: "INTERVAL",
        intervalHours: 1,
        intervalAnchorAt: new Date("2026-11-12T14:30:00Z"),
        reshuffleOnNew: true,
        keepNewOnTop: true,
      }),
      collection("daily", { scheduleType: "DAILY", scheduleTime: "08:00" }),
    ];

    const result = await enforcePlanEntitlements(SHOP, "STARTER", "PRO");

    expect(collectionWrite("hourly")).toMatchObject({
      scheduleType: "DAILY",
      scheduleTime: "14:30",
      intervalHours: null,
      reshuffleOnNew: false,
      keepNewOnTop: false,
    });
    expect(collectionWrite("daily")).toBeUndefined(); // already allowed: untouched
    expect(result?.changes).toHaveLength(1);
    expect(notice()).toMatchObject({
      from: "PRO",
      to: "STARTER",
      changes: [
        {
          collectionId: "hourly",
          from: { type: "INTERVAL", intervalHours: 1 },
          to: { type: "DAILY", time: "14:30" },
          reshuffleOnNewOff: true,
          keepNewOnTopOff: true,
        },
      ],
    });
    const run = state.writes.find((w) => w.kind === "run")!.args.data;
    expect(run).toMatchObject({ collectionId: "hourly", messageCode: "PLAN_DOWNGRADE" });
  });

  it("keeps a legacy twice-daily collection's first time when it falls back", async () => {
    state.collections = [collection("tw", { scheduleType: "TWICE_DAILY", scheduleTime: "07:00", scheduleTime2: "19:00" })];
    await enforcePlanEntitlements(SHOP, "STARTER", "PRO");
    expect(collectionWrite("tw")).toMatchObject({ scheduleType: "DAILY", scheduleTime: "07:00", scheduleTime2: null });
  });

  it("clamps an hourly shop default, and repairs the countdown of everything inheriting it", async () => {
    state.settings = settings({
      defaultScheduleType: "INTERVAL",
      defaultIntervalHours: 2,
      defaultIntervalAnchorAt: new Date("2026-11-12T09:00:00Z"),
    });
    state.collections = [collection("inherits")];
    await enforcePlanEntitlements(SHOP, "STARTER", "PRO");
    const defaultWrite = state.writes.find((w) => w.kind === "settings" && "defaultScheduleType" in w.args.data)!.args.data;
    expect(defaultWrite).toMatchObject({ defaultScheduleType: "DAILY", defaultScheduleTime: "09:00", defaultIntervalHours: null });
    expect(collectionWrite("inherits")).toHaveProperty("nextRunAt");
    expect(notice()?.changes[0]).toMatchObject({ collectionId: null, to: { type: "DAILY" } });
  });

  it("leaves collection counts alone (caps are a separate rule)", async () => {
    state.collections = Array.from({ length: 150 }, (_, i) => collection(`c${i}`));
    await enforcePlanEntitlements(SHOP, "STARTER", "PRO");
    expect(state.writes.some((w) => w.args.data.status === "PAUSED")).toBe(false);
  });
});

describe("downgrade to Free", () => {
  it("falls back to Weekly and clears pins", async () => {
    state.collections = [collection("x", { scheduleType: "INTERVAL", intervalHours: 3, intervalAnchorAt: new Date("2026-11-12T06:00:00Z"), pins: 3 })];
    await enforcePlanEntitlements(SHOP, "FREE", "PRO");
    expect(collectionWrite("x")).toMatchObject({ scheduleType: "WEEKLY", scheduleTime: "06:00", scheduleWeekday: 1, pins: 0 });
  });
});

describe("no-ops", () => {
  it("writes nothing when everything already fits", async () => {
    state.collections = [collection("ok", { scheduleType: "DAILY", scheduleTime: "06:00" })];
    expect(await enforcePlanEntitlements(SHOP, "STARTER", "STARTER")).toBeNull();
    expect(state.writes).toEqual([]);
  });

  it("an upgrade changes nothing and clears an old notice", async () => {
    state.settings = settings({ planNotice: "{}" });
    state.collections = [collection("x", { scheduleType: "WEEKLY", scheduleTime: "06:00", scheduleWeekday: 1 })];
    expect(await enforcePlanEntitlements(SHOP, "PRO", "STARTER")).toBeNull();
    expect(state.writes).toEqual([{ kind: "settings", args: { where: { shop: SHOP }, data: { planNotice: null, planNoticeDismissedAt: null } } }]);
  });
});
