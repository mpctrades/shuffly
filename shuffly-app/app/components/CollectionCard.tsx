// One card per collection (Update 2, brief §7): three settings and one
// button.
//
//   Title · N products                                    [status]
//   Frequency        [Every 2 hours ▾]   Next shuffle in 42 min
//   New arrivals     ☑ Reshuffle when new products are added  PRO
//                    ☑ Keep new products on top for [48 h ▾]  PRO
//   Fixed products   3 pinned · 2 excluded · Edit
//   Last run: today 14:00 · 1,240 products · Undo        [Shuffle now]
//
// Edits are held by the page and saved together from the contextual save
// bar (Shopify's pattern for unsaved changes); the card only reports them.
// Shuffle now, Undo and the preset act immediately, like they always have.
//
// Layout stability matters for the Built for Shopify Web Vitals (CLS): every
// row of the card is always rendered, so a value arriving or a save landing
// never changes the card's height. The countdown ticks from one page-level
// clock passed in as `now`, not a timer per card.

import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { CollectionRowData } from "./CollectionRow";
import { useT, type MessageKey } from "../i18n";
import {
  NEW_ON_TOP_CHOICES,
  formatDuration,
  formatWhen,
  frequencyOptions,
  hasPresetApplied,
  type Cadence,
} from "../lib/card-model";
import { canUseNewArrivals } from "../lib/plans";

export interface CollectionCardData extends CollectionRowData {
  cadence: Cadence;
  reshuffleOnNew: boolean;
  keepNewOnTop: boolean;
  newOnTopHours: number;
  pins: number;
  /** Products carrying a shop "never move" tag as of the last run; null
   * before the first run since Update 2. */
  excludedCount: number | null;
  /** Paused because the sort was changed away from Manual. */
  sortPaused: boolean;
  lastRealRun: { at: Date | string; failed: boolean; moved: number } | null;
  canUndo: boolean;
  /** Title says "new", "nouveau", "arrival" or "latest". */
  suggestPreset: boolean;
  /** Preset clicked before upgrading; applied once on Pro. */
  presetPending: boolean;
}

export interface CardDraft {
  cadence?: Cadence;
  reshuffleOnNew?: boolean;
  keepNewOnTop?: boolean;
  newOnTopHours?: number;
}

interface Props {
  card: CollectionCardData;
  draft: CardDraft | undefined;
  onDraftChange: (id: string, patch: CardDraft) => void;
  planId: string;
  timezone: string;
  /** Page-level clock, ms. */
  now: number;
  /** A server error code for this card from the last save, if any. */
  saveError: string | null;
  // Same wiring the table row had, so "Shuffle all now", selection and the
  // existing modals keep working unchanged.
  shuffleRunId: number | null;
  onShuffleSettled: (id: string) => void;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onSwitchToManual: (card: CollectionCardData) => void;
  onEditSchedule: (card: CollectionCardData) => void;
}

const PRESET_DISMISS_KEY = "shuffly.presetDismissed.";

