import { describe, expect, it } from "vitest";
import { planIdFromSubscriptionName } from "./billing.server";

// Only planIdFromSubscriptionName is tested here — reconcilePlanFromSubscriptions
// and previewDowngradeImpact both hit the real Prisma db and belong in an
// integration test against a real (test) database instead of a unit test.
describe("planIdFromSubscriptionName", () => {
  it("maps both the monthly and annual subscription names to the same PlanId", () => {
    expect(planIdFromSubscriptionName("STARTER")).toBe("STARTER");
    expect(planIdFromSubscriptionName("STARTER_ANNUAL")).toBe("STARTER");
    expect(planIdFromSubscriptionName("PRO")).toBe("PRO");
    expect(planIdFromSubscriptionName("PRO_ANNUAL")).toBe("PRO");
    expect(planIdFromSubscriptionName("AGENCY")).toBe("AGENCY");
    expect(planIdFromSubscriptionName("AGENCY_ANNUAL")).toBe("AGENCY");
  });

  it("defaults to FREE for undefined, empty, or unrecognized names", () => {
    expect(planIdFromSubscriptionName(undefined)).toBe("FREE");
    expect(planIdFromSubscriptionName("")).toBe("FREE");
    expect(planIdFromSubscriptionName("SOME_OTHER_CHARGE")).toBe("FREE");
  });
});
