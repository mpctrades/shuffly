import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigation, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import {
  PLANS,
  planOf,
  annualPrice,
  annualMonthlyEquivalent,
  type PlanId,
} from "../lib/plans";
import { enforcePlanCollectionCap } from "../lib/plans.server";
import {
  reconcilePlanFromSubscriptions,
  previewDowngradeImpact,
  type BillingSummary,
} from "../lib/billing.server";
import { closeModal } from "../lib/polaris-modal";
import {
  DowngradeConfirmModal,
  type DowngradeImpact,
} from "../components/DowngradeConfirmModal";
import { KeyValueRows } from "../components/KeyValueRows";

// FREE first — index in this list doubles as "cheaper than" for deciding
// whether a plan switch is an upgrade (no confirmation needed) or a
// downgrade (preview what it'd pause, then confirm). AGENCY still exists
// as a real plan/billing target (see BILLING_PLANS in shopify.server.ts)
// for any shop already on it — it's just not one of the three cards shown
// on this page.
const PLAN_ORDER: PlanId[] = ["FREE", "STARTER", "PRO", "AGENCY"];
const PRICING_ROW: Array<"FREE" | "STARTER" | "PRO"> = ["FREE", "STARTER", "PRO"];

// Real, honest differentiators pulled from PLANS in lib/plans.ts — no
// feature is claimed here that the plan doesn't actually have.
const FEATURE_BULLETS: Record<"FREE" | "STARTER" | "PRO", string[]> = {
  FREE: [
    "Up to 5 collections",
    "Weekly shuffle schedule",
    "Manual “Shuffle now” anytime",
    "Sold-out reaction within the hour",
  ],
  STARTER: [
    "Up to 25 collections",
    "Daily schedule, pick the time",
    "Pin your best sellers",
    "Sold-out reaction within a minute",
    "7-day undo history",
  ],
  PRO: [
    "Unlimited collections",
    "Up to twice-daily schedule",
    "Everything in Starter",
    "30-day undo history",
    "Priority support",
  ],
};

const PLAN_TAGLINE: Record<"FREE" | "STARTER" | "PRO", string> = {
  FREE: "For trying Shuffly on a few collections, with nothing to lose.",
  STARTER: "The everyday plan for stores that want fresh collections daily.",
  PRO: "For larger catalogues that want full control over the schedule.",
};

// The header's trust row — replaces the old "no emails, no support ticket"
// phrasing with the same reassurance, spelled out plainly.
const TRUST_ITEMS = ["Cancel any time", "Change plan instantly", "Billed through Shopify"];

type BillingCycle = "monthly" | "annual";
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

// ============================== loader ==============================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  await getOrCreateShopSettings(admin, shop);

  const isTest = process.env.NODE_ENV !== "production";

  // Shopify is the source of truth for what's actually being paid for —
  // reconcile our cached ShopSettings.plan against it on every load, so a
  // merchant returning from an approval/cancellation always sees the real
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
    const { appSubscriptions } = await billing.check({ isTest });
    const reconciled = await reconcilePlanFromSubscriptions(
      shop,
      appSubscriptions.map((s) => ({
        id: s.id,
        name: s.name,
        currentPeriodEnd: s.currentPeriodEnd,
        // shopify-api's AppPlan union (Recurring | Usage) doesn't structurally
        // match ActiveSubscriptionLike's narrower shape — Shuffly only ever
        // requests recurring plans, so this is always the Recurring case.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lineItems: s.lineItems as any,
      })),
    );
    planId = reconciled.planId;
    subscriptionId = reconciled.subscriptionId;
    billingSummary = reconciled.billing;
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
  // null (not 0) means "no run history at all yet" — the summary card's
  // middle column hides itself entirely in that case, rather than showing
  // a misleading "0".
  const monthlyMovedCount = totalRunsEver > 0 ? (monthlyAgg._sum.movedCount ?? 0) : null;

  return {
    currentPlanId: planId,
    hasActiveSubscription: subscriptionId != null,
    billing: billingSummary,
    trackedCount,
    monthlyMovedCount,
    isTest,
    reconcileFailed,
  };
};

