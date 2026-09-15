// Covers the reconciliation gap the plan audit found: it used to happen in
// exactly one place, the Plan page's loader, so a shop that downgraded or
// whose trial lapsed kept its paid collection cap, pins and undo retention
// indefinitely unless somebody opened that page.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  enforceCap: vi.fn(),
  enforceEntitlements: vi.fn(),
  check: vi.fn(),
}));

vi.mock("../db.server", () => ({
  default: { shopSettings: { findUnique: mocks.findUnique, update: mocks.update } },
}));

vi.mock("./plans.server", () => ({
  enforcePlanCollectionCap: mocks.enforceCap,
  enforcePlanEntitlements: mocks.enforceEntitlements,
}));

import { syncPlanIfStale } from "./billing.server";

const SHOP = "shuffly-test.myshopify.com";
const NOW = new Date("2026-09-09T12:00:00Z");
const STALE = new Date(NOW.getTime() - 60 * 60_000); // an hour old
const FRESH = new Date(NOW.getTime() - 60_000); // a minute old

const billing = { check: mocks.check };

/** One active subscription, named the way Shopify reports it. */
function subscribed(name: string) {
  return { appSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockImplementation(async ({ data }) => ({ shop: SHOP, ...data }));
  mocks.check.mockResolvedValue({ appSubscriptions: [] });
});

describe("syncPlanIfStale", () => {
  it("does not ask Shopify while the cached plan is still fresh", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "STARTER", planUpdatedAt: FRESH });

    expect(await syncPlanIfStale(SHOP, billing, { now: NOW })).toBeNull();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("asks Shopify once the cached plan is stale", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "STARTER", planUpdatedAt: STALE });
    mocks.check.mockResolvedValue(subscribed("STARTER"));

    const result = await syncPlanIfStale(SHOP, billing, { now: NOW });
    expect(mocks.check).toHaveBeenCalledWith({ isTest: true });
    expect(result).toEqual({ planId: "STARTER", changed: false });
  });

  it("asks Shopify when the plan has never been checked", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "FREE", planUpdatedAt: null });
    await syncPlanIfStale(SHOP, billing, { now: NOW });
    expect(mocks.check).toHaveBeenCalled();
  });

  it("re-checks a fresh plan when forced", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "PRO", planUpdatedAt: FRESH });
    mocks.check.mockResolvedValue(subscribed("PRO"));
    await syncPlanIfStale(SHOP, billing, { now: NOW, force: true });
    expect(mocks.check).toHaveBeenCalled();
  });

  // The scenario from the audit: a paying shop stops paying.
  it("drops a lapsed subscription to Free and reconciles what it was owed", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "STARTER", planUpdatedAt: STALE });
    mocks.check.mockResolvedValue({ appSubscriptions: [] }); // trial expired, nothing active

    const result = await syncPlanIfStale(SHOP, billing, { now: NOW });

    expect(result).toEqual({ planId: "FREE", changed: true });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shop: SHOP }, data: expect.objectContaining({ plan: "FREE" }) }),
    );
    // The clamps are the whole point: 80 collections on Free must not keep
    // shuffling, and a Free shop must not keep pins or a daily cadence.
    expect(mocks.enforceCap).toHaveBeenCalledWith(SHOP, "FREE");
    expect(mocks.enforceEntitlements).toHaveBeenCalledWith(SHOP, "FREE");
  });

  it("reconciles a downgrade between paid tiers too", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "PRO", planUpdatedAt: STALE });
    mocks.check.mockResolvedValue(subscribed("STARTER"));

    const result = await syncPlanIfStale(SHOP, billing, { now: NOW });
    expect(result).toEqual({ planId: "STARTER", changed: true });
    expect(mocks.enforceEntitlements).toHaveBeenCalledWith(SHOP, "STARTER");
  });

  it("does not pause or rewrite anything when the plan has not moved", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "PRO", planUpdatedAt: STALE });
    mocks.check.mockResolvedValue(subscribed("PRO"));

    await syncPlanIfStale(SHOP, billing, { now: NOW });
    // Clamps pause collections and rewrite schedules — not something to do
    // speculatively on every page load.
    expect(mocks.enforceCap).not.toHaveBeenCalled();
    expect(mocks.enforceEntitlements).not.toHaveBeenCalled();
  });

  it("treats an annual subscription as the same tier", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "FREE", planUpdatedAt: STALE });
    mocks.check.mockResolvedValue(subscribed("STARTER_ANNUAL"));

    const result = await syncPlanIfStale(SHOP, billing, { now: NOW });
    expect(result).toEqual({ planId: "STARTER", changed: true });
  });

  it("treats a retired plan name as Free rather than granting it", async () => {
    mocks.findUnique.mockResolvedValue({ plan: "PRO", planUpdatedAt: STALE });
    mocks.check.mockResolvedValue(subscribed("AGENCY"));

    expect(await syncPlanIfStale(SHOP, billing, { now: NOW })).toEqual({ planId: "FREE", changed: true });
  });

  it("does nothing for a shop with no settings row yet", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await syncPlanIfStale(SHOP, billing, { now: NOW })).toBeNull();
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
