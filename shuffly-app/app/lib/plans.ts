// Plan definitions shared by the Plan screen and every place we need to
// gate a feature (collection limits, schedule granularity, undo
// retention). Deliberately NOT a `.server.ts` file — the Plan page's own
// UI (price/feature display, reacting to the monthly/annual toggle)
// imports these directly, and React Router refuses to let client-rendered
// code import anything from a `.server.ts` module. DB-touching plan logic
// (enforcePlanCollectionCap) lives in plans.server.ts instead, which
// re-exports everything here for convenience.
//
// These are wired to Shopify's Billing API in billing.server.ts. Amounts
// here MUST stay in sync with `BILLING_PLANS` in shopify.server.ts.

export type PlanId = "FREE" | "STARTER" | "PRO" | "AGENCY";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  price: number; // USD / month
  maxCollections: number; // Infinity = unlimited
  allowedSchedules: Array<"DAILY" | "TWICE_DAILY" | "WEEKLY" | "MANUAL">;
  undoRetentionDays: number;
  insights: boolean;
  canPin: boolean;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  FREE: {
    id: "FREE",
    name: "Free",
    price: 0,
    maxCollections: 25,
    allowedSchedules: ["WEEKLY", "MANUAL"],
    undoRetentionDays: 1,
    insights: true,
    canPin: false,
  },
  STARTER: {
    id: "STARTER",
    name: "Starter",
    price: 3.99,
    maxCollections: 100,
    allowedSchedules: ["DAILY", "WEEKLY", "MANUAL"],
    undoRetentionDays: 7,
    insights: true,
    canPin: true,
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    price: 7.99,
    maxCollections: Infinity,
    allowedSchedules: ["DAILY", "TWICE_DAILY", "WEEKLY", "MANUAL"],
    undoRetentionDays: 30,
    insights: true,
    canPin: true,
  },
  AGENCY: {
    id: "AGENCY",
    name: "Agency",
    price: 49,
    maxCollections: Infinity,
    allowedSchedules: ["DAILY", "TWICE_DAILY", "WEEKLY", "MANUAL"],
    undoRetentionDays: 30,
    insights: true,
    canPin: true,
  },
};

export function planOf(planId: string | null | undefined): PlanDefinition {
  return PLANS[(planId as PlanId) ?? "FREE"] ?? PLANS.FREE;
}

export function defaultScheduleForPlan(
  planId: string | null | undefined,
): PlanDefinition["allowedSchedules"][number] {
  const plan = planOf(planId);
  if (plan.allowedSchedules.includes("DAILY")) return "DAILY";
  if (plan.allowedSchedules.includes("WEEKLY")) return "WEEKLY";
  return "MANUAL";
}

export function undoRetentionCutoff(
  planId: string | null | undefined,
  now = new Date(),
): Date {
  return new Date(now.getTime() - planOf(planId).undoRetentionDays * 86_400_000);
}

/** "2 months free" — the annual line item charges 10x the monthly price for
 * 12 months of service. Free has no price to annualize. */
export function annualPrice(monthly: number): number {
  return Math.round(monthly * 10 * 100) / 100;
}

export function annualMonthlyEquivalent(monthly: number): number {
  return Math.round((annualPrice(monthly) / 12) * 100) / 100;
}
