import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

export interface CollectionRowData {
  id: string;
  collectionGid: string;
  title: string;
  status: "RUNNING" | "PAUSED";
  needsAttention: boolean;
  /** Every product in this collection is out of stock — shuffling has
   * nothing to do until inventory changes. Drives a left accent bar, a
   * third line under the name, and a "Pause" shortcut in the overflow
   * menu instead of a full-width page banner about one collection. */
  allSoldOut: boolean;
  /** Facts only — no settings, no state. "10 products · 1 sold out". */
  factsLine: string;
  /** Only the settings that are actually on — "Sold-out last", "2 pins" —
   * never a full list of everything the collection could have configured. */
  settingsBadges: string[];
  /** Up to 5 real products; padded out to 5 slots with placeholders by this
   * component, not by the caller. */
  preview: Array<{ id: string; initial: string; imageUrl: string | null; soldOut: boolean }>;
  scheduleLine: string; // "Daily at 06:00" or "Paused"
  /** True when this collection has its own schedule instead of following the
   * shop default — drives the subdued "Custom" marker in the Schedule cell. */
  scheduleIsCustom: boolean;
  /** The effective schedule the modal opens on. */
  schedule: { scheduleType: string; scheduleTime: string; scheduleTime2: string | null; scheduleWeekday: number | null };
  /** Static fallback sub-line ("Resume to schedule" / "Shuffles only when
   * you press Shuffle") — empty when RUNNING with a real nextRunAt, since
   * that case renders a live ticking countdown instead (see CountdownLine
   * below). */
  scheduleSubLine: string;
  /** Raw target instant, RUNNING collections only — this component ticks
   * its own countdown from it every second, client-side only, no polling. */
  nextRunAt: Date | null;
  /** The sort Shuffly switched this collection away from, as a label, or null.
   * Only read by the bulk-remove dialog — the row itself doesn't render it. */
  restorableSort?: string | null;
  /** True when the collection was already Manual and we captured its order. */
  hasOrderSnapshot?: boolean;
  /** Shopify's current sort for this collection when it is NOT Manual
   * ("Best selling", "Newest"), else null. Shuffly can only reorder a
   * manually-sorted collection, so this being non-null is the row's most
   * important fact — shuffles are silently doing nothing. */
  wrongSortLabel: string | null;
  /** `noMoveReason` is the clause after "0 moved — ", already turned into
   * merchant-facing words by the loader; null when the run moved something
   * or predates the column. */
  lastRun: { moved: number; whenLabel: string; failed: boolean; at: Date; noMoveReason: string | null } | null;
  /** Last 7 runs, oldest first; null = no run in that slot. Renders as a
   * tiny bar chart under the last-run figures. */
  sparkline: Array<{ moved: number } | null>;
}

interface CollectionRowProps {
  collection: CollectionRowData;
  /** Bumped by the parent every time "Shuffle all now" is confirmed — a
   * change (not just truthiness) is what triggers this row to shuffle,
   * so it can fire again on a later "Shuffle all" without re-mounting. */
  shuffleRunId: number | null;
  onShuffleSettled: (id: string) => void;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  /** Opens the parent's existing confirmation modal — the same one the
   * add-collection flow uses. A sort is never switched without it. */
  onSwitchToManual: (collection: CollectionRowData) => void;
  /** Opens the shared schedule modal. Same callback behind the Schedule cell
   * and the menu item, so the two can never diverge. */
  onEditSchedule: (collection: CollectionRowData) => void;
}

const THUMB_SIZE = 26;
const THUMB_MAX = 4;

