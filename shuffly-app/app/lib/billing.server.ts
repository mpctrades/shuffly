// Bridges Shopify's real Billing API (admin.billing.* — see the Plan
// screen, app/routes/app.plan.tsx) to Shuffly's own ShopSettings.plan
// cache, and previews what a downgrade would pause before it happens.
//
// Shopify is the source of truth for "is this shop actually paying" —
// ShopSettings.plan/activeSubscriptionId is just a fast local copy of that,
// refreshed every time the Plan page loads (reconcilePlanFromSubscriptions
// below) so the rest of the app (collection caps, schedule granularity)
// never has to call the Billing API itself.
import db from "../db.server";
import { planOf, type PlanId } from "./plans";

// Both the monthly and annual subscription names (see BILLING_PLANS in
// shopify.server.ts) resolve back to the same PlanId — a merchant on the
// annual Starter plan is still just "STARTER" as far as feature gating and
// ShopSettings.plan are concerned.
const SUBSCRIPTION_NAME_TO_PLAN: Record<string, PlanId> = {
  STARTER: "STARTER",
  STARTER_ANNUAL: "STARTER",
  PRO: "PRO",
  PRO_ANNUAL: "PRO",
  AGENCY: "AGENCY",
  AGENCY_ANNUAL: "AGENCY",
};

export interface ActiveSubscriptionLike {
  id: string;
  name: string;
  /** ISO date-time string — Shopify's own `currentPeriodEnd`. */
  currentPeriodEnd?: string;
  lineItems?: Array<{
    plan?: {
      pricingDetails?: {
        price?: { amount: number; currencyCode: string };
        interval?: string; // "EVERY_30_DAYS" | "ANNUAL"
      };
    };
  }>;
}

export interface BillingSummary {
  /** Next charge date, human-readable — null when there's nothing billed
   * (Free plan, or the reconcile call failed to find pricing details). */
  nextChargeDate: string | null;
  nextChargeAmount: number | null;
  nextChargeCurrency: string | null;
  isAnnual: boolean;
}

/** Shopify's own name for the plan the merchant approved — map it back to
 * one of Shuffly's four PlanIds. Unknown/no subscription = FREE. */
export function planIdFromSubscriptionName(name: string | undefined): PlanId {
  if (!name) return "FREE";
  return SUBSCRIPTION_NAME_TO_PLAN[name] ?? "FREE";
}

/** Reconcile ShopSettings against whatever `billing.check()` actually
 * reports as active, so a merchant who approved or cancelled a charge
 * outside this exact page load (an abandoned checkout tab, a webhook race)
 * still sees the right thing here. Cheap even when nothing changed. Also
 * returns a display-ready summary of the active subscription for the Plan
 * page's Billing card ("Next charge", "Annual"). */
export async function reconcilePlanFromSubscriptions(
  shop: string,
  activeSubscriptions: ActiveSubscriptionLike[],
): Promise<{ planId: PlanId; subscriptionId: string | null; billing: BillingSummary }> {
  // Shuffly only ever requests one plan at a time, so there's at most one
  // relevant subscription — but be defensive if Shopify ever reports more.
  const active = activeSubscriptions[0];
  const planId = planIdFromSubscriptionName(active?.name);
  const subscriptionId = active?.id ?? null;
  const pricing = active?.lineItems?.[0]?.plan?.pricingDetails;

  await db.shopSettings.update({
    where: { shop },
    data: { plan: planId, activeSubscriptionId: subscriptionId, planUpdatedAt: new Date() },
  });

  return {
    planId,
    subscriptionId,
    billing: {
      nextChargeDate: active?.currentPeriodEnd
        ? new Date(active.currentPeriodEnd).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : null,
      nextChargeAmount: pricing?.price?.amount ?? null,
      nextChargeCurrency: pricing?.price?.currencyCode ?? null,
      isAnnual: pricing?.interval === "ANNUAL",
    },
  };
}

/** Dry run for "what would switching to `targetPlanId` pause right now" —
 * same rule as plans.server.ts's enforcePlanCollectionCap (oldest-tracked
 * collections keep their spot) but without writing anything, so the
 * downgrade confirm modal can show it before the merchant commits. */
export async function previewDowngradeImpact(
  shop: string,
  targetPlanId: PlanId,
): Promise<string[]> {
  const plan = planOf(targetPlanId);
  if (plan.maxCollections === Infinity) return [];

  const running = await db.collectionConfig.findMany({
    where: { shop, status: "RUNNING" },
    orderBy: { createdAt: "asc" },
  });
  return running.slice(plan.maxCollections).map((c) => c.title);
}
