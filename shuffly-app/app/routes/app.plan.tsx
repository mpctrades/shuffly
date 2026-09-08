// Shuffly's Plan screen.
//
// Shuffly is on Shopify managed pricing, so Shopify hosts the plan picker
// and this page deliberately does NOT show prices or plan cards. It used to,
// and the result was two pricing tables that disagreed — this page said
// "Starter $3.99/month" while Shopify's said "$39.90 / year · 30 trial
// days". Prices, trials and the monthly/annual choice live in the Partner
// Dashboard, so Shopify's page is the only honest place to render them.
//
// What's left here is what Shopify's page can't know: which plan is active,
// how much of it the shop is actually using, what the next tier would add
// given that usage, and what a drop to Free would pause. Then one button out
// to Shopify (see app/routes/app.change-plan.tsx).
import type { LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { PLANS, nextPlanOf, planOf, type PlanDefinition, type PlanId } from "../lib/plans";
import {
  enforcePlanCollectionCap,
  enforcePlanEntitlements,
  pruneExpiredUndoSnapshots,
} from "../lib/plans.server";
import {
  reconcilePlanFromSubscriptions,
  previewDowngradeImpact,
  fetchAppHandle,
  managedPricingUrl,
  type BillingSummary,
} from "../lib/billing.server";
import { KeyValueRows } from "../components/KeyValueRows";

// Shopify runs all three, so all three are honest to promise here.
const TRUST_ITEMS = ["Cancel any time", "Change plan instantly", "Billed through Shopify"];

type Tone = "success" | "warning" | "info" | "neutral";

// Same token family as Insights/Help/Settings — every value is a Polaris
// token, the hex after each is a same-hue fallback only, never the source
// of truth.
const TONE_TOKENS: Record<Tone, { accent: string; tint: string }> = {
  success: {
    accent: "var(--p-color-icon-success, #008060)",
    tint: "var(--p-color-bg-fill-success-secondary, #E3F5EE)",
  },
  warning: {
    accent: "var(--p-color-icon-warning, #FF4B1F)",
    tint: "var(--p-color-bg-fill-warning-secondary, #FFF1E4)",
  },
  info: {
    accent: "var(--p-color-icon-info, #1F5199)",
    tint: "var(--p-color-bg-fill-info-secondary, #EAF2FF)",
  },
  neutral: {
    accent: "var(--p-color-icon-secondary, #6b6b6b)",
    tint: "var(--p-color-bg-fill-secondary, #F1F1F1)",
  },
};

/** What `next` actually adds over `current`, derived from PLANS rather than
 * written out by hand — so this copy can't promise a capability the plan
 * doesn't enforce, and can't drift when a limit changes. Deliberately says
 * nothing about price: that's Shopify's page to state. */
function upgradeBenefits(current: PlanDefinition, next: PlanDefinition): string[] {
  const gains: string[] = [];

  if (next.maxCollections > current.maxCollections) {
    gains.push(
      next.maxCollections === Infinity
        ? "Unlimited collections"
        : `Up to ${next.maxCollections} collections, up from ${current.maxCollections}`,
    );
  }

  const gainsTwiceDaily =
    next.allowedSchedules.includes("TWICE_DAILY") &&
    !current.allowedSchedules.includes("TWICE_DAILY");
  const gainsDaily =
    next.allowedSchedules.includes("DAILY") && !current.allowedSchedules.includes("DAILY");
  if (gainsTwiceDaily) gains.push("Shuffle twice a day, not just once");
  else if (gainsDaily) gains.push("Daily shuffles at a time you pick");

  if (next.canPin && !current.canPin) gains.push("Pin your best sellers to the top");

  if (next.undoRetentionDays > current.undoRetentionDays) {
    const from = current.undoRetentionDays === 1 ? "1 day" : `${current.undoRetentionDays} days`;
    gains.push(`${next.undoRetentionDays}-day undo history, up from ${from}`);
  }

  return gains;
}

/** Plain-language summary of what the shop's *current* plan gives them, also
 * straight from PLANS. Balances the "Your plan" card against the upsell and
 * answers "what am I actually on?" without a price table. */
function currentPlanSummary(plan: PlanDefinition): string[] {
  const schedule = plan.allowedSchedules.includes("TWICE_DAILY")
    ? "Shuffle up to twice a day"
    : plan.allowedSchedules.includes("DAILY")
      ? "Daily shuffles at a time you pick"
      : "Weekly shuffles";

  const lines = [
    plan.maxCollections === Infinity
      ? "Unlimited collections"
      : `Up to ${plan.maxCollections} collections`,
    schedule,
    `${plan.undoRetentionDays}-day undo history`,
  ];
  if (plan.canPin) lines.push("Pin your best sellers to the top");
  return lines;
}

// ============================== loader ==============================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  await getOrCreateShopSettings(admin, shop);

  // Shopify appends `plan_handle` when it returns a merchant here after they
  // pick a plan (the per-plan "Welcome link" in the Partner Dashboard points
  // at /app/plan). Its presence is the only thing we take from it — the plan
  // name shown below comes from `billing.check()` further down, never from
  // this parameter, which is attacker-controllable and could otherwise be
  // used to fake an upgrade.
  const returnedFromCheckout = new URL(request.url).searchParams.has("plan_handle");

  // Shopify renders the plan picker itself under managed pricing, so the
  // only thing this page has to know is where to send the merchant.
  const pricingUrl = managedPricingUrl(shop, await fetchAppHandle(admin));

  // Shopify is the source of truth for what's actually being paid for —
  // reconcile our cached ShopSettings.plan against it on every load, so a
  // merchant returning from Shopify's pricing page always sees the real
  // state, not a stale local guess.
  let planId: PlanId = "FREE";
  let subscriptionId: string | null = null;
  let billingSummary: BillingSummary = {
    nextChargeDate: null,
    nextChargeAmount: null,
    nextChargeCurrency: null,
    isAnnual: false,
  };
  let reconcileFailed = false;
  try {
    // `isTest: true` here means "also count test charges", not "create one".
    // It must stay true regardless of environment: development stores — and
    // any store still inside managed pricing's trial — hold a *test*
    // subscription, so `isTest: false` filters out the very plan the
    // merchant just picked and the page keeps insisting they're on Free.
    const { appSubscriptions } = await billing.check({ isTest: true });
    const reconciled = await reconcilePlanFromSubscriptions(
      shop,
      appSubscriptions.map((s) => ({
        id: s.id,
        name: s.name,
        currentPeriodEnd: s.currentPeriodEnd,
        // shopify-api's AppPlan union (Recurring | Usage) doesn't structurally
        // match ActiveSubscriptionLike's narrower shape — Shuffly only ever
        // has recurring plans, so this is always the Recurring case.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lineItems: s.lineItems as any,
      })),
    );
    planId = reconciled.planId;
    subscriptionId = reconciled.subscriptionId;
    billingSummary = reconciled.billing;
    await enforcePlanCollectionCap(shop, planId);
    await enforcePlanEntitlements(shop, planId);
    await pruneExpiredUndoSnapshots(shop, planId);
  } catch (err) {
    // Fall back to whatever we last knew — better than a blank page.
    console.error("[app.plan] billing.check failed:", err);
    reconcileFailed = true;
    const settings = await db.shopSettings.findUnique({ where: { shop } });
    planId = (settings?.plan as PlanId) ?? "FREE";
  }

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const [trackedCount, totalRunsEver, monthlyAgg] = await Promise.all([
    db.collectionConfig.count({ where: { shop } }),
    db.shuffleRun.count({ where: { shop } }),
    db.shuffleRun.aggregate({
      where: { shop, createdAt: { gte: startOfMonth } },
      _sum: { movedCount: true },
    }),
  ]);
  // null (not 0) means "no run history at all yet" — the supporting line
  // hides itself entirely in that case, rather than showing a misleading 0.
  const monthlyMovedCount = totalRunsEver > 0 ? (monthlyAgg._sum.movedCount ?? 0) : null;

  // Merchants pick their new plan on Shopify's page, so we can't warn them
  // per-target the way a modal used to. What we can still say up front is
  // what leaving a paid plan would cost them.
  const freeDowngradeWouldPause =
    planId === "FREE" ? 0 : (await previewDowngradeImpact(shop, "FREE")).length;

  return {
    currentPlanId: planId,
    hasActiveSubscription: subscriptionId != null,
    billing: billingSummary,
    trackedCount,
    monthlyMovedCount,
    freeDowngradeWouldPause,
    pricingUrl,
    reconcileFailed,
    returnedFromCheckout,
  };
};