export function CollectionCard({
  card,
  draft,
  onDraftChange,
  planId,
  timezone,
  now,
  saveError,
  shuffleRunId,
  onShuffleSettled,
  selected,
  onToggleSelect,
  onSwitchToManual,
  onEditSchedule,
}: Props) {
  const t = useT();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const shuffleFetcher = useFetcher({ key: `shuffle-${card.id}` });
  const menuFetcher = useFetcher({ key: `row-action-${card.id}` });
  const undoFetcher = useFetcher<{ ok?: boolean; error?: string }>({ key: `undo-${card.id}` });
  const presetFetcher = useFetcher<{ ok?: boolean; queued?: boolean; code?: string }>({ key: `preset-${card.id}` });
  const lastHandledRunId = useRef<number | null>(null);
  const wasShuffling = useRef(false);
  const manualShuffle = useRef(false);
  const menuId = `card-menu-${card.id}`;

  // Effective values: the unsaved draft if there is one, else what's saved.
  const cadence = draft?.cadence ?? card.cadence;
  const reshuffleOnNew = draft?.reshuffleOnNew ?? card.reshuffleOnNew;
  const keepNewOnTop = draft?.keepNewOnTop ?? card.keepNewOnTop;
  const newOnTopHours = draft?.newOnTopHours ?? card.newOnTopHours;
  const proFeatures = canUseNewArrivals(planId);
  const options = frequencyOptions(planId, card.cadence, t);
  const anyLocked = options.some((o) => o.disabled);

  // ---- Shuffle now (same fetcher key as before: "Shuffle all now" drives it)
  useEffect(() => {
    if (shuffleRunId != null && shuffleRunId !== lastHandledRunId.current && shuffleFetcher.state === "idle") {
      lastHandledRunId.current = shuffleRunId;
      shuffleFetcher.submit({ _action: "shuffle-one", id: card.id }, { method: "post" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher identity is stable per key
  }, [shuffleRunId]);

  useEffect(() => {
    if (shuffleFetcher.state !== "idle") {
      wasShuffling.current = true;
      return;
    }
    if (!wasShuffling.current) return;
    wasShuffling.current = false;
    onShuffleSettled(card.id);
    if (!manualShuffle.current) return;
    manualShuffle.current = false;
    const result = shuffleFetcher.data as { ok?: boolean; movedCount?: number; error?: string } | undefined;
    if (result?.ok) {
      shopify.toast.show(t.plural("toast.shuffled", result.movedCount ?? 0, { title: card.title }));
    } else {
      const known = result?.error === "IN_PROGRESS" ? t("error.IN_PROGRESS") : null;
      shopify.toast.show(known ?? result?.error ?? t("toast.shuffleFailed", { title: card.title }), { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read only on settle
  }, [shuffleFetcher.state]);

  useEffect(() => {
    if (undoFetcher.state !== "idle" || !undoFetcher.data) return;
    if (undoFetcher.data.ok) shopify.toast.show(t("toast.undone", { title: card.title }));
    else shopify.toast.show(undoFetcher.data.error ?? t("toast.undoFailed", { title: card.title }), { isError: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read only on settle
  }, [undoFetcher.state, undoFetcher.data]);

  useEffect(() => {
    if (presetFetcher.state !== "idle" || !presetFetcher.data) return;
    if (presetFetcher.data.ok) {
      shopify.toast.show(t("preset.applied", { title: card.title }));
    } else if (presetFetcher.data.queued) {
      // Not on Pro: the click is remembered and applied after upgrading.
      shopify.toast.show(t("preset.pending", { title: card.title }));
      navigate("/app/plan");
    } else {
      shopify.toast.show(t(`error.${presetFetcher.data.code ?? "generic"}` as MessageKey), { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read only on settle
  }, [presetFetcher.state, presetFetcher.data]);

  const isShuffling = shuffleFetcher.state !== "idle";
  const optimisticAction = menuFetcher.state !== "idle" ? menuFetcher.formData?.get("_action") : null;
  const status: "RUNNING" | "PAUSED" =
    optimisticAction === "pause" ? "PAUSED" : optimisticAction === "resume" ? "RUNNING" : card.status;

  function shuffleNow() {
    if (isShuffling) return;
    manualShuffle.current = true;
    shopify.toast.show(t("toast.shuffling", { title: card.title }));
    shuffleFetcher.submit({ _action: "shuffle-one", id: card.id }, { method: "post" });
  }

  // ---- preset suggestion (banner for new-arrivals titles, link otherwise)
  const [presetDismissed, setPresetDismissed] = useState(false);
  useEffect(() => {
    try {
      setPresetDismissed(window.localStorage.getItem(PRESET_DISMISS_KEY + card.id) === "1");
    } catch {
      // Storage blocked (private window, preview): the banner just shows.
    }
  }, [card.id]);
  const presetApplied = hasPresetApplied({ cadence, reshuffleOnNew, keepNewOnTop });
  const showPresetBanner = card.suggestPreset && !presetApplied && !presetDismissed && !card.presetPending;
  function applyPreset() {
    presetFetcher.submit({ _action: "apply-preset", id: card.id }, { method: "post" });
  }
  function dismissPreset() {
    setPresetDismissed(true);
    try {
      window.localStorage.setItem(PRESET_DISMISS_KEY + card.id, "1");
    } catch {
      // Not remembered across visits; fine.
    }
  }

  // ---- status badge
  const badge = card.sortPaused ? (
    <s-badge tone="critical">{t("card.status.sortChanged")}</s-badge>
  ) : status === "PAUSED" ? (
    <s-badge tone="neutral">{t("card.status.paused")}</s-badge>
  ) : card.allSoldOut ? (
    <s-badge tone="caution">{t("card.status.allSoldOut")}</s-badge>
  ) : (
    <s-badge tone="success">{t("card.status.active")}</s-badge>
  );

  // ---- next shuffle
  const nextAt = card.nextRunAt ? new Date(card.nextRunAt).getTime() : null;
  const nextLine =
    card.sortPaused || status === "PAUSED"
      ? t("card.resumeToSchedule")
      : nextAt == null
        ? t("card.noAutomatic")
        : nextAt - now <= 60_000
          ? t("card.nextSoon")
          : t("card.nextIn", { duration: formatDuration(nextAt - now, t) });

  const lastRun = card.lastRealRun;
  const fixedParts = [
    card.pins > 0 ? t.plural("card.pinned", card.pins) : null,
    card.excludedCount ? t.plural("card.excluded", card.excludedCount) : null,
  ].filter(Boolean);

  return (
    <div className={["shuffly-card", card.sortPaused && "shuffly-card--warning", selected && "shuffly-card--selected"].filter(Boolean).join(" ")}>
      {/* Header */}
      <div className="shuffly-card-header">
        <s-checkbox
          label={t("card.select", { title: card.title })}
          labelAccessibilityVisibility="exclusive"
          checked={selected}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
          onChange={(e: any) => onToggleSelect(card.id, Boolean(e.currentTarget?.checked))}
        />
        <div className="shuffly-card-title">
          <Link to={`/app/collections/${card.id}`} className="shuffly-card-title-link" title={card.title}>
            <s-text type="strong">{card.title}</s-text>
          </Link>
          <s-text color="subdued"> · {t.plural("card.products", card.productCount)}</s-text>
        </div>
        <div className="shuffly-card-header-end">
          {badge}
          <s-button icon="menu-horizontal" commandFor={menuId} variant="tertiary" accessibilityLabel={t("card.moreActions", { title: card.title })}></s-button>
          <s-menu id={menuId} accessibilityLabel={t("card.moreActions", { title: card.title })}>
            {card.sortPaused && (
              <s-button icon="sort" onClick={() => onSwitchToManual(card)}>
                {t("card.switchToManual")}
              </s-button>
            )}
            <s-button icon="clock" onClick={() => onEditSchedule(card)}>
              {t("card.setTimes")}
            </s-button>
            <s-button
              onClick={() => menuFetcher.submit({ _action: status === "RUNNING" ? "pause" : "resume", id: card.id }, { method: "post" })}
              disabled={menuFetcher.state !== "idle" || undefined}
            >
              {status === "RUNNING" ? t("card.pause") : t("card.resume")}
            </s-button>
            <s-button tone="critical" onClick={() => menuFetcher.submit({ _action: "remove", id: card.id }, { method: "post" })}>
              {t("card.remove")}
            </s-button>
          </s-menu>
        </div>
      </div>

      {/* Paused / warning states live on the card itself. */}
      {card.sortPaused && (
        <div className="shuffly-card-alert shuffly-card-alert--critical" role="status">
          <span>{card.wrongSortLabel ? t("card.sortWarning", { sort: card.wrongSortLabel }) : t("card.sortWarningUnknown")}</span>
          <s-button variant="secondary" onClick={() => onSwitchToManual(card)}>
            {t("card.switchToManual")}
          </s-button>
        </div>
      )}
      {!card.sortPaused && card.allSoldOut && (
        <div className="shuffly-card-alert shuffly-card-alert--caution" role="status">
          {t("card.allSoldOut")}
        </div>
      )}

      {showPresetBanner && (
        <div className="shuffly-card-preset">
          <div>
            <s-text type="strong">{t("preset.title")}</s-text>
            <div className="shuffly-card-subtle">{t("preset.body")}</div>
          </div>
          <div className="shuffly-card-preset-actions">
            <s-button variant="tertiary" onClick={dismissPreset}>
              {t("preset.dismiss")}
            </s-button>
            <s-button variant="primary" onClick={applyPreset} {...(presetFetcher.state !== "idle" ? { loading: true } : {})}>
              {t("preset.button")}
              {!proFeatures ? ` · ${t("badge.pro")}` : ""}
            </s-button>
          </div>
        </div>
      )}

      {/* Settings */}
      <div className="shuffly-card-grid">
        <div className="shuffly-card-label">{t("card.frequency")}</div>
        <div className="shuffly-card-value shuffly-card-frequency">
          <s-select
            label={t("card.frequency")}
            labelAccessibilityVisibility="exclusive"
            value={cadence}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
            onChange={(e: any) => {
              const next = String(e.currentTarget?.value ?? "");
              const chosen = options.find((o) => o.value === next);
              // A greyed option never changes the setting (native selects
              // already refuse disabled options; this covers anything else).
              if (!chosen || chosen.disabled) return;
              onDraftChange(card.id, { cadence: next === card.cadence ? undefined : next });
            }}
          >
            {options.map((o) => (
              <s-option key={o.value} value={o.value} disabled={o.disabled || undefined}>
                {o.label}
              </s-option>
            ))}
          </s-select>
          <span className="shuffly-card-subtle shuffly-card-next">{nextLine}</span>
          {anyLocked && (
            <Link to="/app/plan" className="shuffly-card-unlock">
              {t("card.unlockPro")}
            </Link>
          )}
        </div>

        <div className="shuffly-card-label">{t("card.newArrivals")}</div>
        <div className="shuffly-card-value shuffly-card-stack">
          <div className="shuffly-card-inline">
            <s-checkbox
              label={t("card.reshuffleOnNew")}
              checked={reshuffleOnNew}
              disabled={!proFeatures || undefined}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
              onChange={(e: any) => {
                const v = Boolean(e.currentTarget?.checked);
                onDraftChange(card.id, { reshuffleOnNew: v === card.reshuffleOnNew ? undefined : v });
              }}
            />
            <s-badge tone="info">{t("badge.pro")}</s-badge>
          </div>
          <div className="shuffly-card-inline">
            <s-checkbox
              label={t("card.keepNewOnTop")}
              checked={keepNewOnTop}
              disabled={!proFeatures || undefined}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
              onChange={(e: any) => {
                const v = Boolean(e.currentTarget?.checked);
                onDraftChange(card.id, { keepNewOnTop: v === card.keepNewOnTop ? undefined : v });
              }}
            />
            <div className="shuffly-card-window">
              <s-select
                label={t("card.keepNewOnTopWindow")}
                labelAccessibilityVisibility="exclusive"
                value={String(newOnTopHours)}
                disabled={!proFeatures || undefined}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                onChange={(e: any) => {
                  const v = Number(e.currentTarget?.value);
                  onDraftChange(card.id, { newOnTopHours: v === card.newOnTopHours ? undefined : v });
                }}
              >
                {NEW_ON_TOP_CHOICES.map((h) => (
                  <s-option key={h} value={String(h)}>
                    {t(`window.${h}` as MessageKey)}
                  </s-option>
                ))}
              </s-select>
            </div>
            <s-badge tone="info">{t("badge.pro")}</s-badge>
          </div>
          {!proFeatures && (
            <Link to="/app/plan" className="shuffly-card-unlock">
              {t("card.unlockPro")}
            </Link>
          )}
        </div>

        <div className="shuffly-card-label">{t("card.fixedProducts")}</div>
        <div className="shuffly-card-value">
          <span>{fixedParts.length > 0 ? fixedParts.join(" · ") : t("card.noFixed")}</span>
          {" · "}
          <Link to={`/app/collections/${card.id}`} aria-label={t("card.editFixedFor", { title: card.title })}>
            {t("card.edit")}
          </Link>
        </div>
      </div>

      {saveError && (
        <div className="shuffly-card-alert shuffly-card-alert--critical" role="alert">
          {t(`error.${saveError}` as MessageKey)}
        </div>
      )}

      {/* Footer */}
      <div className="shuffly-card-footer">
        <div className="shuffly-card-subtle">
          {lastRun ? t("card.lastRun", { when: formatWhen(new Date(lastRun.at), new Date(now), timezone, t) }) : t("card.notShuffledYet")}
          {" · "}
          {t.plural("card.products", card.productCount)}
          {card.canUndo && (
            <>
              {" · "}
              <button
                type="button"
                className="shuffly-card-linkbutton"
                aria-label={t("card.undoFor", { title: card.title })}
                disabled={undoFetcher.state !== "idle"}
                onClick={() => undoFetcher.submit({ _action: "undo-last", id: card.id }, { method: "post" })}
              >
                {t("card.undo")}
              </button>
            </>
          )}
          {!card.suggestPreset && !presetApplied && !card.presetPending && (
            <>
              {" · "}
              <button type="button" className="shuffly-card-linkbutton" onClick={applyPreset}>
                {t("preset.link")}
                {!proFeatures ? ` (${t("badge.pro")})` : ""}
              </button>
            </>
          )}
        </div>
        <s-button
          variant="primary"
          onClick={shuffleNow}
          disabled={isShuffling || card.sortPaused || undefined}
          {...(isShuffling ? { loading: true } : {})}
        >
          {status === "PAUSED" ? t("card.shuffleOnce") : t("card.shuffleNow")}
        </s-button>
      </div>
    </div>
  );
}

/** Same footprint as a card, for the loading state — so nothing jumps when
 * the data arrives (CLS). */
export function CollectionCardSkeleton() {
  return (
    <div className="shuffly-card shuffly-card--skeleton" aria-hidden="true">
      <div className="shuffly-card-skel shuffly-card-skel--title" />
      <div className="shuffly-card-skel" />
      <div className="shuffly-card-skel" />
      <div className="shuffly-card-skel" />
      <div className="shuffly-card-skel shuffly-card-skel--short" />
    </div>
  );
}