// ============================== action ==============================

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = process.env.NODE_ENV !== "production";
  const formData = await request.formData();
  const actionType = formData.get("_action");

  if (actionType === "preview-downgrade") {
    try {
      const targetPlanId = String(formData.get("targetPlanId")) as PlanId;
      const target = planOf(targetPlanId);
      const settings = await db.shopSettings.findUnique({ where: { shop } });
      const current = planOf(settings?.plan);
      const collectionsToPause = await previewDowngradeImpact(shop, targetPlanId);

      const impact: DowngradeImpact = {
        targetPlanName: target.name,
        collectionsToPause,
        maxCollections: target.maxCollections === Infinity ? null : target.maxCollections,
        undoLossDays:
          target.undoRetentionDays < current.undoRetentionDays
            ? target.undoRetentionDays
            : null,
      };
      return data({ ok: true, impact });
    } catch (err) {
      console.error("[app.plan] preview-downgrade failed:", err);
      return data({ ok: false, error: "Couldn't check that plan change just now." }, { status: 500 });
    }
  }

  if (actionType === "subscribe") {
    const planId = String(formData.get("planId")) as PlanId;
    const billingCycle = String(formData.get("billingCycle") ?? "monthly") as BillingCycle;
    if (planId === "FREE") {
      return data({ ok: false, error: "Free has nothing to subscribe to." }, { status: 400 });
    }
    const billingKey = (
      billingCycle === "annual" ? `${planId}_ANNUAL` : planId
    ) as "STARTER" | "STARTER_ANNUAL" | "PRO" | "PRO_ANNUAL" | "AGENCY" | "AGENCY_ANNUAL";
    const url = new URL(request.url);
    // Throws internally (redirects to Shopify's approval page) — never
    // actually resolves on success.
    return billing.request({
      plan: billingKey,
      isTest,
      returnUrl: `${url.origin}/app/plan`,
    });
  }

  if (actionType === "downgrade") {
    try {
      const targetPlanId = String(formData.get("targetPlanId")) as PlanId;
      const settings = await db.shopSettings.findUnique({ where: { shop } });

      if (settings?.activeSubscriptionId) {
        try {
          await billing.cancel({
            subscriptionId: settings.activeSubscriptionId,
            isTest,
            prorate: true,
          });
        } catch (err) {
          // Already cancelled/expired on Shopify's side is fine — we still
          // want our own record to land on the target plan below.
          console.error("[app.plan] billing.cancel failed:", err);
        }
      }

      await db.shopSettings.update({
        where: { shop },
        data: { plan: targetPlanId, activeSubscriptionId: null, planUpdatedAt: new Date() },
      });
      const pausedTitles = await enforcePlanCollectionCap(shop, targetPlanId);
      return data({ ok: true, pausedTitles });
    } catch (err) {
      console.error("[app.plan] downgrade failed:", err);
      return data({ ok: false, error: "Couldn't switch your plan just now." }, { status: 500 });
    }
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
};

// ============================== component ==============================

