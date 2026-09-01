import { describe, expect, it } from "vitest";
import {
  PLANS,
  annualMonthlyEquivalent,
  annualPrice,
  defaultScheduleForPlan,
  planOf,
  undoRetentionCutoff,
} from "./plans";

describe("planOf", () => {
  it("resolves a known plan id", () => {
    expect(planOf("PRO")).toBe(PLANS.PRO);
  });

  it("defaults to Free for null/undefined", () => {
    expect(planOf(null)).toBe(PLANS.FREE);
    expect(planOf(undefined)).toBe(PLANS.FREE);
  });

  it("defaults to Free for an unrecognized string instead of throwing", () => {
    expect(planOf("NOT_A_REAL_PLAN")).toBe(PLANS.FREE);
    expect(planOf("")).toBe(PLANS.FREE);
  });
});

describe("annualPrice", () => {
  it("charges 10x the monthly price ('2 months free')", () => {
    expect(annualPrice(7.99)).toBeCloseTo(79.9, 2);
    expect(annualPrice(3.99)).toBeCloseTo(39.9, 2);
  });

  it("is 0 for the Free plan", () => {
    expect(annualPrice(0)).toBe(0);
  });

  it("rounds to the nearest cent", () => {
    expect(annualPrice(0.333)).toBeCloseTo(3.33, 2);
  });
});

describe("annualMonthlyEquivalent", () => {
  it("divides the annual price back down to a monthly-equivalent figure below the sticker price", () => {
    const eq = annualMonthlyEquivalent(7.99);
    expect(eq).toBeLessThan(7.99);
    expect(eq).toBeCloseTo(6.66, 2); // 79.90 / 12
  });

  it("is 0 for the Free plan", () => {
    expect(annualMonthlyEquivalent(0)).toBe(0);
  });
});

describe("plan entitlements", () => {
  it("chooses a useful automatic default included in each plan", () => {
    expect(defaultScheduleForPlan("FREE")).toBe("WEEKLY");
    expect(defaultScheduleForPlan("STARTER")).toBe("DAILY");
    expect(defaultScheduleForPlan("PRO")).toBe("DAILY");
  });

  it("calculates the undo cutoff from the active plan", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    expect(undoRetentionCutoff("FREE", now).toISOString()).toBe("2026-08-31T12:00:00.000Z");
    expect(undoRetentionCutoff("STARTER", now).toISOString()).toBe("2026-08-25T12:00:00.000Z");
  });
});

describe("PLANS catalogue sanity", () => {
  it("keeps every plan's schedule/price/limits internally consistent with plan tier ordering", () => {
    const order: Array<keyof typeof PLANS> = ["FREE", "STARTER", "PRO", "AGENCY"];
    for (let i = 1; i < order.length; i++) {
      const prev = PLANS[order[i - 1]];
      const cur = PLANS[order[i]];
      expect(cur.price).toBeGreaterThanOrEqual(prev.price);
      expect(cur.maxCollections).toBeGreaterThanOrEqual(prev.maxCollections);
      expect(cur.undoRetentionDays).toBeGreaterThanOrEqual(prev.undoRetentionDays);
    }
  });

  it("only Free is missing DAILY (its cheapest tier is weekly-only)", () => {
    expect(PLANS.FREE.allowedSchedules).not.toContain("DAILY");
    expect(PLANS.STARTER.allowedSchedules).toContain("DAILY");
    expect(PLANS.PRO.allowedSchedules).toContain("DAILY");
    expect(PLANS.AGENCY.allowedSchedules).toContain("DAILY");
  });

  it("only Pro and Agency unlock TWICE_DAILY", () => {
    expect(PLANS.FREE.allowedSchedules).not.toContain("TWICE_DAILY");
    expect(PLANS.STARTER.allowedSchedules).not.toContain("TWICE_DAILY");
    expect(PLANS.PRO.allowedSchedules).toContain("TWICE_DAILY");
    expect(PLANS.AGENCY.allowedSchedules).toContain("TWICE_DAILY");
  });
});
