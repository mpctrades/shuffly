import { describe, expect, it } from "vitest";
import { planIdFromSubscriptionName, managedPricingUrl } from "./billing.server";

// Only the two pure functions are tested here — reconcilePlanFromSubscriptions
// and previewDowngradeImpact both hit the real Prisma db and belong in an
// integration test against a real (test) database instead of a unit test, and
// fetchAppHandle needs an Admin GraphQL client.
describe("planIdFromSubscriptionName", () => {
  it("maps the managed-pricing plan titles, whatever their casing", () => {
    // These are the exact strings the Partner Dashboard plans produce.
    expect(planIdFromSubscriptionName("Free")).toBe("FREE");
    expect(planIdFromSubscriptionName("Starter")).toBe("STARTER");
    expect(planIdFromSubscriptionName("PRO")).toBe("PRO");
  });

  it("maps the legacy Billing API names to the same PlanIds", () => {
    expect(planIdFromSubscriptionName("STARTER")).toBe("STARTER");
    expect(planIdFromSubscriptionName("PRO")).toBe("PRO");
    expect(planIdFromSubscriptionName("AGENCY")).toBe("AGENCY");
  });

  it("ignores a billing-cycle suffix, so annual is the same plan", () => {
    expect(planIdFromSubscriptionName("STARTER_ANNUAL")).toBe("STARTER");
    expect(planIdFromSubscriptionName("PRO_ANNUAL")).toBe("PRO");
    expect(planIdFromSubscriptionName("AGENCY_ANNUAL")).toBe("AGENCY");
    expect(planIdFromSubscriptionName("Starter (yearly)")).toBe("STARTER");
    expect(planIdFromSubscriptionName("Pro — Annual")).toBe("PRO");
    expect(planIdFromSubscriptionName("Starter monthly")).toBe("STARTER");
  });

  it("defaults to FREE for undefined, empty, or unrecognized names", () => {
    // FREE is the safe default: an unrecognized name must never silently
    // grant paid entitlements.
    expect(planIdFromSubscriptionName(undefined)).toBe("FREE");
    expect(planIdFromSubscriptionName("")).toBe("FREE");
    expect(planIdFromSubscriptionName("SOME_OTHER_CHARGE")).toBe("FREE");
  });
});

// Shopify runs every plan change on this page under managed pricing, so a
// wrong URL here is the whole feature broken — it has to be the admin host,
// keyed by store handle and app handle.
describe("managedPricingUrl", () => {
  it("builds the admin pricing-plans URL from the shop domain", () => {
    expect(managedPricingUrl("shuffly-kd37m7ec.myshopify.com", "shuffly")).toBe(
      "https://admin.shopify.com/store/shuffly-kd37m7ec/charges/shuffly/pricing_plans",
    );
  });

  it("strips the .myshopify.com suffix case-insensitively", () => {
    expect(managedPricingUrl("Demo-Store.MyShopify.com", "shuffly")).toBe(
      "https://admin.shopify.com/store/Demo-Store/charges/shuffly/pricing_plans",
    );
  });

  it("returns null without an app handle rather than guessing one", () => {
    // A guessed handle lands the merchant on an unrelated admin page, so the
    // Plan page shows a banner instead of a button that goes nowhere.
    expect(managedPricingUrl("demo.myshopify.com", null)).toBeNull();
    expect(managedPricingUrl("demo.myshopify.com", "")).toBeNull();
  });
});