export function CollectionRow({
  collection: t,
  shuffleRunId,
  onShuffleSettled,
  selected,
  onToggleSelect,
  onSwitchToManual,
  onEditSchedule,
}: CollectionRowProps) {
  const shopify = useAppBridge();
  const shuffleFetcher = useFetcher({ key: `shuffle-${t.id}` });
  const menuActionFetcher = useFetcher({ key: `row-action-${t.id}` });
  const lastHandledRunId = useRef<number | null>(null);
  const wasShuffling = useRef(false);
  // Only a shuffle the merchant started from THIS row's menu gets its own
  // pair of toasts. A bulk "Shuffle all now" drives the very same fetcher on
  // every row at once, and 25 rows each announcing themselves on top of the
  // page's single "Shuffle complete" is noise, not feedback.
  const manualShuffle = useRef(false);
  const menuId = `row-menu-${t.id}`;

  useEffect(() => {
    if (shuffleRunId != null && shuffleRunId !== lastHandledRunId.current && shuffleFetcher.state === "idle") {
      lastHandledRunId.current = shuffleRunId;
      shuffleFetcher.submit({ _action: "shuffle-one", id: t.id }, { method: "post" });
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
    onShuffleSettled(t.id);
    if (!manualShuffle.current) return;
    manualShuffle.current = false;
    // `data` lands in the same render the fetcher goes idle in, so the
    // result is readable right here.
    const result = shuffleFetcher.data as { ok?: boolean; movedCount?: number; error?: string } | undefined;
    if (result?.ok) {
      const moved = result.movedCount ?? 0;
      shopify.toast.show(`${t.title} shuffled — ${moved} product${moved === 1 ? "" : "s"} moved`);
    } else {
      shopify.toast.show(result?.error ?? `Couldn't shuffle ${t.title}`, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onShuffleSettled is stable from parent; data is read only on settle
  }, [shuffleFetcher.state]);

  const isShuffling = shuffleFetcher.state !== "idle";
  const isMenuBusy = menuActionFetcher.state !== "idle";

  // Optimistic pause/resume: while the fetcher is in flight, read the
  // status it's actually submitting instead of waiting for the round trip
  // — formData is only trustworthy while state !== "idle" (it clears back
  // to nothing the instant the fetcher settles), which is exactly the
  // window this needs. If the action fails, this fetcher settles without
  // the real loader data having changed, so the row falls straight back to
  // t.status on its own — "rollback" for free, no extra state to manage.
  const optimisticAction = isMenuBusy ? menuActionFetcher.formData?.get("_action") : null;
  const displayStatus: "RUNNING" | "PAUSED" =
    optimisticAction === "pause" ? "PAUSED" : optimisticAction === "resume" ? "RUNNING" : t.status;

  // The row no longer has a "Shuffle now" button to visibly go quiet, so the
  // acknowledgement has to be the toast — fired before the submit, not after
  // the round trip, so the merchant knows the click landed.
  function shuffleNow() {
    if (isShuffling) return;
    manualShuffle.current = true;
    shopify.toast.show(`Shuffling ${t.title}…`);
    shuffleFetcher.submit({ _action: "shuffle-one", id: t.id }, { method: "post" });
  }

  function togglePause() {
    menuActionFetcher.submit({ _action: t.status === "RUNNING" ? "pause" : "resume", id: t.id }, { method: "post" });
  }

  function removeCollection() {
    menuActionFetcher.submit({ _action: "remove", id: t.id }, { method: "post" });
  }

  const thumbs = t.preview.slice(0, THUMB_MAX);

  const rowClassName = [
    "shuffly-row",
    // Critical beats caution: a wrong sort means shuffles silently do
    // nothing at all, where "everything sold out" means they run and have
    // nothing to move.
    t.needsAttention && "shuffly-row--wrong-sort",
    t.allSoldOut && !t.needsAttention && "shuffly-row--sold-out",
    selected && "shuffly-row--selected",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClassName}>
      {/* The whole row is "clickable" via a plain, absolutely-positioned
         link covering it — not s-clickable wrapping multiple grid cells.
         That wrapper approach (display:grid + subgrid on a shadow-DOM
         custom element) silently failed: its host box doesn't reliably
         hand grid/subgrid formatting through to slotted light-DOM children
         past its own shadow template, so every cell collapsed into one.
         A real <Link> is a plain element with no shadow DOM, so it can't
         have that problem, and it's a stronger pattern anyway — native
         middle-click/cmd-click "open in new tab" and keyboard Enter both
         come for free. z-index keeps the checkbox and actions clickable
         above it (see the CSS); everywhere else, a click just falls
         through to this link since nothing else there handles clicks. */}
      {!isShuffling && (
        <Link
          to={`/app/collections/${t.id}`}
          className="shuffly-row-link-overlay"
          aria-label={`Open ${t.title}`}
        />
      )}

      <div className="shuffly-row-select">
        <s-checkbox
          label={`Select ${t.title}`}
          labelAccessibilityVisibility="exclusive"
          checked={selected}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
          onChange={(e: any) => onToggleSelect(t.id, Boolean(e.currentTarget?.checked))}
        />
      </div>

      {/* Column 2 — name + inline settings badges, facts underneath, and
         (only for a fully sold-out collection) a third amber line. No
         status dot: the Schedule column already says "Paused" or "Daily
         at 06:00", so a dot repeating running/paused was redundant — and
         removing it gives the name back the space it was truncating
         into. */}
      <div className="shuffly-row-text">
        {/* title on a plain element, not s-text — a custom element's prop
           set can't be trusted to forward an arbitrary attribute through
           to the real DOM node it renders. */}
        {/* The name gets the whole line to itself. Badges used to sit beside
            it and, being flexShrink: 0, won every squeeze — "Automated
            Collection (Copy)" became "Automated Colle…" and once even
            vanished entirely. The name is this table's primary identifier;
            it does not compete with a badge for width. */}
        <div className="shuffly-row-title" title={t.title}>
          <s-text type="strong">{t.title}</s-text>
        </div>
        {(t.needsAttention || t.settingsBadges.length > 0) && (
          <div className="shuffly-row-badges">
            {t.needsAttention && <s-badge tone="critical">Not on Manual sort</s-badge>}
            {t.settingsBadges.map((b) => (
              <s-badge key={b} tone="neutral">
                {b}
              </s-badge>
            ))}
          </div>
        )}
        <div className="shuffly-row-meta">
          <s-text color="subdued">{t.factsLine}</s-text>
        </div>
        {t.needsAttention && (
          // Plain words, not jargon: the merchant needs to know shuffling is
          // stopped and what to do, not the name of an enum.
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--p-color-text-critical, #8e0b21)",
              lineHeight: 1.3,
            }}
          >
            Shuffly can&apos;t reorder this until it&apos;s back on Manual sort
            {t.wrongSortLabel ? ` — Shopify has it on ${t.wrongSortLabel}` : ""}
          </div>
        )}
        {t.allSoldOut && !t.needsAttention && (
          // Amber/caution, not brand orange — "sold out" is an attention
          // state, and orange stays reserved for the page's four sanctioned
          // spots (Add-all button, next-run chip, sparkline, selected-row
          // accent — see app.collections.tsx's CSS comment on this).
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--p-color-text-caution, #946200)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Every product is sold out — shuffling changes nothing
          </div>
        )}
      </div>

      {/* Column 3 — thumbnails, up to 4, real products only — no
         placeholder squares for a collection with fewer than 4; the fixed
         column width keeps the grid aligned without them. Hidden below the
         820px container breakpoint (see CSS). */}
      <div className="shuffly-thumbs">
        {thumbs.map((p) =>
          p.imageUrl ? (
            <img
              key={p.id}
              src={p.imageUrl}
              alt=""
              width={THUMB_SIZE}
              height={THUMB_SIZE}
              style={{ borderRadius: 6, objectFit: "cover", opacity: p.soldOut ? 0.4 : 1, flex: "none" }}
            />
          ) : (
            <div
              key={p.id}
              style={{
                width: THUMB_SIZE,
                height: THUMB_SIZE,
                flex: "none",
                borderRadius: 6,
                background: "var(--p-color-bg-fill-secondary, #e3dbd3)",
                color: "var(--p-color-text-secondary, #6b6b6b)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 12,
                opacity: p.soldOut ? 0.4 : 1,
              }}
            >
              {p.initial}
            </div>
          ),
        )}
      </div>

      {/* Column 4 — schedule. The small label is only shown by CSS below
         the 820px container breakpoint, once Schedule/Last run become a
         labelled pair instead of sitting under a column header. */}
      <div className="shuffly-row-schedule">
        <span className="shuffly-row-mobile-label">Schedule</span>
        {/* The primary way into the picker. A merchant who wants to change
            when something runs clicks the thing that says when it runs — far
            more discoverable than a menu item, which is kept as the second
            route. A real button, so keyboard and screen readers get it too;
            it sits above the row's stretched link like the checkbox does. */}
        <div>
          <button
            type="button"
            className="shuffly-schedule-button"
            onClick={() => onEditSchedule(t)}
            aria-label={`Change schedule for ${t.title} — currently ${t.scheduleLine}`}
          >
            <s-text type="strong">{displayStatus === "PAUSED" ? "Paused" : t.scheduleLine}</s-text>
          </button>
          {t.scheduleIsCustom && (
            <span className="shuffly-schedule-custom">
              <s-text color="subdued">Custom</s-text>
            </span>
          )}
        </div>
        <div style={{ fontSize: 12 }}>
          {displayStatus === "RUNNING" && t.nextRunAt ? (
            <CountdownLine target={t.nextRunAt} />
          ) : (
            <s-text color="subdued">{displayStatus === "PAUSED" ? "Resume to schedule" : t.scheduleSubLine}</s-text>
          )}
        </div>
      </div>

      {/* Column 5 — last run, with a 7-run sparkline underneath. */}
      <div className="shuffly-row-lastrun">
        <span className="shuffly-row-mobile-label">Last run</span>
        {t.lastRun == null ? (
          <s-text color="subdued">—</s-text>
        ) : (
          <>
            {/* A bare "0 moved" can't tell a merchant whether the app worked
                and had nothing to do or quietly failed, so the count never
                stands alone — the reason comes from the run record. A failed
                run keeps its critical badge AND says why. */}
            <div>
              {t.lastRun.failed ? (
                <s-badge tone="critical">Failed</s-badge>
              ) : (
                <s-text type="strong">{t.lastRun.moved} moved</s-text>
              )}
            </div>
            {t.lastRun.noMoveReason && (
              <div style={{ fontSize: 12, lineHeight: 1.3 }}>
                {t.lastRun.failed ? (
                  <s-text tone="critical">{t.lastRun.noMoveReason}</s-text>
                ) : (
                  <s-text color="subdued">— {t.lastRun.noMoveReason}</s-text>
                )}
              </div>
            )}
            <div style={{ fontSize: 12 }}>
              <s-text color="subdued">{t.lastRun.whenLabel}</s-text>
            </div>
            {!t.lastRun.failed && <Sparkline data={t.sparkline} />}
          </>
        )}
      </div>

      {/* Column 6 — the overflow menu, and nothing else. The inline
         "Shuffle now"/"Pause"/"Resume" buttons that used to sit here were
         an exact duplicate of the menu's own first two items, so the
         column carried the same two actions twice and reserved 230px on
         every row to do it. The menu is now the single path, and the
         column is only as wide as its trigger.

         Because the trigger is the row's primary action surface now, its
         accessible name has to name the row — a screen-reader user
         landing on a list of 25 buttons all called "···" has nothing to
         pick from. The visible glyph stays "···".

         Contents still depend on status, so the row never offers a
         contradictory pair: only one of Pause/Resume is ever present, and
         a paused collection's one-off shuffle reads "Shuffle once" rather
         than "Shuffle now" — "now" implies a schedule that isn't
         running. */}
      <div className="shuffly-row-actions">
        {/* Icon-only, and NO text child — that is the whole fix for the
            double control. Polaris adds its own disclosure chevron to a
            menu trigger that carries a text label, so rendering "···" as
            text got us a "···" AND a "⌄" that both opened the same menu.
            `icon="menu-horizontal"` is the documented overflow trigger and
            draws exactly one glyph. */}
        <s-button
          icon="menu-horizontal"
          commandFor={menuId}
          variant="tertiary"
          accessibilityLabel={`More actions for ${t.title}`}
        ></s-button>
        <s-menu id={menuId} accessibilityLabel={`More actions for ${t.title}`}>
          {/* Disabled while this collection already has a reorder in
             flight — whether the merchant started it here or a page-level
             "Shuffle all now" did. Two concurrent reorder jobs on one
             collection is what Shopify rejects with
             TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS. */}
          {/* First, and only when it applies: nothing else in this menu does
              anything until the sort is back on Manual. */}
          {t.needsAttention && (
            <s-button icon="sort" onClick={() => onSwitchToManual(t)}>
              Switch to Manual
            </s-button>
          )}
          <s-button icon="clock" onClick={() => onEditSchedule(t)}>
            Set schedule…
          </s-button>
          {displayStatus === "RUNNING" ? (
            <>
              <s-button onClick={shuffleNow} disabled={isShuffling || undefined}>
                {isShuffling ? "Shuffling…" : "Shuffle now"}
              </s-button>
              <s-button onClick={togglePause} disabled={isMenuBusy || undefined}>
                Pause
              </s-button>
            </>
          ) : (
            <>
              <s-button onClick={togglePause} disabled={isMenuBusy || undefined}>
                Resume
              </s-button>
              <s-button onClick={shuffleNow} disabled={isShuffling || undefined}>
                {isShuffling ? "Shuffling…" : "Shuffle once"}
              </s-button>
            </>
          )}
          <s-button tone="critical" onClick={removeCollection}>
            Remove from Shuffly
          </s-button>
        </s-menu>
      </div>
    </div>
  );
}

