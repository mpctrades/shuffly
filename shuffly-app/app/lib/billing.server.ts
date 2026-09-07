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

// ---------------------------------------------------------------------------
// Starting a plan change from inside the embedded admin
// ---------------------------------------------------------------------------

/** The header Shopify's React Router library uses to hand an out-of-app
 * redirect target back to the browser. */
const REAUTH_URL_HEADER = "X-Shopify-API-Request-Failure-Reauthorize-Url";

/** `billing.request()` never resolves — it always throws, and *what* it
 * throws depends on how the request reached us:
 *
 *  - a session-token fetch (which is every `useFetcher` submit inside the
 *    embedded admin, because App Bridge attaches an `Authorization` header):
 *    a bare **401** whose only payload is the confirmation URL in
 *    `REAUTH_URL_HEADER`;
 *  - an embedded document request: a **302** to
 *    `/auth/exit-iframe?…&exitIframe=<confirmationUrl>`.
 *
 * React Router surfaces that 401 as an ErrorResponse, so the Plan page was
 * torn down and replaced by app.tsx's error boundary before anything could
 * read the header — the merchant never reached Shopify's approval screen and
 * no plan could be changed from inside the app. Unwrap the throw here and
 * return the confirmation URL as an ordinary string instead, so the action
 * can send it back as JSON and the client can open it in the top-level
 * window itself. Returns null for anything that isn't one of those two
 * redirect shapes, so genuine failures still propagate. */
export function confirmationUrlFromBillingRedirect(thrown: unknown): string | null {
  if (!(thrown instanceof Response)) return null;

  const reauthUrl = thrown.headers.get(REAUTH_URL_HEADER);
  if (reauthUrl) return reauthUrl;

  const location = thrown.headers.get("Location");
  if (!location) return null;
  try {
    // Relative for the exit-iframe hop, absolute for non-embedded apps — the
    // base is only there to let relative values parse at all.
    const exitIframe = new URL(location, "https://shuffly.invalid").searchParams.get("exitIframe");
    if (exitIframe) return exitIframe;
    return /^https?:\/\//i.test(location) ? location : null;
  } catch {
    return null;
  }
}

/** Run a `billing.request(...)` call and give back the Shopify approval URL
 * the merchant has to visit. Takes a thunk rather than the billing object so
 * the caller keeps the library's own narrow typing of `plan`. */
export async function requestSubscriptionConfirmationUrl(
  requestBilling: () => Promise<unknown>,
): Promise<string> {
  try {
    await requestBilling();
  } catch (thrown) {
    const url = confirmationUrlFromBillingRedirect(thrown);
    if (url) return url;
    throw thrown;
  }
  throw new Error("Shopify's Billing API returned no subscription confirmation URL.");
}

/** Whether *new* charges are created as Shopify test charges. Test mode is
 * the default outside production; `SHOPIFY_BILLING_TEST` forces it either
 * way, so a production build can still be exercised with test charges (for
 * an App Store review pass, say) without changing `NODE_ENV`. */
export function billingIsTest(): boolean {
  const override = process.env.SHOPIFY_BILLING_TEST;
  if (override) return override !== "false" && override !== "0";
  return process.env.NODE_ENV !== "production";
}

/** Where Shopify returns the merchant after they approve or decline a
 * charge. It has to be an *admin* URL, not our own origin: a bare hit on
 * `https://<app host>/app/plan` carries no `shop`/`host`, so it can't
 * re-enter the embedded admin and strands the merchant outside the app.
 * `appOrigin` is only a fallback for a misconfigured deployment. */
export function planApprovalReturnUrl(shop: string, appOrigin: string): string {
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return `${appOrigin}/app/plan`;
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/apps/${apiKey}/app/plan`;
}
