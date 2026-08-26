import { useState } from "react";
import type { ActivityItem, ActivityKind } from "../lib/activity.server";

/** Dot fill + halo colour per kind — every value here is a Polaris token;
 * the hex after each is a same-hue fallback only. The halo needs a real
 * alpha value (Polaris tokens don't expose a translucent variant), so it's
 * a literal rgba() in the same hue as the dot — flagged here as the one
 * deliberate exception to "tokens only". */
const KIND_STYLE: Record<ActivityKind, { dot: string; halo: string; hollow?: boolean }> = {
  run: { dot: "var(--p-color-bg-fill-warning, #FF4B1F)", halo: "rgba(255, 75, 31, 0.16)" },
  automatic: { dot: "var(--p-color-icon-info, #1F5199)", halo: "rgba(31, 81, 153, 0.14)" },
  attention: { dot: "var(--p-color-icon-caution, #946200)", halo: "rgba(148, 98, 0, 0.14)" },
  failure: { dot: "var(--p-color-icon-critical, #D82C0D)", halo: "rgba(216, 44, 13, 0.14)" },
  setting: { dot: "var(--p-color-bg-surface, #ffffff)", halo: "rgba(107, 107, 107, 0.1)", hollow: true },
};

interface ActivityRowProps {
  item: ActivityItem;
  onRestore: (item: ActivityItem) => void;
  onShowDiff: (item: ActivityItem) => void;
  busy: boolean;
  /** The day-group's rail colour — solid orange for today, fading through
   * pale orange to grey for older groups (computed once per day in the
   * route, passed down so every row in a day shares the exact same line
   * colour and the segments read as one continuous rail). */
  railColor: string;
  /** Suppresses the rail line below this row — the last row in a day group
   * shouldn't have the line running on past its own dot into empty space. */
  isLastInGroup: boolean;
  /** Newly-arrived entry after a poll — flashes a brief highlight instead
   * of just silently appearing. */
  justArrived?: boolean;
}

/** One activity entry on the rail: a dot, a bold title (+ an orange "N
 * moved" pill), one meta line (time, facts, an orange text-link action),
 * and — for a collapsed burst or a day's settings summary — a "Show"
 * toggle that expands `item.children` in place, indented behind a pale
 * rail of their own. */
export function ActivityRow({ item, onRestore, onShowDiff, busy, railColor, isLastInGroup, justArrived }: ActivityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = !!item.children && item.children.length > (item.kind === "setting" ? 0 : 1);

  return (
    <div>
      <Row
        item={item}
        onRestore={onRestore}
        onShowDiff={onShowDiff}
        busy={busy}
        railColor={railColor}
        showRailBelow={!isLastInGroup || (hasChildren && expanded)}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        justArrived={justArrived}
      />
      {hasChildren && expanded && (
        <div className="shuffly-activity-children">
          {item.children!.map((child) => (
            <Row key={child.id} item={child} onRestore={onRestore} onShowDiff={onShowDiff} busy={busy} railColor={railColor} indented />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  item,
  onRestore,
  onShowDiff,
  busy,
  railColor,
  showRailBelow,
  expandable,
  expanded,
  onToggle,
  indented,
  justArrived,
}: {
  item: ActivityItem;
  onRestore: (item: ActivityItem) => void;
  onShowDiff: (item: ActivityItem) => void;
  busy: boolean;
  railColor?: string;
  showRailBelow?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  indented?: boolean;
  justArrived?: boolean;
}) {
  const style = KIND_STYLE[item.kind];
  const facts = item.meta;

  const rowClassName = ["shuffly-activity-row", justArrived && "shuffly-activity-row--new"].filter(Boolean).join(" ");

  return (
    <div className={rowClassName}>
      {!indented && (
        <div className="shuffly-activity-rail-col" aria-hidden="true">
          {showRailBelow && <div className="shuffly-activity-rail-line" style={{ background: railColor }} />}
          <span
            className="shuffly-activity-dot"
            style={{
              background: style.dot,
              boxShadow: `0 0 0 3px var(--p-color-bg-surface, #ffffff), 0 0 0 9px ${style.halo}`,
              border: style.hollow ? "1.5px solid var(--p-color-border, #c9c9c9)" : "none",
            }}
          />
        </div>
      )}

      <div className="shuffly-activity-body" style={indented ? { marginLeft: 30 } : undefined}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="shuffly-activity-title">{item.title}</span>
          {item.movedCount != null && <span className="shuffly-activity-pill">{item.movedCount} moved</span>}
        </div>
        {/* A child row inside an expanded batch shares its parent's
           timestamp — showing it again on every child is redundant, so a
           child with nothing else to say (no facts, no action) renders no
           meta line at all, matching the mockup's plain "Sale — 7 products
           moved" single-line children. */}
        {(!indented || facts || item.restore || item.diff) && (
        <div className="shuffly-activity-meta">
          {!indented && <span className="shuffly-activity-time">{item.time}</span>}
          {facts && (
            <>
              {!indented && <span className="shuffly-activity-dotsep"> · </span>}
              <span>{facts}</span>
            </>
          )}
          {item.restore && (
            <>
              <span className="shuffly-activity-dotsep"> · </span>
              <button type="button" className="shuffly-activity-link" onClick={() => onRestore(item)} disabled={busy}>
                Restore this order
              </button>
            </>
          )}
          {item.diff && (
            <>
              <span className="shuffly-activity-dotsep"> · </span>
              <button type="button" className="shuffly-activity-link" onClick={() => onShowDiff(item)}>
                See what changed
              </button>
            </>
          )}
          {expandable && (
            <>
              <span className="shuffly-activity-dotsep"> · </span>
              <button
                type="button"
                className="shuffly-activity-link"
                onClick={onToggle}
                aria-expanded={expanded}
              >
                {expanded ? "Hide" : "Show"}
              </button>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

/** Orange text, a small pulsing dot — the newest day group's heading. Older
 * headings are plain subdued grey text. Pulse respects reduced-motion. */
export function ActivityDayHeading({ label, isToday }: { label: string; isToday: boolean }) {
  return (
    <div className={`shuffly-activity-day-heading${isToday ? " shuffly-activity-day-heading--today" : ""}`}>
      {label}
      {isToday && <span className="shuffly-activity-pulse-dot" aria-hidden="true" />}
    </div>
  );
}
