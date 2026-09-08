import { useNavigate } from "react-router";
import {
  PLAN_TIERS,
  cadenceLabel,
  collectionCapLabel,
  nextPlanOf,
  overLimitCount,
  planOf,
  timeSlots,
} from "../lib/plans";

/** Shuffly orange — the one hardcoded colour in this component. It appears
 * only as the accent: the left stripe and the current rung's dot, which are
 * driven by the same `accent` value so they can't drift apart. Every other
 * surface, border and text colour is a Polaris token, so the bar follows the
 * admin's light and dark themes. */
const BRAND_ORANGE = "#FF4B1F";

const PLAN_PAGE = "/app/plan";

interface PlanBarProps {
  /** The shop's plan id. `null` means it couldn't be determined — the bar
   * hides itself rather than guessing, since guessing "Free" would show a
   * paying merchant a wrong upgrade prompt. */
  planId: string | null;
  /** Tracked collections, for the over-limit badge. */
  trackedCount: number;
  /** The page's own loading state — renders the skeleton instead of
   * flashing a plan the merchant may not be on. */
  loading?: boolean;
}

/**
 * The plan bar above the Collections stat row: which plan the merchant is
 * on, what it includes, and the way up.
 *
 * Every string here is composed from PLANS (via the helpers in plans.ts) —
 * the ladder rungs, the detail line and the button label. Adding, renaming
 * or repricing a plan needs no edit to this file, and no plan gets a
 * special case: the top tier is simply the one `nextPlanOf` returns null
 * for.
 */
export function PlanBar({ planId, trackedCount, loading = false }: PlanBarProps) {
  const navigate = useNavigate();

  if (loading) return <PlanBarSkeleton />;
  if (!planId) return null;

  const plan = planOf(planId);
  const next = nextPlanOf(planId);
  const slots = timeSlots(planId);
  const over = overLimitCount(planId, trackedCount);
  const isTop = next === null;
  // One accent for the stripe and the current rung's dot: Shuffly orange
  // while there's a tier above, the success token once there isn't.
  const accent = isTop ? "var(--p-color-icon-success, #008060)" : BRAND_ORANGE;

  return (
    <>
      <div className="shuffly-plan-bar">
        <div className="shuffly-plan-bar-stripe" aria-hidden="true" style={{ background: accent }} />
        <div className="shuffly-plan-bar-inner">
          <span className="shuffly-plan-bar-label">Your plan</span>

          <div className="shuffly-plan-ladder" role="group" aria-label="Your plan">
            {PLAN_TIERS.map((tier) => {
              const isCurrent = tier.id === plan.id;
              return (
                <button
                  key={tier.id}
                  type="button"
                  className={`shuffly-plan-rung${isCurrent ? " is-current" : ""}`}
                  aria-pressed={isCurrent}
                  // aria-disabled, not `disabled`: a disabled button drops out
                  // of the tab order, so a keyboard or screen-reader user
                  // would never reach the one rung that says which plan they
                  // are actually on.
                  aria-disabled={isCurrent || undefined}
                  onClick={isCurrent ? undefined : () => navigate(PLAN_PAGE)}
                >
                  {isCurrent && (
                    <span
                      className="shuffly-plan-rung-dot"
                      aria-hidden="true"
                      // Same accent as the stripe, for the same reason: a
                      // nudge while there's a tier above, a confirmation
                      // once there isn't.
                      style={{ background: accent }}
                    />
                  )}
                  {tier.name}
                </button>
              );
            })}
          </div>

          <p className="shuffly-plan-bar-detail">
            You&apos;re on <strong>{plan.name}</strong> · {cadenceLabel(planId)} ·{" "}
            {collectionCapLabel(planId)} · {slots} time slot{slots === 1 ? "" : "s"}
          </p>

          <div className="shuffly-plan-bar-actions">
            {over > 0 && (
              <s-badge tone="warning">
                {over} collection{over === 1 ? "" : "s"} over limit
              </s-badge>
            )}
            {isTop ? (
              <s-text tone="success">✓ You&apos;re on the top plan</s-text>
            ) : (
              <s-button variant="primary" onClick={() => navigate(PLAN_PAGE)}>
                Upgrade to {next.name}
              </s-button>
            )}
          </div>
        </div>
      </div>
      <PlanBarStyles />
    </>
  );
}

/** Same shell and rhythm as the real bar, so the row doesn't resize when the
 * plan lands. */
function PlanBarSkeleton() {
  return (
    <>
      <div className="shuffly-plan-bar">
        <div
          className="shuffly-plan-bar-stripe"
          aria-hidden="true"
          style={{ background: "var(--p-color-border, #e3e3e3)" }}
        />
        <div className="shuffly-plan-bar-inner">
          <span className="shuffly-plan-bar-label">Your plan</span>
          <div className="shuffly-plan-skeleton" style={{ width: 210 }} />
          <div className="shuffly-plan-skeleton" style={{ width: 280 }} />
          <div className="shuffly-plan-bar-actions">
            <div className="shuffly-plan-skeleton" style={{ width: 120 }} />
          </div>
        </div>
      </div>
      <PlanBarStyles />
    </>
  );
}

/** Pseudo-classes and the wrap behaviour can't be expressed inline, and the
 * page's own <style> block is scoped to the route — so the bar carries its
 * own, class-prefixed to stay out of everything else's way. Surfaces,
 * borders and text all use the same tokens as .shuffly-status-card. */
function PlanBarStyles() {
  return (
    <style>{`
      .shuffly-plan-bar {
        position: relative;
        overflow: hidden;
        margin: 20px 0 0;
        border: 1px solid var(--p-color-border, #e3e3e3);
        border-radius: 11px;
        box-shadow: var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07));
        background: var(--p-color-bg-surface, #ffffff);
      }
      .shuffly-plan-bar-stripe {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 3px;
      }
      .shuffly-plan-bar-inner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 16px;
        padding: 11px 14px;
      }
      .shuffly-plan-bar-label {
        flex: none;
        padding-left: 4px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--p-color-text-secondary, #6b6b6b);
      }
      .shuffly-plan-ladder {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        border-radius: 8px;
        background: var(--p-color-bg-surface-secondary, #f1f1f1);
      }
      .shuffly-plan-rung {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 13px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--p-color-text-secondary, #6b6b6b);
        cursor: pointer;
      }
      .shuffly-plan-rung:hover:not(.is-current) {
        color: var(--p-color-text, #303030);
        background: var(--p-color-bg-surface-hover, #f7f7f7);
      }
      .shuffly-plan-rung.is-current {
        background: var(--p-color-bg-surface, #ffffff);
        color: var(--p-color-text, #303030);
        box-shadow: var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07));
        cursor: default;
      }
      .shuffly-plan-rung:focus-visible {
        outline: 2px solid var(--p-color-border-focus, #005bd3);
        outline-offset: 1px;
      }
      .shuffly-plan-rung-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .shuffly-plan-bar-detail {
        margin: 0;
        min-width: 0;
        font-size: 12.5px;
        color: var(--p-color-text-secondary, #6b6b6b);
      }
      .shuffly-plan-bar-detail strong {
        font-weight: 600;
        color: var(--p-color-text, #303030);
      }
      /* Keeps the badge and the button together and hard right, on their own
         line once the row wraps. */
      .shuffly-plan-bar-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-left: auto;
      }
      .shuffly-plan-skeleton {
        height: 12px;
        border-radius: 6px;
        background: var(--p-color-bg-surface-tertiary, #e3e3e3);
      }
      @media (max-width: 720px) {
        .shuffly-plan-bar-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
      }
    `}</style>
  );
}