export default function Plan() {
  const {
    currentPlanId,
    hasActiveSubscription,
    billing,
    trackedCount,
    monthlyMovedCount,
    isTest,
    reconcileFailed,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const subscribeFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const previewFetcher = useFetcher<{ ok: boolean; impact?: DowngradeImpact; error?: string }>();
  const downgradeFetcher = useFetcher<{ ok: boolean; pausedTitles?: string[]; error?: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const modalRef = useRef<any>(null);

  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [downgradeTarget, setDowngradeTarget] = useState<PlanId | null>(null);

  const isLoading =
    navigation.state === "loading" && navigation.location?.pathname === "/app/plan";
  const anyBusy =
    subscribeFetcher.state !== "idle" ||
    previewFetcher.state !== "idle" ||
    downgradeFetcher.state !== "idle";

  const currentIndex = PLAN_ORDER.indexOf(currentPlanId);

  function requestSwitch(planId: PlanId) {
    if (anyBusy) return;
    const targetIndex = PLAN_ORDER.indexOf(planId);
    if (targetIndex === currentIndex) return;
    if (targetIndex > currentIndex) {
      subscribeFetcher.submit(
        { _action: "subscribe", planId, billingCycle },
        { method: "post" },
      );
      return;
    }
    setDowngradeTarget(planId);
    previewFetcher.submit(
      { _action: "preview-downgrade", targetPlanId: planId },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (previewFetcher.state === "idle" && previewFetcher.data && downgradeTarget) {
      if (previewFetcher.data.ok) {
        modalRef.current?.showOverlay();
      } else {
        shopify.toast.show(previewFetcher.data.error ?? "Couldn't check that plan change", {
          isError: true,
        });
        setDowngradeTarget(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only when the preview fetch this click triggered settles
  }, [previewFetcher.state, previewFetcher.data]);

  useEffect(() => {
    if (subscribeFetcher.state === "idle" && subscribeFetcher.data && !subscribeFetcher.data.ok) {
      shopify.toast.show(subscribeFetcher.data.error ?? "Couldn't start that upgrade", {
        isError: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [subscribeFetcher.state, subscribeFetcher.data]);

  function confirmDowngrade() {
    if (!downgradeTarget) return;
    closeModal(modalRef.current);
    downgradeFetcher.submit(
      { _action: "downgrade", targetPlanId: downgradeTarget },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (downgradeFetcher.state === "idle" && downgradeFetcher.data) {
      if (downgradeFetcher.data.ok) {
        const paused = downgradeFetcher.data.pausedTitles ?? [];
        shopify.toast.show(
          paused.length > 0
            ? `Plan switched — paused (over the new limit): ${paused.join(", ")}`
            : "Plan switched",
        );
      } else {
        shopify.toast.show(downgradeFetcher.data.error ?? "Couldn't switch your plan", {
          isError: true,
        });
      }
      setDowngradeTarget(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [downgradeFetcher.state, downgradeFetcher.data]);

  // "Plan" itself is rendered by s-page's own heading prop, into Admin's
  // native title chrome — there's no slot to literally inject anything into
  // that rendered text, so everything below is our own content, starting
  // immediately under it.
  return (
    <s-page heading="Plan">
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
        {/* Row 1 — headline + inline test badge (left), billing toggle (right) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
            {isTest && (
              // Native title attribute, not s-tooltip — Shopify's own
              // tooltip wiring needs a hover-invoker element (interestFor)
              // that s-badge doesn't expose; this is the one
              // guaranteed-to-work option.
              <span title="Charges use Shopify's test mode and won't bill you.">
                <s-badge tone="info">Test mode</s-badge>
              </span>
            )}
          </div>
          <BillingCycleToggle value={billingCycle} onChange={setBillingCycle} disabled={anyBusy} />
        </div>

        {/* Row 2 — supporting line */}
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
              products for you this month. Pick the plan that matches how often you want that to
              happen.
            </>
          ) : (
            "Pick the plan that matches how often you want your collections to refresh."
          )}
        </div>

        {/* Row 3 — trust row, grouped together rather than stretched
           edge-to-edge, with a hairline above it to separate it from the
           supporting sentence */}
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
              <span style={{ fontSize: 12, color: "var(--p-color-text-secondary, #6b6b6b)" }}>{t}</span>
            </div>
          ))}
        </div>
      </div>

      {reconcileFailed && (
        <s-banner tone="warning">
          Couldn&apos;t confirm your subscription with Shopify just now — showing the last known
          plan.
        </s-banner>
      )}

      {isLoading ? (
        <PlanSkeleton />
      ) : (
        <s-stack direction="block" gap="base">
          <div
            className="shuffly-plan-row"
            style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, alignItems: "stretch" }}
          >
            {PRICING_ROW.map((planId) => {
              const plan = PLANS[planId];
              const index = PLAN_ORDER.indexOf(planId);
              const isCurrent = planId === currentPlanId;
              const isUpgrade = index > currentIndex;
              const isFeatured = planId === "STARTER";

              const priceMain =
                plan.price === 0
                  ? "$0"
                  : billingCycle === "monthly"
                    ? `$${plan.price.toFixed(2)}`
                    : `$${annualMonthlyEquivalent(plan.price).toFixed(2)}`;
              const priceSuffix = plan.price === 0 ? "/forever" : "/month";

              const label =
                isFeatured && !isCurrent
                  ? `${plan.name.toUpperCase()} · MOST POPULAR`
                  : plan.name.toUpperCase();

              const ctaLabel = isCurrent ? "Current plan" : isUpgrade ? "Upgrade" : "Downgrade";
              const ctaTone: "dark" | "orange" | "muted" = isCurrent
                ? "muted"
                : isFeatured
                  ? "orange"
                  : "dark";

              // Usage bar only ever shows on the shop's actual current
              // plan's own card.
              const usage = isCurrent
                ? {
                    ratio: plan.maxCollections === Infinity ? null : trackedCount / plan.maxCollections,
                    line:
                      plan.maxCollections === Infinity
                        ? `${trackedCount} collection${trackedCount === 1 ? "" : "s"} tracked · unlimited`
                        : trackedCount >= plan.maxCollections
                          ? `All ${plan.maxCollections} used — upgrade to add more`
                          : `${trackedCount} of ${plan.maxCollections} collections used`,
                  }
                : null;

              return (
                <PricingTile
                  key={planId}
                  dark={isFeatured}
                  emphasized={isCurrent && !isFeatured}
                  current={isCurrent}
                  usage={usage}
                  label={label}
                  priceMain={priceMain}
                  priceSuffix={priceSuffix}
                  annualNote={
                    plan.price > 0 && billingCycle === "annual"
                      ? `billed $${annualPrice(plan.price).toFixed(2)}/yr`
                      : null
                  }
                  bullets={FEATURE_BULLETS[planId]}
                  tagline={PLAN_TAGLINE[planId]}
                  ctaLabel={ctaLabel}
                  ctaTone={ctaTone}
                  disabled={isCurrent || anyBusy}
                  onClick={() => requestSwitch(planId)}
                />
              );
            })}
          </div>

          <BillingInfoCard
            billing={billing}
            hasActiveSubscription={hasActiveSubscription}
            anyBusy={anyBusy}
            onCancel={() => requestSwitch("FREE")}
          />
        </s-stack>
      )}

      <DowngradeConfirmModal
        ref={modalRef}
        impact={previewFetcher.data?.impact ?? null}
        busy={downgradeFetcher.state !== "idle"}
        onConfirm={confirmDowngrade}
        onCancel={() => closeModal(modalRef.current)}
      />

      <style>{`
        @media (max-width: 700px) {
          .shuffly-plan-row { grid-template-columns: 1fr !important; }
        }
        .shuffly-plan-pill {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          margin-top: auto;
          padding: 9px 18px;
          border: none;
          border-radius: 999px;
          outline: none;
          box-shadow: none;
          font: inherit;
          font-weight: 600;
          font-size: 14px;
          cursor: pointer;
          transition: background-color 120ms ease;
        }
        .shuffly-plan-pill:disabled { cursor: default; opacity: 0.55; }
        .shuffly-plan-pill--dark { background: var(--p-color-bg-fill-inverse, #131110); color: #ffffff; }
        .shuffly-plan-pill--dark:hover:not(:disabled) { background: var(--p-color-bg-fill-inverse-hover, #2b2a29); }
        .shuffly-plan-pill--dark:active:not(:disabled) { background: var(--p-color-bg-fill-inverse-active, #000000); }
        .shuffly-plan-pill--orange { background: var(--p-color-bg-fill-warning, #FF4B1F); color: #ffffff; }
        .shuffly-plan-pill--orange:hover:not(:disabled) { background: var(--p-color-bg-fill-warning-hover, #E13F16); }
        .shuffly-plan-pill--orange:active:not(:disabled) { background: var(--p-color-bg-fill-warning-active, #C93611); }
        .shuffly-plan-pill--muted { background: var(--p-color-bg-fill-secondary, #E3E3E3); color: var(--p-color-text, #131110); }
        .shuffly-plan-pill--muted:disabled { opacity: 1; }
        .shuffly-plan-pill:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
          box-shadow: none;
        }
        .shuffly-cycle-toggle {
          display: inline-flex;
          flex: 0 0 auto;
          padding: 3px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 999px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-cycle-btn {
          border: none;
          outline: none;
          box-shadow: none;
          border-radius: 999px;
          padding: 7px 14px;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          color: var(--p-color-text-secondary, #6b6b6b);
          background: transparent;
          cursor: pointer;
          transition: background-color 120ms ease, color 120ms ease;
        }
        .shuffly-cycle-btn:disabled { cursor: default; opacity: 0.6; }
        .shuffly-cycle-btn--active {
          background: var(--p-color-bg-fill-inverse, #131110);
          color: #ffffff;
        }
        .shuffly-cycle-btn:not(.shuffly-cycle-btn--active):hover:not(:disabled) {
          background: var(--p-color-bg-surface-secondary, #f1f1f1);
        }
        .shuffly-cycle-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
      `}</style>
    </s-page>
  );
}

// ============================== pieces ==============================

/** Monthly/Annual segmented control — no native segmented-control element
 * in this design system, so two joined s-buttons (gap="none") stand in for
 * one, with variant swapped to mark the active side. */
function BillingCycleToggle({
  value,
  onChange,
  disabled,
}: {
  value: BillingCycle;
  onChange: (v: BillingCycle) => void;
  disabled: boolean;
}) {
  return (
    <div className="shuffly-cycle-toggle" role="group" aria-label="Billing cycle">
      <button
        type="button"
        className={`shuffly-cycle-btn${value === "monthly" ? " shuffly-cycle-btn--active" : ""}`}
        onClick={() => onChange("monthly")}
        disabled={disabled}
      >
        Monthly
      </button>
      <button
        type="button"
        className={`shuffly-cycle-btn${value === "annual" ? " shuffly-cycle-btn--active" : ""}`}
        onClick={() => onChange("annual")}
        disabled={disabled}
      >
        Annual · 2 months free
      </button>
    </div>
  );
}

/** 6px pill usage bar, shown inside the current plan's own card. Neutral
 * grey under 80% of the limit — ordinary usage is not an error state and
 * shouldn't read as one — orange from 80–99%, red only at (or over) 100%.
 * `ratio` is null for an unlimited plan, which reads as a quiet, mostly
 * empty neutral bar since "percent of unlimited" isn't a real number.
 * `dark` swaps the track/neutral-fill colors for the black "most popular"
 * tile, where the light-card tokens wouldn't read. */
function UsageBar({ ratio, dark }: { ratio: number | null; dark?: boolean }) {
  const pct = ratio == null ? 8 : Math.min(100, Math.max(4, ratio * 100));
  const color =
    ratio != null && ratio >= 1
      ? "var(--p-color-bg-fill-critical, #D82C0D)"
      : ratio != null && ratio >= 0.8
        ? "var(--p-color-bg-fill-warning, #FF4B1F)"
        : dark
          ? "rgba(255, 255, 255, 0.5)"
          : "var(--p-color-icon-secondary, #6b6b6b)";
  return (
    <div
      style={{
        width: "100%",
        height: 6,
        borderRadius: 999,
        background: dark ? "rgba(255, 255, 255, 0.15)" : "var(--p-color-bg-surface-tertiary, #E3E3E3)",
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
 * color like the white this needs on the dark tile. */
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

/** One check-marked feature line. Plain HTML text (not s-text) so it can
 * take an explicit color on the dark "most popular" tile — Polaris text
 * components don't expose a raw color override, only the tone enum. */
function CheckItem({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span style={{ flex: "0 0 auto", marginTop: 2 }}>
        <CheckGlyph color={dark ? "#ffffff" : "var(--p-color-icon-warning, #FF4B1F)"} />
      </span>
      <span style={{ fontSize: 14, color: dark ? "#ffffff" : "var(--p-color-text, #131110)" }}>
        {children}
      </span>
    </div>
  );
}

/** Solid pill CTA. A plain `<button>`, not `s-clickable` — that component
 * bakes in its own shadow-DOM hover/focus chrome (a white ring/halo) that
 * can't be reached or overridden from outside it, which is exactly the bug
 * this replaces. Every visual state (including the orange-tinted focus
 * ring) is defined in the .shuffly-plan-pill rules below, in Polaris
 * tokens with a same-hue hex fallback. Pinned to the bottom of its card via
 * margin-top: auto, so it lines up across cards regardless of how much
 * content sits above it. */
function PillButton({
  children,
  tone,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  tone: "dark" | "orange" | "muted";
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`shuffly-plan-pill shuffly-plan-pill--${tone}`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** The three-card pricing row — modeled on the marketing pricing table
 * (light/dark/light, the middle "most popular" tier inverted to black with
 * an orange pill CTA), rather than the label/value card system used
 * elsewhere in the app. `emphasized` (light tiles only — the dark tile
 * already reads as distinct) adds the orange border + ring that marks the
 * current plan, same accent language as the rest of the app. */
function PricingTile({
  dark,
  emphasized,
  current,
  usage,
  label,
  priceMain,
  priceSuffix,
  annualNote,
  bullets,
  tagline,
  ctaLabel,
  ctaTone,
  disabled,
  onClick,
}: {
  dark: boolean;
  emphasized: boolean;
  /** This is the plan the shop is actually on right now — shown as a small
   * green "in use" marker next to the label, distinct from the orange
   * "most popular" one. */
  current: boolean;
  /** Only set on the current plan's own card — the usage bar + line, shown
   * under the label and above the price. */
  usage: { ratio: number | null; line: string } | null;
  label: string;
  priceMain: string;
  priceSuffix: string;
  annualNote: string | null;
  bullets: string[];
  tagline: string;
  ctaLabel: string;
  ctaTone: "dark" | "orange" | "muted";
  disabled: boolean;
  onClick: () => void;
}) {
  const textColor = dark ? "#ffffff" : "var(--p-color-text, #131110)";
  const subduedColor = dark ? "rgba(255, 255, 255, 0.65)" : "var(--p-color-text-secondary, #6b6b6b)";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 20,
        // A literal charcoal, not the var(--p-color-bg-fill-inverse) token —
        // that token (also used by the black pill buttons) resolves to a
        // near-black that read as "too dark" for a whole card background;
        // this is a deliberately lighter, fixed inverse-surface color just
        // for the "most popular" tile, same reasoning as its fixed white
        // text/checks below (no token expresses "lighter than inverse").
        background: dark ? "#2A2724" : "var(--p-color-bg-surface, #ffffff)",
        border: emphasized
          ? "1px solid var(--p-color-border-warning, #FF4B1F)"
          : dark
            ? "1px solid #2A2724"
            : "1px solid var(--p-color-border, #e3e3e3)",
        borderRadius: 16,
        boxShadow: emphasized
          ? "0 0 0 1px var(--p-color-border-warning, #FF4B1F), var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))"
          : "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: dark ? "var(--p-color-icon-warning, #FF4B1F)" : subduedColor,
          }}
        >
          {label}
        </span>
        {current && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.03em",
              // The success token reads fine on white but is too dark to
              // read on the black "most popular" tile — same reasoning as
              // the white checkmarks there, a lighter fixed green instead.
              color: dark ? "#6FCF97" : "var(--p-color-icon-success, #008060)",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
            IN USE
          </span>
        )}
      </div>

      {usage && (
        <div>
          <UsageBar ratio={usage.ratio} dark={dark} />
          <div style={{ fontSize: 12, color: subduedColor, marginTop: 6 }}>{usage.line}</div>
        </div>
      )}

      <div>
        <span style={{ fontSize: 30, fontWeight: 800, color: textColor, lineHeight: 1 }}>{priceMain}</span>
        <span style={{ fontSize: 13, fontWeight: 500, color: subduedColor }}>{priceSuffix}</span>
        {annualNote && (
          <div style={{ fontSize: 13, color: subduedColor, marginTop: 4 }}>{annualNote}</div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {bullets.map((b) => (
          <CheckItem key={b} dark={dark}>
            {b}
          </CheckItem>
        ))}
      </div>

      <div
        style={{
          borderTop: `1px solid ${dark ? "rgba(255, 255, 255, 0.15)" : "var(--p-color-border, #e3e3e3)"}`,
          paddingTop: 12,
        }}
      >
        <span style={{ fontSize: 13, color: subduedColor, lineHeight: 1.5 }}>{tagline}</span>
      </div>

      <PillButton tone={ctaTone} onClick={onClick} disabled={disabled}>
        {ctaLabel}
      </PillButton>
    </div>
  );
}

/** Icon-chip + title header used by the info cards on Settings (e.g. "What
 * Shuffly can access") — the Billing card reads as one of those, not as a
 * pricing tile. */
function BillingInfoCard({
  billing,
  hasActiveSubscription,
  anyBusy,
  onCancel,
}: {
  billing: BillingSummary;
  hasActiveSubscription: boolean;
  anyBusy: boolean;
  onCancel: () => void;
}) {
  const tokens = TONE_TOKENS.warning;
  const nextCharge =
    billing.nextChargeDate && billing.nextChargeAmount != null
      ? `${billing.nextChargeDate} · $${billing.nextChargeAmount.toFixed(2)}`
      : "—";

  return (
    <div
      style={{
        position: "relative",
        background: "var(--p-color-bg-surface, #ffffff)",
        border: "1px solid var(--p-color-border, #e3e3e3)",
        borderRadius: 12,
        boxShadow: "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: tokens.accent }} />
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
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
            <s-icon type="cash-dollar" tone="warning"></s-icon>
          </div>
          <s-heading>Billing</s-heading>
        </div>
        {hasActiveSubscription ? (
          <KeyValueRows
            rows={[
              { label: "Charged through", value: "Shopify" },
              { label: "Next charge", value: nextCharge },
              { label: "Annual", value: billing.isAnnual ? "2 months free" : "—" },
            ]}
          />
        ) : (
          <s-text color="subdued">No charge on the Free plan.</s-text>
        )}
        {hasActiveSubscription && (
          <div style={{ marginTop: 12, opacity: anyBusy ? 0.5 : 1 }}>
            <s-link
              onClick={() => {
                if (!anyBusy) onCancel();
              }}
            >
              Cancel subscription
            </s-link>
          </div>
        )}
      </div>
    </div>
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
    <s-stack direction="block" gap="base">
      <div className="shuffly-plan-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <Bar width={100} />
              <Bar width={70} />
              <Bar width={140} />
              <Bar width={140} />
              <Bar width={140} />
            </s-stack>
          </s-box>
        ))}
      </div>
      <s-box padding="base" borderWidth="base" borderRadius="base">
        <s-stack direction="block" gap="base">
          <Bar width={100} />
          <Bar width={220} />
        </s-stack>
      </s-box>
    </s-stack>
  );
}
