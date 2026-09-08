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

export type PlanId = "FREE" | "STARTER" | "PRO";

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

/**
 * Every plan in tier order, cheapest first — derived from PLANS by price so
 * a new tier shows up in the plan ladder and in `nextPlanOf` on its own,
 * with nothing to keep in step by hand.
 */
export const PLAN_TIERS: PlanDefinition[] = Object.values(PLANS).sort((a, b) => a.price - b.price);

/**
 * The tier directly above `planId`, or null when there isn't one. Derived
 * from PLAN_TIERS rather than stored on each plan, so it can never point at
 * a plan that was repriced, reordered or removed.
 */
export function nextPlanOf(planId: string | null | undefined): PlanDefinition | null {
  const current = planOf(planId);
  const index = PLAN_TIERS.findIndex((plan) => plan.id === current.id);
  return index >= 0 && index < PLAN_TIERS.length - 1 ? PLAN_TIERS[index + 1] : null;
}

/** Whether no plan offers more than this one — i.e. whether to hide the
 * Upgrade affordance. Just "there is no tier above you", so it can't
 * disagree with the button the plan bar renders from `nextPlanOf`. */
export function isTopPlan(planId: string | null | undefined): boolean {
  return nextPlanOf(planId) === null;
}

/**
 * How often this plan is allowed to shuffle, read off its own
 * `allowedSchedules` — the very field the scheduler enforces. So the copy
 * can never promise a cadence the app won't actually run. Free's
 * ["WEEKLY", "MANUAL"] is why Free reads "Weekly shuffle" and not a daily
 * figure.
 */
export function cadenceLabel(planId: string | null | undefined): string {
  const plan = planOf(planId);
  if (plan.allowedSchedules.includes("TWICE_DAILY")) return "2 shuffles a day";
  if (plan.allowedSchedules.includes("DAILY")) return "1 shuffle a day";
  if (plan.allowedSchedules.includes("WEEKLY")) return "Weekly shuffle";
  return "Manual only";
}

/**
 * How many merchant-picked shuffle times a collection gets on this plan.
 * This is the single gate for the second time slot: the collection
 * Workspace's picker and the plan bar's "N time slots" both call it, so the
 * UI that offers the slot and the copy that advertises it cannot disagree.
 */
export function timeSlots(planId: string | null | undefined): number {
  return planOf(planId).allowedSchedules.includes("TWICE_DAILY") ? 2 : 1;
}

/** "25 collections" / "Unlimited collections". The noun is part of the
 * label so an uncapped plan doesn't have to read "Unlimited 25 collections". */
export function collectionCapLabel(planId: string | null | undefined): string {
  const cap = planOf(planId).maxCollections;
  return cap === Infinity ? "Unlimited collections" : `${cap} collections`;
}

/** How many tracked collections sit beyond this plan's cap; 0 when inside
 * it, and always 0 on an uncapped plan. */
export function overLimitCount(
  planId: string | null | undefined,
  trackedCount: number,
): number {
  const cap = planOf(planId).maxCollections;
  return cap === Infinity ? 0 : Math.max(0, trackedCount - cap);
}
