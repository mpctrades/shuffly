import { useEffect, useRef } from "react";
import { Link, useFetcher } from "react-router";

export interface CollectionRowData {
  id: string;
  collectionGid: string;
  title: string;
  status: "RUNNING" | "PAUSED";
  needsAttention: boolean;
  /** Facts only — no settings, no state. "10 products · 1 sold out". */
  factsLine: string;
  /** Only the settings that are actually on — "Sold-out last", "2 pins" —
   * never a full list of everything the collection could have configured. */
  settingsBadges: string[];
  /** Up to 5 real products; padded out to 5 slots with placeholders by this
   * component, not by the caller. */
  preview: Array<{ id: string; initial: string; imageUrl: string | null; soldOut: boolean }>;
  scheduleLine: string; // "Daily at 06:00" or "Paused"
  scheduleSubLine: string; // "Next run in 6h 12m" or "Resume to schedule"
  lastRun: { moved: number; whenLabel: string; failed: boolean } | null;
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

  function shuffleNow() {
    shuffleFetcher.submit({ _action: "shuffle-one", id: t.id }, { method: "post" });
  }

  function togglePause() {
    menuActionFetcher.submit({ _action: t.status === "RUNNING" ? "pause" : "resume", id: t.id }, { method: "post" });
  }

  function removeCollection() {
    menuActionFetcher.submit({ _action: "remove", id: t.id }, { method: "post" });
  }

  const dotColor = t.needsAttention
    ? "var(--p-color-icon-warning, #FF4B1F)"
    : t.status === "RUNNING"
      ? "var(--p-color-icon-success, #008060)"
      : "var(--p-color-icon-secondary, #6b6b6b)";

  const thumbs = t.preview.slice(0, THUMB_MAX);

  return (
    <div className={`shuffly-row${selected ? " shuffly-row--selected" : ""}`}>
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

      {/* Column 2 — status dot + name + inline settings badges, facts
         underneath. Exactly two lines — the name truncates before the
         badges ever wrap to a line of their own. */}
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
            aria-hidden="true"
            style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: dotColor }}
          />
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
          <s-text type="strong">{t.scheduleLine}</s-text>
        </div>
        <div style={{ fontSize: 12 }}>
          <s-text color="subdued">{t.scheduleSubLine}</s-text>
        </div>
      </div>

      {/* Column 5 — last run */}
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
          </>
        )}
      </div>

      {/* Column 6 — always visible, fixed width, same on every row. Plain
         buttons, not s-button: that component renders its own visible
         border/shadow chrome per instance, which is what was showing as a
         bordered panel wrapping these controls — these sit directly on
         the row. */}
      <div className="shuffly-row-actions">
        <div className="shuffly-row-quick-buttons">
          <button type="button" className="shuffly-row-action-btn" onClick={shuffleNow} disabled={isShuffling}>
            {isShuffling ? "Shuffling…" : "Shuffle now"}
          </button>
          <button type="button" className="shuffly-row-action-btn" onClick={togglePause} disabled={isMenuBusy}>
            {t.status === "RUNNING" ? "Pause" : "Resume"}
          </button>
        </div>
        <s-button command="--toggle" commandFor={menuId} variant="tertiary" accessibilityLabel={`Actions for ${t.title}`}>
          ···
        </s-button>
        <s-menu id={menuId} accessibilityLabel={`Actions for ${t.title}`}>
          {/* Same two actions, mirrored here — below the 820px container
             breakpoint the standalone buttons above are hidden by CSS, so
             this is the only way to reach them; above it, it's just a
             second path to the same action. */}
          <s-button onClick={shuffleNow} disabled={isShuffling || undefined}>
            Shuffle now
          </s-button>
          <s-button onClick={togglePause} disabled={isMenuBusy || undefined}>
            {t.status === "RUNNING" ? "Pause" : "Resume"}
          </s-button>
          <s-button tone="critical" onClick={removeCollection}>
            Remove from Shuffly
          </s-button>
        </s-menu>
      </div>
    </div>
  );
}
