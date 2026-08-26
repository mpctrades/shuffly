import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

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
  /** Static fallback sub-line ("Resume to schedule" / "Shuffles only when
   * you press Shuffle") — empty when RUNNING with a real nextRunAt, since
   * that case renders a live ticking countdown instead (see CountdownLine
   * below). */
  scheduleSubLine: string;
  /** Raw target instant, RUNNING collections only — this component ticks
   * its own countdown from it every second, client-side only, no polling. */
  nextRunAt: Date | null;
  lastRun: { moved: number; whenLabel: string; failed: boolean; at: Date } | null;
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
}

const THUMB_SIZE = 26;
const THUMB_MAX = 4;

export function CollectionRow({
  collection: t,
  shuffleRunId,
  onShuffleSettled,
  selected,
  onToggleSelect,
}: CollectionRowProps) {
  const shuffleFetcher = useFetcher({ key: `shuffle-${t.id}` });
  const menuActionFetcher = useFetcher({ key: `row-action-${t.id}` });
  const lastHandledRunId = useRef<number | null>(null);
  const wasShuffling = useRef(false);
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
    } else if (wasShuffling.current) {
      wasShuffling.current = false;
      onShuffleSettled(t.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onShuffleSettled is stable from parent
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

  function shuffleNow() {
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
    t.allSoldOut && "shuffly-row--sold-out",
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
        <div
          className="shuffly-row-title"
          title={t.title}
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "nowrap" }}
        >
          <span
            style={{
              flex: "1 1 0%",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <s-text type="strong">{t.title}</s-text>
          </span>
          {t.settingsBadges.map((b) => (
            <span key={b} style={{ flexShrink: 0 }}>
              <s-badge tone="neutral">{b}</s-badge>
            </span>
          ))}
        </div>
        <div className="shuffly-row-meta">
          <s-text color="subdued">{t.factsLine}</s-text>
        </div>
        {t.allSoldOut && (
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
        <div>
          <s-text type="strong">{displayStatus === "PAUSED" ? "Paused" : t.scheduleLine}</s-text>
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
        ) : t.lastRun.failed ? (
          <s-badge tone="critical">Failed</s-badge>
        ) : (
          <>
            <div>
              <s-text type="strong">{t.lastRun.moved} moved</s-text>
            </div>
            <div style={{ fontSize: 12 }}>
              <s-text color="subdued">{t.lastRun.whenLabel}</s-text>
            </div>
            <Sparkline data={t.sparkline} />
          </>
        )}
      </div>

      {/* Column 6 — always visible, fixed width, same on every row. Plain
         buttons, not s-button: that component renders its own visible
         border/shadow chrome per instance, which is what was showing as a
         bordered panel wrapping these controls — these sit directly on
         the row. Contents depend on status so the row never shows a
         contradictory pair (a paused collection offering "Shuffle now"
         right next to "Resume") and never shows more than one filled
         button: Running gets two secondary buttons (Shuffle now, Pause);
         Paused gets one primary/filled button (Resume) and nothing else
         — its one-off shuffle moves into the overflow menu as "Shuffle
         once", since "now" implies a schedule that isn't running. */}
      <div className="shuffly-row-actions">
        <div className="shuffly-row-quick-buttons">
          {displayStatus === "RUNNING" ? (
            <>
              <button type="button" className="shuffly-row-action-btn" onClick={shuffleNow} disabled={isShuffling}>
                {isShuffling ? "Shuffling…" : "Shuffle now"}
              </button>
              <button type="button" className="shuffly-row-action-btn" onClick={togglePause} disabled={isMenuBusy}>
                Pause
              </button>
            </>
          ) : (
            <button
              type="button"
              className="shuffly-row-action-btn shuffly-row-action-btn--primary"
              onClick={togglePause}
              disabled={isMenuBusy}
            >
              Resume
            </button>
          )}
        </div>
        <s-button command="--toggle" commandFor={menuId} variant="tertiary" accessibilityLabel={`Actions for ${t.title}`}>
          ···
        </s-button>
        <s-menu id={menuId} accessibilityLabel={`Actions for ${t.title}`}>
          {/* Mirrors the quick buttons above, plus Remove — below the
             820px container breakpoint the standalone buttons are hidden
             by CSS, so this is the only way to reach them there; above
             it, it's a second path to the same actions. */}
          {displayStatus === "RUNNING" ? (
            <>
              <s-button onClick={shuffleNow} disabled={isShuffling || undefined}>
                Shuffle now
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
                Shuffle once
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
