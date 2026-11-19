import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  writes: [] as Array<{ kind: string; data: Record<string, unknown> }>,
  paused: [] as Array<Record<string, unknown>>,
  liveSort: "BEST_SELLING",
}));

vi.mock("../db.server", () => {
  const rec = (kind: string) => vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.writes.push({ kind, data });
    return data;
  });
  return {
    default: {
      collectionConfig: { update: rec("collection"), findMany: vi.fn(async () => mocks.paused) },
      shuffleRun: { create: rec("run") },
      shopSettings: { findUnique: vi.fn(async () => ({ timezone: "UTC", defaultScheduleType: "DAILY", defaultScheduleTime: "06:00", defaultScheduleTime2: null, defaultScheduleWeekday: null })) },
      $transaction: async (ops: unknown[]) => Promise.all(ops),
    },
  };
});
vi.mock("../shopify.server", () => ({ unauthenticated: { admin: vi.fn(async () => ({ admin: {} })) } }));
vi.mock("./run-lock.server", () => ({
  withRunLock: async (_id: string, work: () => Promise<unknown>) => ({ locked: true, value: await work() }),
}));
vi.mock("./collections.server", () => ({
  getCollectionProductsInOrder: vi.fn(async () => ({ sortOrder: mocks.liveSort, products: [] })),
  fetchSortOrders: vi.fn(async (_admin: unknown, gids: string[]) => new Map(gids.map((g) => [g, { title: "x", sortOrder: mocks.liveSort }]))),
  diffToMoves: vi.fn(),
  reorderCollectionProducts: vi.fn(),
  restoreCollectionSort: vi.fn(),
  setCollectionManualSort: vi.fn(),
  unpackProductIds: vi.fn(),
  packUndoOrder: vi.fn(),
  unpackUndoOrder: vi.fn(),
}));
vi.mock("./insights.server", () => ({
  recordProductPositions: vi.fn(),
  recordKnownProducts: vi.fn(),
  invalidateInsightsCache: vi.fn(),
}));

import { runShuffleForCollection } from "./shuffle-engine.server";
import { resumeSortPausedCollections } from "./sort-pause.server";

const config = { id: "c1", title: "New Arrivals", collectionGid: "gid://shopify/Collection/1", status: "RUNNING" } as CollectionConfig;

beforeEach(() => {
  mocks.writes = [];
  mocks.paused = [];
  mocks.liveSort = "BEST_SELLING";
});

describe("merchant switches the sort back to Best selling", () => {
  it("the run pauses the collection and logs 'Paused — sort order changed'", async () => {
    const summary = await runShuffleForCollection({} as AdminApiContext, "s", config, "UTC", "", "SCHEDULED");
    expect(summary).toMatchObject({ ok: false, error: "NOT_MANUAL", message: "Paused — sort order changed" });
    expect(mocks.writes.find((w) => w.kind === "collection")?.data.sortOrderIssueAt).toBeInstanceOf(Date);
    expect(mocks.writes.find((w) => w.kind === "run")?.data).toMatchObject({
      messageCode: "PAUSED_SORT",
      messageParams: JSON.stringify({ sortOrder: "BEST_SELLING" }),
    });
  });

  it("maintenance resumes it once Shopify reports Manual again", async () => {
    mocks.paused = [{ ...config, shop: "s", sortOrderIssueAt: new Date(), scheduleType: null }];
    mocks.liveSort = "MANUAL";
    expect(await resumeSortPausedCollections(new Date("2026-11-12T10:00:00Z"))).toBe(1);
    expect(mocks.writes.find((w) => w.kind === "collection")?.data).toMatchObject({ sortOrderIssueAt: null });
    expect(mocks.writes.find((w) => w.kind === "run")?.data).toMatchObject({ messageCode: "RESUMED_SORT" });
  });

  it("…and leaves it paused while it's still not Manual", async () => {
    mocks.paused = [{ ...config, shop: "s", sortOrderIssueAt: new Date(), scheduleType: null }];
    expect(await resumeSortPausedCollections()).toBe(0);
    expect(mocks.writes).toEqual([]);
  });
});
