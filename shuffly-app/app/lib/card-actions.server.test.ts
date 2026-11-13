import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopSettings } from "@prisma/client";

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  settings: null as Record<string, unknown> | null,
  runs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db.server", () => ({
  default: {
    collectionConfig: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; pendingPresetAt?: unknown } }) =>
        [...state.rows.values()].filter(
          (r) => (!where.id || where.id.in.includes(r.id as string)) && (!where.pendingPresetAt || r.pendingPresetAt != null),
        ),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(state.rows.get(where.id)!, data),
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.rows.get(where.id);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    shopSettings: { findUnique: async () => state.settings },
    shuffleRun: { create: async ({ data }: { data: Record<string, unknown> }) => state.runs.push(data) },
    $transaction: async (ops: unknown[]) => Promise.all(ops),
  },
}));
vi.mock("./product-seen.server", () => ({ startTracking: vi.fn() }));
vi.mock("./collections.server", () => ({ getCollectionProductsInOrder: vi.fn() }));

import { applyCardEdits, applyNewArrivalsPreset, applyQueuedPresets, queueNewArrivalsPreset } from "./card-actions.server";

const SHOP = "s.myshopify.com";
const NOW = new Date("2026-11-12T14:00:00Z");

function shop(plan: string): ShopSettings {
  state.settings = {
    shop: SHOP,
    plan,
    timezone: "Europe/London",
    defaultScheduleType: "DAILY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: null,
  };
  return state.settings as unknown as ShopSettings;
}

function row(id: string, extra: Record<string, unknown> = {}) {
  state.rows.set(id, {
    id,
    shop: SHOP,
    status: "RUNNING",
    scheduleType: "DAILY",
    scheduleTime: "09:15",
    scheduleTime2: null,
    scheduleWeekday: null,
    intervalHours: null,
    intervalAnchorAt: null,
    reshuffleOnNew: false,
    keepNewOnTop: false,
    newOnTopHours: 48,
    newTrackingSince: null,
    pendingPresetAt: null,
    ...extra,
  });
}

beforeEach(() => {
  state.rows.clear();
  state.runs = [];
});

describe("saving card edits", () => {
  it("a Starter shop can't set an hourly frequency — 403, nothing written", async () => {
    row("a");
    const r = await applyCardEdits(null, SHOP, shop("STARTER"), [{ id: "a", cadence: "INTERVAL:1" }], NOW);
    expect(r).toMatchObject({ ok: false, code: "PLAN_SCHEDULE", status: 403 });
    expect(state.rows.get("a")!.scheduleType).toBe("DAILY");
  });

  it("a Starter shop can't turn on the Pro new-arrivals options", async () => {
    row("a");
    const r = await applyCardEdits(null, SHOP, shop("STARTER"), [{ id: "a", keepNewOnTop: true }], NOW);
    expect(r).toMatchObject({ ok: false, code: "PLAN_FEATURE", status: 403 });
  });

  it("is all-or-nothing: one refused edit means nothing is saved", async () => {
    row("a");
    row("b");
    const r = await applyCardEdits(null, SHOP, shop("STARTER"), [
      { id: "a", cadence: "WEEKLY" },
      { id: "b", cadence: "INTERVAL:2" },
    ], NOW);
    expect(r.ok).toBe(false);
    expect(state.rows.get("a")!.scheduleType).toBe("DAILY");
  });

  it("Pro: hourly is anchored on the save moment, and logged", async () => {
    row("a");
    const r = await applyCardEdits(null, SHOP, shop("PRO"), [{ id: "a", cadence: "INTERVAL:1" }], NOW);
    expect(r).toEqual({ ok: true, changed: 1 });
    expect(state.rows.get("a")).toMatchObject({ scheduleType: "INTERVAL", intervalHours: 1, intervalAnchorAt: NOW });
    expect((state.rows.get("a")!.nextRunAt as Date).toISOString()).toBe("2026-11-12T15:00:00.000Z");
    expect(state.runs[0]).toMatchObject({ trigger: "SCHEDULE_CHANGED" });
  });

  it("changing to Daily keeps the collection's time of day", async () => {
    row("a", { scheduleType: "WEEKLY", scheduleWeekday: 3 });
    await applyCardEdits(null, SHOP, shop("STARTER"), [{ id: "a", cadence: "DAILY" }], NOW);
    expect(state.rows.get("a")).toMatchObject({ scheduleType: "DAILY", scheduleTime: "09:15" });
  });

  it("rejects a window that isn't offered", async () => {
    row("a");
    const r = await applyCardEdits(null, SHOP, shop("PRO"), [{ id: "a", newOnTopHours: 5 }], NOW);
    expect(r).toMatchObject({ ok: false, code: "BAD_WINDOW" });
  });

  it("turning features off is always allowed (a downgraded shop can clean up)", async () => {
    row("a", { keepNewOnTop: true });
    expect((await applyCardEdits(null, SHOP, shop("STARTER"), [{ id: "a", keepNewOnTop: false }], NOW)).ok).toBe(true);
  });
});

describe("the New arrivals preset", () => {
  it("one click sets every 2 hours + reshuffle on new + new on top for 48 h", async () => {
    row("a", { newOnTopHours: 24 });
    const r = await applyNewArrivalsPreset(null, SHOP, shop("PRO"), "a", NOW);
    expect(r.ok).toBe(true);
    expect(state.rows.get("a")).toMatchObject({
      scheduleType: "INTERVAL",
      intervalHours: 2,
      reshuffleOnNew: true,
      keepNewOnTop: true,
      newOnTopHours: 48,
    });
  });

  it("is refused below Pro", async () => {
    row("a");
    expect((await applyNewArrivalsPreset(null, SHOP, shop("STARTER"), "a", NOW)).ok).toBe(false);
  });

  it("clicked on Starter, it's applied by itself once the shop is on Pro", async () => {
    row("a");
    shop("STARTER");
    await queueNewArrivalsPreset(SHOP, "a", NOW);
    expect(state.rows.get("a")!.scheduleType).toBe("DAILY");
    shop("PRO");
    expect(await applyQueuedPresets(SHOP, new Date(NOW.getTime() + 3_600_000))).toBe(1);
    expect(state.rows.get("a")).toMatchObject({ scheduleType: "INTERVAL", intervalHours: 2, pendingPresetAt: null });
  });

  it("a queued preset older than 14 days is dropped, not applied", async () => {
    row("a", { pendingPresetAt: new Date(NOW.getTime() - 15 * 86_400_000) });
    shop("PRO");
    expect(await applyQueuedPresets(SHOP, NOW)).toBe(0);
    expect(state.rows.get("a")).toMatchObject({ scheduleType: "DAILY", pendingPresetAt: null });
  });
});
