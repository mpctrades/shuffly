// Covers reactToSoldOutProduct's idempotency guard: products/update and
// inventory_levels/update both funnel through this one function for the same
// underlying inventory change, and can arrive close together for the same
// product. Without the guard, each arrival re-writes Shopify and logs a
// duplicate ShuffleRun row for a move that already happened.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  runCreate: vi.fn(),
  transaction: vi.fn(),
  getCollectionGidsContainingProduct: vi.fn(),
  reorderCollectionProducts: vi.fn(),
}));

vi.mock("../db.server", () => ({
  default: {
    collectionConfig: { findMany: mocks.findMany, update: mocks.update },
    shuffleRun: { create: mocks.runCreate },
    $transaction: mocks.transaction,
  },
}));

vi.mock("./collections.server", () => ({
  getCollectionGidsContainingProduct: mocks.getCollectionGidsContainingProduct,
  reorderCollectionProducts: mocks.reorderCollectionProducts,
}));

import { reactToSoldOutProduct } from "./sold-out-reaction.server";

const SHOP = "shuffly-test.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";
const admin = { graphql: vi.fn() } as unknown as Parameters<typeof reactToSoldOutProduct>[0];

function config(overrides: Partial<{ id: string; collectionGid: string; lastKnownOrder: string | null }> = {}) {
  return {
    id: "c1",
    shop: SHOP,
    collectionGid: "gid://shopify/Collection/1",
    status: "RUNNING",
    pushSoldOutToEnd: true,
    lastKnownOrder: null,
    ...overrides,
  };
}

describe("reactToSoldOutProduct", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // $transaction just runs each of the passed-in promises, same shape as
    // Prisma's real behavior for an array of prepared queries.
    mocks.transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));
  });

  it("does nothing when the product isn't in any tracked collection", async () => {
    mocks.getCollectionGidsContainingProduct.mockResolvedValue([]);

    await reactToSoldOutProduct(admin, SHOP, PRODUCT);

    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.reorderCollectionProducts).not.toHaveBeenCalled();
  });

  it("moves the product to the end and logs a run when it has never reacted before", async () => {
    mocks.getCollectionGidsContainingProduct.mockResolvedValue(["gid://shopify/Collection/1"]);
    mocks.findMany.mockResolvedValue([config({ lastKnownOrder: null })]);
    mocks.reorderCollectionProducts.mockResolvedValue({ ok: true });

    await reactToSoldOutProduct(admin, SHOP, PRODUCT);

    expect(mocks.reorderCollectionProducts).toHaveBeenCalledTimes(1);
    expect(mocks.reorderCollectionProducts).toHaveBeenCalledWith(admin, "gid://shopify/Collection/1", [
      { id: PRODUCT, newPosition: "999999" },
    ]);
    expect(mocks.runCreate).toHaveBeenCalledTimes(1);
    expect(mocks.runCreate.mock.calls[0][0].data).toMatchObject({ trigger: "SOLD_OUT_REACTION", status: "OK" });
    // No prior order to update against — nothing to reconcile.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("skips a collection where this product is already the last thing written to Shopify", async () => {
    mocks.getCollectionGidsContainingProduct.mockResolvedValue(["gid://shopify/Collection/1"]);
    mocks.findMany.mockResolvedValue([
      config({ lastKnownOrder: JSON.stringify(["gid://shopify/Product/9", PRODUCT]) }),
    ]);

    await reactToSoldOutProduct(admin, SHOP, PRODUCT);

    expect(mocks.reorderCollectionProducts).not.toHaveBeenCalled();
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  it("reacts when the product is in lastKnownOrder but not already at the end, and moves it there", async () => {
    mocks.getCollectionGidsContainingProduct.mockResolvedValue(["gid://shopify/Collection/1"]);
    mocks.findMany.mockResolvedValue([
      config({ lastKnownOrder: JSON.stringify([PRODUCT, "gid://shopify/Product/9"]) }),
    ]);
    mocks.reorderCollectionProducts.mockResolvedValue({ ok: true });

    await reactToSoldOutProduct(admin, SHOP, PRODUCT);

    expect(mocks.reorderCollectionProducts).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { lastKnownOrder: JSON.stringify(["gid://shopify/Product/9", PRODUCT]) },
    });
  });

  it("logs a failed run and leaves lastKnownOrder untouched when the Shopify write fails", async () => {
    mocks.getCollectionGidsContainingProduct.mockResolvedValue(["gid://shopify/Collection/1"]);
    mocks.findMany.mockResolvedValue([
      config({ lastKnownOrder: JSON.stringify(["gid://shopify/Product/9"]) }),
    ]);
    mocks.reorderCollectionProducts.mockResolvedValue({ ok: false, error: "rate limited" });

    await reactToSoldOutProduct(admin, SHOP, PRODUCT);

    expect(mocks.runCreate.mock.calls[0][0].data).toMatchObject({ trigger: "SOLD_OUT_REACTION", status: "FAILED" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
