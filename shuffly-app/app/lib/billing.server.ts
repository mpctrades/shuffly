// Bridges Shopify's billing state to Shuffly's own ShopSettings.plan cache,
// and previews what a downgrade would pause before it happens.
//
// Shuffly uses **Shopify managed pricing**: the plans live in the Partner
// Dashboard and Shopify renders its own plan-selection page, so this app
// never creates charges itself. Requesting one is in fact refused outright —
// `appSubscriptionCreate` answers "Cannot use the Billing API (to create
// charges) when on Shopify App Pricing." Every plan change therefore hands
// the merchant off to `managedPricingUrl()` below, and Shopify runs the
// approval, replacement, proration and cancellation.
//
// Reading stays ours: `billing.check()` still works under managed pricing,
// so Shopify remains the source of truth for "is this shop actually paying"
// and ShopSettings.plan/activeSubscriptionId is just a fast local copy,
// refreshed every time the Plan page loads (reconcilePlanFromSubscriptions
// below) so the rest of the app (collection caps, schedule granularity)
// never has to ask Shopify itself.
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { planOf, type PlanId } from "./plans";

// Keyed by *normalized* plan name (see normalizeSubscriptionName) so the
// exact spelling Shopify reports doesn't matter. Today it happens to match
// anyway — the Partner Dashboard's "Plan name for merchant invoices", which
// is what `billing.check()` reports, is `STARTER`, `PRO` and `Free` (the
// plans' *display* names on the pricing page are different fields: "Free",
// "Starter", "PRO"). Normalizing is insurance against a rename, and against
// the older Billing API spellings like "STARTER_ANNUAL": all of them have to
// land on the same PlanId, since a merchant on the annual Starter plan is
// still just "STARTER" as far as feature gating and ShopSettings.plan go.
const SUBSCRIPTION_NAME_TO_PLAN: Record<string, PlanId> = {
  FREE: "FREE",
  STARTER: "STARTER",
  PRO: "PRO",
  AGENCY: "AGENCY",
};

/** Case, spacing, punctuation and a trailing billing-cycle word are all
 * noise when deciding which PlanId a subscription is: "PRO", "Pro",
 * "Pro (yearly)" and "PRO_ANNUAL" are one plan. Strips everything that
 * isn't a letter, then drops a cycle suffix. */
function normalizeSubscriptionName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .replace(/(ANNUALLY|ANNUAL|YEARLY|MONTHLY|PERYEAR|PERMONTH)$/, "");
}

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

/** Shopify's own name for the plan the merchant is subscribed to — map it
 * back to one of Shuffly's four PlanIds. Unknown/no subscription = FREE, so
 * an unrecognised plan name never silently grants paid entitlements. */
export function planIdFromSubscriptionName(name: string | undefined): PlanId {
  if (!name) return "FREE";
  return SUBSCRIPTION_NAME_TO_PLAN[normalizeSubscriptionName(name)] ?? "FREE";
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

// ---------------------------------------------------------------------------
// Handing a plan change off to Shopify's managed pricing page
// ---------------------------------------------------------------------------

/** Shopify keys the managed pricing page by the app's *handle*, not its
 * client id — `/charges/<client id>/pricing_plans` just bounces to the
 * generic Apps settings list. The handle isn't in any env var the CLI
 * writes, so read it back from the installation itself. */
const APP_HANDLE_QUERY = `#graphql
  query ShufflyAppHandle {
    currentAppInstallation {
      app {
        handle
      }
    }
  }`;

/** `SHOPIFY_APP_HANDLE` wins when set — it lets a deployment pin the handle
 * without a round trip (and keeps the Plan page working if the query ever
 * starts coming back empty). Otherwise ask Shopify. Returns null when
 * neither source produces one, which the Plan page shows as a banner rather
 * than a dead button. */
export async function fetchAppHandle(admin: AdminApiContext): Promise<string | null> {
  const fromEnv = process.env.SHOPIFY_APP_HANDLE?.trim();
  if (fromEnv) return fromEnv;
  try {
    const res = await admin.graphql(APP_HANDLE_QUERY);
    const json = await res.json();
    return json.data?.currentAppInstallation?.app?.handle ?? null;
  } catch (err) {
    console.error("[billing] couldn't read the app handle:", err);
    return null;
  }
}

/** Shopify's own plan-selection page for this app — where every plan change
 * actually happens under managed pricing. It has to be the *admin* host, not
 * our origin, and it takes the store handle rather than the `.myshopify.com`
 * domain. Returns null without an app handle, since a guessed one would land
 * the merchant on an unrelated page. */
export function managedPricingUrl(shop: string, appHandle: string | null): string | null {
  if (!appHandle) return null;
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
