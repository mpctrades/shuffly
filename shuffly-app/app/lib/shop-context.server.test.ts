// The timezone self-heal, driven in CI.
//
// Two screens depend on this being right — the Collections page and the
// Settings page both format every "next run" in whatever it returns — and
// its failure mode is silent: a wrong timezone renders a perfectly
// plausible time that is simply hours off. Nothing about the page looks
// broken, so only a test catches it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getShopTimezone: vi.fn(),
  shopSettingsUpdate: vi.fn(),
  shopSettingsFindUnique: vi.fn(),
  shopSettingsCreate: vi.fn(),
}));

vi.mock("./collections.server", () => ({ getShopTimezone: mocks.getShopTimezone }));

vi.mock("../db.server", () => ({
  default: {
    shopSettings: {
      update: mocks.shopSettingsUpdate,
      findUnique: mocks.shopSettingsFindUnique,
      create: mocks.shopSettingsCreate,
    },
  },
}));

import { confirmShopTimezone } from "./shop-context.server";

const SHOP = "shuffly-test.myshopify.com";
// The helper only passes this through to getShopTimezone, which is mocked.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the real AdminApiContext is a live GraphQL client
const admin = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shopSettingsUpdate.mockResolvedValue({});
});

describe("confirmShopTimezone", () => {
  it("repairs the cached column when the shop has moved timezone", async () => {
    mocks.getShopTimezone.mockResolvedValue("Asia/Seoul");

    const result = await confirmShopTimezone(admin, SHOP, "America/New_York");

    expect(result).toEqual({ timezone: "Asia/Seoul", error: null });
    expect(mocks.shopSettingsUpdate).toHaveBeenCalledWith({
      where: { shop: SHOP },
      data: { timezone: "Asia/Seoul" },
    });
  });

  it("writes nothing when the cache is already correct", async () => {
    mocks.getShopTimezone.mockResolvedValue("Asia/Seoul");

    const result = await confirmShopTimezone(admin, SHOP, "Asia/Seoul");

    expect(result).toEqual({ timezone: "Asia/Seoul", error: null });
    // A write on every page load of both screens, for a value that changes
    // maybe once in a shop's lifetime.
    expect(mocks.shopSettingsUpdate).not.toHaveBeenCalled();
  });

  it("falls back to the cached value when Shopify can't be reached", async () => {
    mocks.getShopTimezone.mockRejectedValue(new Error("503 from Admin API"));

    const result = await confirmShopTimezone(admin, SHOP, "Asia/Seoul");

    // Never a guess, and never a throw: the page still renders on the last
    // known timezone, and the caller is handed something it can show.
    expect(result.timezone).toBe("Asia/Seoul");
    expect(result.error).toMatch(/last known value/);
    expect(mocks.shopSettingsUpdate).not.toHaveBeenCalled();
  });

  it("keeps the cached value when Shopify answers with nothing", async () => {
    mocks.getShopTimezone.mockResolvedValue("");

    const result = await confirmShopTimezone(admin, SHOP, "Asia/Seoul");

    // An empty answer is not a correction — overwriting a real timezone
    // with "" would break every schedule on the shop.
    expect(result).toEqual({ timezone: "Asia/Seoul", error: null });
    expect(mocks.shopSettingsUpdate).not.toHaveBeenCalled();
  });
});
