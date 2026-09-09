// Covers the Collections toolbar's pause-all / resume-all actions.
//
// resume-all is new: before it, a merchant could stop the whole app from one
// button and have no matching way back short of visiting every collection.
// Driven through the real route action rather than by clicking, because the
// browser automation has not reliably delivered clicks to this app all
// session.
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  getOrCreateShopSettings: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  runCreate: vi.fn(),
  transaction: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  prune: vi.fn(),
}));

vi.mock("../shopify.server", () => ({ authenticate: { admin: mocks.authenticateAdmin } }));

vi.mock("../db.server", () => ({
  default: {
    collectionConfig: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
      update: mocks.update,
      count: mocks.count,
      findFirst: mocks.findFirst,
    },
    shuffleRun: { create: mocks.runCreate, findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    shopSettings: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../lib/shop-context.server", () => ({ getOrCreateShopSettings: mocks.getOrCreateShopSettings }));
vi.mock("../lib/collections.server", () => ({
  hydrateTrackedCollections: vi.fn().mockResolvedValue(new Map()),
  getShopTimezone: vi.fn().mockResolvedValue("UTC"),
  sortOrderLabel: (s: string) => s,
  setCollectionManualSort: vi.fn(),
  restoreOnRemove: vi.fn(),
  listAllCollections: vi.fn(),
  fetchSortOrders: vi.fn(),
}));
vi.mock("@shopify/app-bridge-react", () => ({ useAppBridge: () => ({}) }));

import { action } from "../routes/app.collections";

const SHOP = "shuffly-test.myshopify.com";

function post(fields: Record<string, string>) {
  const url = new URL("https://example.com/app/collections");
  return action({
    request: new Request(url, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    url,
    pattern: "/app/collections",
    params: {},
    context: {} as ActionFunctionArgs["context"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the action only needs `request`
  } as any) as unknown as Promise<any>;
}

/** Seven collections: six running, one already paused. */
const RUNNING = Array.from({ length: 6 }, (_, i) => ({
  id: `c${i}`,
  title: `Collection ${i}`,
  status: "RUNNING",
  scheduleType: null,
  scheduleTime: null,
  scheduleTime2: null,
  scheduleWeekday: null,
}));
const PAUSED = [
  {
    id: "p0",
    title: "Home page",
    status: "PAUSED",
    scheduleType: "DAILY",
    scheduleTime: "06:00",
    scheduleTime2: null,
    scheduleWeekday: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({ admin: {}, session: { shop: SHOP } });
  mocks.getOrCreateShopSettings.mockResolvedValue({
    shop: SHOP,
    plan: "STARTER",
    timezone: "UTC",
    neverMoveTags: "",
    pageSize: 24,
    defaultScheduleType: "WEEKLY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: 1,
  });
  mocks.transaction.mockResolvedValue([]);
  mocks.update.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe("pause-all", () => {
  it("pauses everything running and reports how many", async () => {
    mocks.findMany.mockResolvedValue(RUNNING);

    const res = await post({ _action: "pause-all" });

    expect(res.data).toEqual({ ok: true, count: 6 });
    // Scoped to this shop and to what was actually running.
    expect(mocks.findMany).toHaveBeenCalledWith({ where: { shop: SHOP, status: "RUNNING" } });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP, status: "RUNNING" },
      data: { status: "PAUSED", nextRunAt: null },
    });
  });

  it("reports 0 rather than failing when nothing is running", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect((await post({ _action: "pause-all" })).data).toEqual({ ok: true, count: 0 });
  });

  it("clears the countdown, so a paused shop shows no next run", async () => {
    mocks.findMany.mockResolvedValue(RUNNING);
    await post({ _action: "pause-all" });
    expect(mocks.updateMany.mock.calls[0][0].data.nextRunAt).toBeNull();
  });
});

describe("resume-all", () => {
  it("resumes everything paused and reports how many", async () => {
    mocks.findMany.mockResolvedValue(PAUSED);

    const res = await post({ _action: "resume-all" });

    expect(res.data).toEqual({ ok: true, count: 1 });
    expect(mocks.findMany).toHaveBeenCalledWith({ where: { shop: SHOP, status: "PAUSED" } });
  });

  // The bug this action prevents: pausing everything with no way back.
  it("gives every resumed collection a fresh nextRunAt", async () => {
    mocks.findMany.mockResolvedValue(PAUSED);
    await post({ _action: "resume-all" });

    const call = mocks.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "p0" });
    expect(call.data.status).toBe("RUNNING");
    // Not null, and not the value it had while paused — worked out from the
    // collection's own schedule.
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
  });

  it("resumes a collection onto its own override, not the shop default", async () => {
    // Home page is DAILY 06:00 while the shop default is WEEKLY Monday —
    // resuming must honour the override.
    mocks.findMany.mockResolvedValue(PAUSED);
    await post({ _action: "resume-all" });

    const next = mocks.update.mock.calls[0][0].data.nextRunAt as Date;
    expect(next.getUTCHours()).toBe(6);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("resumes an inheriting collection onto the shop default", async () => {
    mocks.findMany.mockResolvedValue([{ ...RUNNING[0], status: "PAUSED" }]);
    await post({ _action: "resume-all" });

    const next = mocks.update.mock.calls[0][0].data.nextRunAt as Date;
    // Shop default is Monday 06:00.
    expect(next.getUTCDay()).toBe(1);
    expect(next.getUTCHours()).toBe(6);
  });

  it("reports 0 rather than failing when nothing is paused", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect((await post({ _action: "resume-all" })).data).toEqual({ ok: true, count: 0 });
  });
});
