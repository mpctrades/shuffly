import { describe, expect, it } from "vitest";
import {
  PLANS,
  annualMonthlyEquivalent,
  annualPrice,
  PLAN_TIERS,
  cadenceLabel,
  collectionCapLabel,
  defaultScheduleForPlan,
  isTopPlan,
  nextPlanOf,
  overLimitCount,
  planOf,
  timeSlots,
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
    const order: Array<keyof typeof PLANS> = ["FREE", "STARTER", "PRO"];
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
  });

  it("only Pro unlocks TWICE_DAILY", () => {
    expect(PLANS.FREE.allowedSchedules).not.toContain("TWICE_DAILY");
    expect(PLANS.STARTER.allowedSchedules).not.toContain("TWICE_DAILY");
    expect(PLANS.PRO.allowedSchedules).toContain("TWICE_DAILY");
  });
});

describe("isTopPlan", () => {
  it("only treats the most expensive plan as the top one", () => {
    expect(isTopPlan("FREE")).toBe(false);
    expect(isTopPlan("STARTER")).toBe(false);
    expect(isTopPlan("PRO")).toBe(true);
  });

  it("hides Upgrade for exactly one plan, whatever the tiers are", () => {
    const tops = Object.values(PLANS).filter((p) => isTopPlan(p.id));
    expect(tops).toHaveLength(1);
  });

  it("shows Upgrade on an unknown plan rather than hiding it", () => {
    expect(isTopPlan("SOMETHING_ELSE")).toBe(false);
  });
});

describe("cadenceLabel", () => {
  it("describes each plan from the schedules it actually allows", () => {
    // Free's allowedSchedules are ["WEEKLY", "MANUAL"] — it cannot pick a
    // daily shuffle, so the copy must not claim one.
    expect(cadenceLabel("FREE")).toBe("Weekly shuffle");
    expect(cadenceLabel("STARTER")).toBe("1 shuffle a day");
    expect(cadenceLabel("PRO")).toBe("2 shuffles a day");
  });

  it("never claims a cadence the plan doesn't allow", () => {
    for (const plan of Object.values(PLANS)) {
      const label = cadenceLabel(plan.id);
      if (label === "2 shuffles a day") expect(plan.allowedSchedules).toContain("TWICE_DAILY");
      if (label === "1 shuffle a day") expect(plan.allowedSchedules).toContain("DAILY");
      if (label === "Weekly shuffle") expect(plan.allowedSchedules).toContain("WEEKLY");
    }
  });

  it("falls back to the Free line for an unknown plan", () => {
    expect(cadenceLabel("SOMETHING_ELSE")).toBe("Weekly shuffle");
    expect(cadenceLabel(null)).toBe("Weekly shuffle");
  });
});

describe("timeSlots", () => {
  it("gives two slots only to plans that allow a twice-daily schedule", () => {
    expect(timeSlots("FREE")).toBe(1);
    expect(timeSlots("STARTER")).toBe(1);
    expect(timeSlots("PRO")).toBe(2);
  });

  it("agrees with the entitlement the schedule picker gates on", () => {
    for (const plan of Object.values(PLANS)) {
      expect(timeSlots(plan.id) === 2).toBe(plan.allowedSchedules.includes("TWICE_DAILY"));
    }
  });
});

describe("PLAN_TIERS", () => {
  it("lists every plan exactly once", () => {
    expect(PLAN_TIERS).toHaveLength(Object.keys(PLANS).length);
    expect(new Set(PLAN_TIERS.map((p) => p.id)).size).toBe(PLAN_TIERS.length);
  });

  it("is ordered cheapest first", () => {
    const prices = PLAN_TIERS.map((p) => p.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("puts Free first and Pro last, matching the ladder the bar renders", () => {
    expect(PLAN_TIERS.map((p) => p.id)).toEqual(["FREE", "STARTER", "PRO"]);
  });
});

describe("nextPlanOf", () => {
  it("returns the tier directly above each plan", () => {
    expect(nextPlanOf("FREE")?.id).toBe("STARTER");
    expect(nextPlanOf("STARTER")?.id).toBe("PRO");
  });

  it("returns null on the top plan, so no dead upgrade button is rendered", () => {
    expect(nextPlanOf("PRO")).toBeNull();
  });

  it("agrees with isTopPlan for every plan", () => {
    for (const plan of Object.values(PLANS)) {
      expect(isTopPlan(plan.id)).toBe(nextPlanOf(plan.id) === null);
    }
  });
});

describe("collectionCapLabel", () => {
  it("states the cap the app actually enforces", () => {
    expect(collectionCapLabel("FREE")).toBe("25 collections");
    expect(collectionCapLabel("STARTER")).toBe("100 collections");
  });

  it("reads as Unlimited rather than a number for an uncapped plan", () => {
    expect(collectionCapLabel("PRO")).toBe("Unlimited collections");
  });

  it("matches maxCollections for every plan", () => {
    for (const plan of Object.values(PLANS)) {
      const label = collectionCapLabel(plan.id);
      expect(label).toBe(
        plan.maxCollections === Infinity ? "Unlimited collections" : `${plan.maxCollections} collections`,
      );
    }
  });
});

describe("overLimitCount", () => {
  it("is zero while inside the cap", () => {
    expect(overLimitCount("FREE", 25)).toBe(0);
    expect(overLimitCount("FREE", 7)).toBe(0);
  });

  it("counts only the collections beyond the cap", () => {
    expect(overLimitCount("FREE", 27)).toBe(2);
    expect(overLimitCount("FREE", 26)).toBe(1);
    expect(overLimitCount("STARTER", 101)).toBe(1);
  });

  it("is always zero on an uncapped plan", () => {
    expect(overLimitCount("PRO", 5000)).toBe(0);
  });
});

describe("a retired plan id", () => {
  it("is no longer a known plan", () => {
    expect(Object.keys(PLANS)).toEqual(["FREE", "STARTER", "PRO"]);
    expect("AGENCY" in PLANS).toBe(false);
  });

  it("degrades to Free rather than granting paid entitlements", () => {
    // If a stored ShopSettings.plan or a Shopify subscription name ever says
    // AGENCY again, it must fall through to the least-privileged plan — not
    // hand out unlimited collections on a plan the app no longer sells.
    expect(planOf("AGENCY").id).toBe("FREE");
    expect(cadenceLabel("AGENCY")).toBe("Weekly shuffle");
    expect(timeSlots("AGENCY")).toBe(1);
    expect(collectionCapLabel("AGENCY")).toBe("25 collections");
  });

  it("still gets an upgrade path rather than being stranded at the top", () => {
    expect(isTopPlan("AGENCY")).toBe(false);
    expect(nextPlanOf("AGENCY")?.id).toBe("STARTER");
  });
});