/** Ticks a "Next run in Xh Ym" line every second, purely client-side —
 * recomputed from the fixed `target` instant against the browser's own
 * clock, never a network request. */
function CountdownLine({ target }: { target: Date }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ms = new Date(target).getTime() - nowMs;
  const label = ms <= 0 ? "any moment" : formatDuration(ms);
  return <s-text color="subdued">Next run in {label}</s-text>;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Seven 4px bars, 2px apart, max 16px tall — decorative only (the moved
 * count and timestamp above already carry the meaning for screen
 * readers). Height scales against the largest run in this collection's own
 * last 7, so one very busy collection's bars don't flatten a quieter one's
 * — grey and short for "moved nothing" or "no run that day", brand orange
 * for real activity. */
function Sparkline({ data }: { data: Array<{ moved: number } | null> }) {
  const max = Math.max(1, ...data.map((d) => d?.moved ?? 0));
  return (
    <div className="shuffly-sparkline" aria-hidden="true">
      {data.map((d, i) => {
        const moved = d?.moved ?? 0;
        const height = moved > 0 ? Math.max(4, Math.round((moved / max) * 16)) : 3;
        return (
          <div
            key={i}
            className={`shuffly-sparkline-bar${moved > 0 ? "" : " shuffly-sparkline-bar--empty"}`}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}
