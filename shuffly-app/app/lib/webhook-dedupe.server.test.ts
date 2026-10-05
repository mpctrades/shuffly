import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), deleteMany: vi.fn() }));

vi.mock("../db.server", () => ({
  default: { processedWebhook: { create: mocks.create, deleteMany: mocks.deleteMany } },
}));

import { isDuplicateDelivery, pruneProcessedWebhooks } from "./webhook-dedupe.server";

describe("isDuplicateDelivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a first delivery and lets it through", async () => {
    mocks.create.mockResolvedValue({});
    expect(await isDuplicateDelivery("wh-1", "s.myshopify.com", "PRODUCTS_UPDATE")).toBe(false);
    expect(mocks.create).toHaveBeenCalledWith({ data: { id: "wh-1", shop: "s.myshopify.com", topic: "PRODUCTS_UPDATE" } });
  });

  it("flags a delivery whose id is already recorded", async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    expect(await isDuplicateDelivery("wh-1", "s.myshopify.com", "PRODUCTS_UPDATE")).toBe(true);
  });

  it("fails open on any other database error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.create.mockRejectedValue(new Error("database is locked"));
    expect(await isDuplicateDelivery("wh-1", "s.myshopify.com", "PRODUCTS_UPDATE")).toBe(false);
  });

  it("lets a delivery without an id through without recording it", async () => {
    expect(await isDuplicateDelivery(undefined, "s.myshopify.com", "PRODUCTS_UPDATE")).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("pruneProcessedWebhooks", () => {
  it("deletes ids older than 7 days", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-10-08T00:00:00Z");

    expect(await pruneProcessedWebhooks(now)).toBe(3);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { receivedAt: { lt: new Date("2026-10-01T00:00:00Z") } },
    });
  });
});