// ============================== component ==============================

export default function Plan() {
  const {
    currentPlanId,
    hasActiveSubscription,
    billing,
    trackedCount,
    monthlyMovedCount,
    freeDowngradeWouldPause,
    pricingUrl,
    reconcileFailed,
    returnedFromCheckout,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  // Set the moment we hand the browser off to Shopify's pricing page — the
  // navigation takes a beat, and the button has to stay inert until it lands
  // rather than firing twice.
  const [leaving, setLeaving] = useState(false);

  const isLoading =
    navigation.state === "loading" && navigation.location?.pathname === "/app/plan";

  const plan = planOf(currentPlanId);
  // Was a hand-written FREE->STARTER->PRO map here. It duplicated the tier
  // order that plans.ts already derives from PLANS by price, which is the
  // same source the Collections plan bar upsells from — so the two could
  // have disagreed about what to pitch. One derivation now.
  const nextTier = nextPlanOf(currentPlanId);
  const benefits = nextTier ? upgradeBenefits(plan, nextTier) : [];
  const included = currentPlanSummary(plan);

  const usageRatio = plan.maxCollections === Infinity ? null : trackedCount / plan.maxCollections;
  const usageLine =
    plan.maxCollections === Infinity
      ? `${trackedCount} collection${trackedCount === 1 ? "" : "s"} tracked · unlimited`
      : trackedCount >= plan.maxCollections
        ? `All ${plan.maxCollections} used — upgrade to add more`
        : `${trackedCount} of ${plan.maxCollections} collections used`;

  return (
    <s-page heading="Plan">
      {/* ---------------- hero ---------------- */}
      <div
        style={{
          marginBottom: 24,
          background: "var(--p-color-bg-surface, #ffffff)",
          border: "1px solid var(--p-color-border, #e3e3e3)",
          borderRadius: 16,
          boxShadow: "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
          padding: 24,
        }}
      >
        <span
          style={{
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "var(--p-color-text, #131110)",
          }}
        >
          Keep more of your catalogue moving.
        </span>
        <div
          style={{
            marginTop: 8,
            maxWidth: 560,
            fontSize: 14,
            lineHeight: 1.5,
            color: "var(--p-color-text-secondary, #6b6b6b)",
          }}
        >
          {monthlyMovedCount != null ? (
            <>
              Shuffly re-ordered{" "}
              <span style={{ fontWeight: 700, color: "var(--p-color-text, #131110)" }}>
                {monthlyMovedCount}
              </span>{" "}
              products for you this month.
            </>
          ) : (
            "Pick the plan that matches how often you want your collections to refresh."
          )}
        </div>
        <div
          style={{
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px solid var(--p-color-border-secondary, #f1f1f1)",
            display: "flex",
            flexWrap: "wrap",
            gap: 28,
          }}
        >
          {TRUST_ITEMS.map((t) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <CheckGlyph color="var(--p-color-icon-warning, #FF4B1F)" />
              <span style={{ fontSize: 12, color: "var(--p-color-text-secondary, #6b6b6b)" }}>
                {t}
              </span>
            </div>
          ))}
        </div>
      </div>

      {returnedFromCheckout && !reconcileFailed && (
        // The name comes from the reconciled subscription, not from the URL.
        <s-banner tone="success">
          You&apos;re on the {plan.name} plan. Shopify has recorded the change — it appears in your
          admin under Settings → Billing.
        </s-banner>
      )}

      {reconcileFailed && (
        <s-banner tone="warning">
          Couldn&apos;t confirm your subscription with Shopify just now — showing the last known
          plan.
        </s-banner>
      )}

      {!pricingUrl && (
        // Only reachable if Shopify didn't report the app handle, which is
        // what its pricing page is keyed by. Say where to go rather than
        // leaving a button that can't work.
        <s-banner tone="warning">
          Couldn&apos;t open the plan picker from here. You can still change your plan in your
          Shopify admin under Settings → Apps and sales channels → Shuffly.
        </s-banner>
      )}

      {isLoading ? (
        <PlanSkeleton />
      ) : (
        <div
          className="shuffly-plan-split"
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}
        >
          {/* ---------------- current plan + usage ---------------- */}
          <Card tone="success" icon="check-circle" title="Your plan">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  letterSpacing: "-0.01em",
                  color: "var(--p-color-text, #131110)",
                }}
              >
                {plan.name}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.03em",
                  color: "var(--p-color-icon-success, #008060)",
                }}
              >
                <span
                  style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }}
                />
                IN USE
              </span>
              {billing.isAnnual && <s-badge tone="info">Annual</s-badge>}
            </div>

            <UsageBar ratio={usageRatio} />
            <div
              style={{
                fontSize: 12,
                color: "var(--p-color-text-secondary, #6b6b6b)",
                marginTop: 6,
                marginBottom: 14,
              }}
            >
              {usageLine}
            </div>

            {hasActiveSubscription ? (
              <KeyValueRows
                rows={[
                  { label: "Charged through", value: "Shopify" },
                  {
                    label: "Next charge",
                    value:
                      billing.nextChargeDate && billing.nextChargeAmount != null
                        ? `${billing.nextChargeDate} · $${billing.nextChargeAmount.toFixed(2)}`
                        : "—",
                  },
                ]}
              />
            ) : (
              <s-text color="subdued">No charge on the Free plan.</s-text>
            )}

            <div
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: "1px solid var(--p-color-border-secondary, #f1f1f1)",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  textTransform: "uppercase",
                  color: "var(--p-color-text-secondary, #6b6b6b)",
                  marginBottom: 10,
                }}
              >
                Included now
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {included.map((line) => (
                  <CheckItem key={line} tone="success">
                    {line}
                  </CheckItem>
                ))}
              </div>
            </div>

            {freeDowngradeWouldPause > 0 && (
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 12,
                  borderTop: "1px solid var(--p-color-border-secondary, #f1f1f1)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--p-color-text-secondary, #6b6b6b)",
                }}
              >
                Moving to Free would pause{" "}
                <span style={{ fontWeight: 700, color: "var(--p-color-text, #131110)" }}>
                  {freeDowngradeWouldPause}
                </span>{" "}
                collection{freeDowngradeWouldPause === 1 ? "" : "s"} over the{" "}
                {PLANS.FREE.maxCollections}-collection limit. Nothing is deleted — you can restart
                them any time.
              </div>
            )}
          </Card>

          {/* ---------------- upsell + the one way out ---------------- */}
          <Card
            tone="warning"
            icon="cash-dollar"
            title={nextTier ? `Move to ${nextTier.name}` : "Plans & pricing"}
          >
            {nextTier && benefits.length > 0 ? (
              <>
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "var(--p-color-text-secondary, #6b6b6b)",
                    marginBottom: 12,
                  }}
                >
                  What {nextTier.name} adds to your {plan.name} plan:
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}
                >
                  {benefits.map((b) => (
                    <CheckItem key={b}>{b}</CheckItem>
                  ))}
                </div>
              </>
            ) : (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--p-color-text-secondary, #6b6b6b)",
                  marginBottom: 16,
                }}
              >
                You&apos;re on {plan.name} — the most Shuffly offers. Change or cancel your plan any
                time.
              </div>
            )}

            {/* A plain anchor with target="_top" — App Bridge's documented
                Navigation API for reaching an admin page outside the app's
                iframe. Deliberately NOT a route of ours that server-redirects
                out: Shopify's "← Select a plan" arrow returns the merchant to
                the app's *last visited route*, so an intermediate hop became
                the remembered route and bounced them straight back to the
                pricing page — the back button looked broken. Linking directly
                leaves /app/plan as the last route, so the arrow comes back
                here. */}
            {pricingUrl ? (
              <a
                className="shuffly-plan-pill"
                href={pricingUrl}
                target="_top"
                onClick={() => setLeaving(true)}
              >
                {leaving ? "Opening…" : "View plans & pricing →"}
              </a>
            ) : (
              <PillButton
                onClick={() =>
                  shopify.toast.show("Couldn't open Shopify's plan page just now.", {
                    isError: true,
                  })
                }
              >
                View plans & pricing →
              </PillButton>
            )}
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--p-color-text-secondary, #6b6b6b)",
              }}
            >
              Prices, free trials and yearly billing are shown and handled by Shopify. Upgrades,
              downgrades and cancellations all take effect there.
            </div>
          </Card>
        </div>
      )}

      <style>{`
        @media (max-width: 800px) {
          .shuffly-plan-split { grid-template-columns: 1fr !important; }
        }
        .shuffly-plan-pill {
          display: flex;
          text-decoration: none;
          box-sizing: border-box;
          align-items: center;
          justify-content: center;
          width: 100%;
          padding: 11px 18px;
          border: none;
          border-radius: 999px;
          outline: none;
          box-shadow: none;
          font: inherit;
          font-weight: 600;
          font-size: 14px;
          cursor: pointer;
          background: var(--p-color-bg-fill-warning, #FF4B1F);
          color: #ffffff;
          transition: background-color 120ms ease;
        }
        .shuffly-plan-pill:hover:not(:disabled) {
          background: var(--p-color-bg-fill-warning-hover, #E13F16);
        }
        .shuffly-plan-pill:active:not(:disabled) {
          background: var(--p-color-bg-fill-warning-active, #C93611);
        }
        .shuffly-plan-pill:disabled { cursor: default; opacity: 0.55; }
        .shuffly-plan-pill:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
          box-shadow: none;
        }
      `}</style>
    </s-page>
  );
}

