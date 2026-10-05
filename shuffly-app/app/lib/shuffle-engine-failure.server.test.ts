import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  runCreate: vi.fn(),
  getCollectionProductsInOrder: vi.fn(),
}));

vi.mock("../db.server", () => ({
  default: { shuffleRun: { create: mocks.runCreate } },
}));

vi.mock("./collections.server", () => ({
  getCollectionProductsInOrder: mocks.getCollectionProductsInOrder,
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

import { runShuffleForCollection } from "./shuffle-engine.server";

const admin = {} as AdminApiContext;
const config = { id: "c1", collectionGid: "gid://shopify/Collection/1" } as CollectionConfig;
const throttled = Object.assign(new Error("Throttled"), {
  name: "GraphqlQueryError",
  body: { errors: { graphQLErrors: [{ extensions: { code: "THROTTLED" } }] } },
});

describe("runShuffleForCollection when Shopify fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("records a FAILED run instead of throwing, with a plain message for a throttle", async () => {
    mocks.getCollectionProductsInOrder.mockRejectedValue(throttled);

    const summary = await runShuffleForCollection(admin, "s.myshopify.com", config, "UTC", "", "SCHEDULED", "batch-1");

    expect(summary.ok).toBe(false);
    expect(summary.message).toMatch(/too busy.*next scheduled time/);
    expect(mocks.runCreate).toHaveBeenCalledTimes(1);
    expect(mocks.runCreate.mock.calls[0][0].data).toMatchObject({
      shop: "s.myshopify.com",
      collectionId: "c1",
      trigger: "SCHEDULED",
      batchId: "batch-1",
      status: "FAILED",
      movedCount: 0,
    });
  });

  it("tells a manual run to try again, and records other errors with their message", async () => {
    mocks.getCollectionProductsInOrder.mockRejectedValueOnce(throttled);
    const manual = await runShuffleForCollection(admin, "s.myshopify.com", config, "UTC", "", "MANUAL");
    expect(manual.message).toMatch(/Try again in a minute/);

    mocks.getCollectionProductsInOrder.mockRejectedValueOnce(new Error("socket hang up"));
    const other = await runShuffleForCollection(admin, "s.myshopify.com", config, "UTC", "", "MANUAL");
    expect(other.message).toBe("Shuffle failed: socket hang up");
    expect(mocks.runCreate).toHaveBeenCalledTimes(2);
  });

  it("still returns a failure if even the failed run can't be recorded", async () => {
    mocks.getCollectionProductsInOrder.mockRejectedValue(new Error("boom"));
    mocks.runCreate.mockRejectedValue(new Error("database is locked"));

    const summary = await runShuffleForCollection(admin, "s.myshopify.com", config, "UTC", "", "MANUAL");

    expect(summary.ok).toBe(false);
  });
});
