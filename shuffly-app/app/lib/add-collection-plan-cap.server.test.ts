// Covers the plan-cap backstop on every "add a collection" action.
//
// The pre-check against `existingCount` in each of these actions reads the
// count and inserts in two separate steps — not atomic, so two concurrent
// adds can both pass the check and both insert, landing the shop over its
// plan's limit. enforcePlanCollectionCap (already used for a plan downgrade)
// is called again after every add as the real backstop: it pauses whatever
// ends up over the cap, oldest-tracked kept, regardless of how it got there.
// This drives the real route action against a mocked db, same as
// pause-all.server.test.ts, so enforcePlanCollectionCap runs for real rather
// than being asserted as "called".
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  getOrCreateShopSettings: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  runCreate: vi.fn(),
  transaction: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  setCollectionManualSort: vi.fn(),
}));

vi.mock("../shopify.server", () => ({ authenticate: { admin: mocks.authenticateAdmin } }));

vi.mock("../db.server", () => ({
  default: {
    collectionConfig: {
      findMany: mocks.findMany,
      upsert: mocks.upsert,
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
  setCollectionManualSort: mocks.setCollectionManualSort,
  restoreOnRemove: vi.fn(),
  listAllCollections: vi.fn(),
  fetchSortOrders: vi.fn(),
  captureOriginalOrder: vi.fn().mockResolvedValue(null),
  mapWithLimit: async <T, R>(items: T[], _limit: number, fn: (item: T) => Promise<R>) => Promise.all(items.map(fn)),
}));
vi.mock("@shopify/app-bridge-react", () => ({ useAppBridge: () => ({}) }));

import { action } from "../routes/app.collections";

const SHOP = "shuffly-test.myshopify.com";

function post(fields: Record<string, string | string[]>) {
  const url = new URL("https://example.com/app/collections");
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
  }
  return action({
    request: new Request(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
    url,
    pattern: "/app/collections",
    params: {},
    context: {} as ActionFunctionArgs["context"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the action only needs `request`
  } as any) as unknown as Promise<any>;
}

/** Free's cap is 25 (see plans.ts) — 26 already-RUNNING rows, oldest first,
 * standing in for "a concurrent request already filled every slot". */
const OVER_CAP_RUNNING = Array.from({ length: 26 }, (_, i) => ({
  id: `c${i}`,
  title: `Collection ${i}`,
  status: "RUNNING",
  createdAt: new Date(2024, 0, i + 1),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({ admin: {}, session: { shop: SHOP } });
  mocks.getOrCreateShopSettings.mockResolvedValue({
    shop: SHOP,
    plan: "FREE",
    timezone: "UTC",
    neverMoveTags: "",
    pageSize: 24,
    defaultScheduleType: "WEEKLY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: 1,
    autoSwitchToManual: false,
  });
  mocks.transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));
  mocks.upsert.mockResolvedValue({ id: "new1" });
  mocks.update.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe("plan-cap backstop after adding", () => {
  it("add-untracked pauses the overflow when the shop is already over cap by the time it runs", async () => {
    mocks.count.mockResolvedValue(0); // pre-check sees room
    mocks.findMany.mockResolvedValue(OVER_CAP_RUNNING); // enforcePlanCollectionCap's own read, over a cap of...

    await post({ _action: "add-untracked", gid: "gid://shopify/Collection/9", title: "New" });

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    // The backstop actually ran and found something to pause.
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it("does nothing extra when the shop ends up within its cap", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([OVER_CAP_RUNNING[0]]); // well within Starter's 25

    await post({ _action: "add-untracked", gid: "gid://shopify/Collection/9", title: "New" });

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("switch-and-add also runs the backstop after a successful switch", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.setCollectionManualSort.mockResolvedValue({ ok: true, previousSortOrder: "BEST_SELLING" });
    mocks.findMany.mockResolvedValue(OVER_CAP_RUNNING);

    await post({ _action: "switch-and-add", gid: "gid://shopify/Collection/9", title: "New", keepOrder: "true" });

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it("add-all-untracked runs the backstop once after adding several", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue(OVER_CAP_RUNNING);

    await post({
      _action: "add-all-untracked",
      gid: ["gid://shopify/Collection/9", "gid://shopify/Collection/10"],
      title: ["New A", "New B"],
      sortOrder: ["MANUAL", "MANUAL"],
    });

    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it("add-all-untracked skips the backstop entirely when nothing was added", async () => {
    mocks.count.mockResolvedValue(999); // no room at all — plan.maxCollections - existingCount clamps to 0

    await post({
      _action: "add-all-untracked",
      gid: ["gid://shopify/Collection/9"],
      title: ["New A"],
      sortOrder: ["MANUAL"],
    });

    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled(); // enforcePlanCollectionCap never even queried
  });
});