// ============================== pieces ==============================

/** The icon-chip + title card used across Settings/Help/Insights, with the
 * 3px tone rule along the top. */
function Card({
  tone,
  icon,
  title,
  children,
}: {
  tone: Tone;
  /** Narrowed to the two this page uses — `s-icon` only accepts its own
   * IconType union, so a bare `string` doesn't typecheck. */
  icon: "check-circle" | "cash-dollar";
  title: string;
  children: React.ReactNode;
}) {
  const tokens = TONE_TOKENS[tone];
  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        background: "var(--p-color-bg-surface, #ffffff)",
        border: "1px solid var(--p-color-border, #e3e3e3)",
        borderRadius: 12,
        boxShadow: "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: tokens.accent,
        }}
      />
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div
            aria-hidden="true"
            style={{
              width: 32,
              height: 32,
              flex: "0 0 auto",
              borderRadius: 8,
              background: tokens.tint,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <s-icon type={icon} tone={tone === "success" ? "success" : "warning"}></s-icon>
          </div>
          <s-heading>{title}</s-heading>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 6px pill usage bar. Neutral grey under 80% of the limit — ordinary usage
 * is not an error state and shouldn't read as one — orange from 80–99%, red
 * only at (or over) 100%. `ratio` is null for an unlimited plan, which reads
 * as a quiet, mostly empty neutral bar since "percent of unlimited" isn't a
 * real number. */
function UsageBar({ ratio }: { ratio: number | null }) {
  const pct = ratio == null ? 8 : Math.min(100, Math.max(4, ratio * 100));
  const color =
    ratio != null && ratio >= 1
      ? "var(--p-color-bg-fill-critical, #D82C0D)"
      : ratio != null && ratio >= 0.8
        ? "var(--p-color-bg-fill-warning, #FF4B1F)"
        : "var(--p-color-icon-secondary, #6b6b6b)";
  return (
    <div
      style={{
        width: "100%",
        height: 6,
        borderRadius: 999,
        background: "var(--p-color-bg-surface-tertiary, #E3E3E3)",
        overflow: "hidden",
      }}
    >
      <div style={{ width: `${pct}%`, height: "100%", borderRadius: 999, background: color }} />
    </div>
  );
}

/** A guaranteed-color checkmark, drawn ourselves rather than through
 * `s-icon type="check"` — that icon doesn't actually honor `tone="warning"`
 * (it renders green regardless), so it can't be trusted to hit an exact
 * color. */
function CheckGlyph({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.5 7.3L5.6 10.4L11.5 3.6"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One check-marked benefit line. Plain HTML text (not s-text) so it can
 * take an explicit color — Polaris text components only expose a tone enum. */
function CheckItem({
  children,
  tone = "warning",
}: {
  children: React.ReactNode;
  /** "success" for capabilities the shop already has, "warning" (the brand
   * accent) for ones an upgrade would add. */
  tone?: "success" | "warning";
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span style={{ flex: "0 0 auto", marginTop: 2 }}>
        <CheckGlyph
          color={
            tone === "success"
              ? "var(--p-color-icon-success, #008060)"
              : "var(--p-color-icon-warning, #FF4B1F)"
          }
        />
      </span>
      <span style={{ fontSize: 14, color: "var(--p-color-text, #131110)" }}>{children}</span>
    </div>
  );
}

/** Solid pill CTA. A plain `<button>`, not `s-clickable` — that component
 * bakes in its own shadow-DOM hover/focus chrome (a white ring/halo) that
 * can't be overridden from outside it. Every visual state is defined in the
 * .shuffly-plan-pill rules above, in Polaris tokens with a same-hue hex
 * fallback. */
function PillButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="shuffly-plan-pill"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function Bar({ width }: { width: number }) {
  return (
    <div
      style={{
        width,
        height: 12,
        borderRadius: 4,
        background: "var(--p-color-bg-surface-tertiary, #e3e3e3)",
      }}
    />
  );
}

function PlanSkeleton() {
  return (
    <div
      className="shuffly-plan-split"
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
    >
      {[0, 1].map((i) => (
        <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="base">
            <Bar width={100} />
            <Bar width={160} />
            <Bar width={140} />
            <Bar width={140} />
          </s-stack>
        </s-box>
      ))}
    </div>
  );
}
