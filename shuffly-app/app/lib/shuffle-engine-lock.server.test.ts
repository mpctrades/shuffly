import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig } from "@prisma/client";

const mocks = vi.hoisted(() => ({ runCreate: vi.fn(), getProducts: vi.fn() }));

vi.mock("../db.server", () => ({ default: { shuffleRun: { create: mocks.runCreate } } }));
// The collection is busy: another run holds its lock.
vi.mock("./run-lock.server", () => ({ withRunLock: async () => ({ locked: false }) }));
vi.mock("./collections.server", () => ({
  getCollectionProductsInOrder: mocks.getProducts,
  diffToMoves: vi.fn(),
  reorderCollectionProducts: vi.fn(),
  restoreCollectionSort: vi.fn(),
  setCollectionManualSort: vi.fn(),
  unpackProductIds: vi.fn(),
}));
vi.mock("./insights.server", () => ({
  recordProductPositions: vi.fn(),
  recordKnownProducts: vi.fn(),
  invalidateInsightsCache: vi.fn(),
}));

import { runShuffleForCollection, SKIPPED_IN_PROGRESS_MESSAGE } from "./shuffle-engine.server";

const admin = {} as AdminApiContext;
const config = { id: "c1", collectionGid: "gid://shopify/Collection/1" } as CollectionConfig;

describe("a run that finds its collection busy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a scheduled slot is skipped and logged as such, without touching Shopify", async () => {
    const summary = await runShuffleForCollection(admin, "s.myshopify.com", config, "UTC", "", "SCHEDULED", "b1");
    expect(summary).toMatchObject({ ok: false, skipped: true });
    expect(mocks.getProducts).not.toHaveBeenCalled();
    expect(mocks.runCreate).toHaveBeenCalledTimes(1);
    expect(mocks.runCreate.mock.calls[0][0].data).toMatchObject({
      trigger: "SCHEDULED",
      status: "SKIPPED",
      messageCode: "SKIPPED_IN_PROGRESS",
      message: SKIPPED_IN_PROGRESS_MESSAGE,
    });
    expect(SKIPPED_IN_PROGRESS_MESSAGE).toBe("Skipped — previous run still in progress");
  });

  it("the new-products trigger is skipped and logged the same way", async () => {
    await runShuffleForCollection(admin, "s.myshopify.com", config, "UTC", "", "NEW_PRODUCTS");
    expect(mocks.runCreate.mock.calls[0][0].data).toMatchObject({ trigger: "NEW_PRODUCTS", status: "SKIPPED" });
  });

  it("Shuffle now is told immediately and leaves no Activity row", async () => {
    const summary = await runShuffleForCollection(admin, "s.myshopify.com", config, "UTC", "", "MANUAL");
    expect(summary).toMatchObject({ ok: false, skipped: true, error: "IN_PROGRESS" });
    expect(summary.message).toMatch(/already running/);
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });
});
