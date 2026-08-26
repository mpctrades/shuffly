import { useState } from "react";
import type { ActivityItem } from "../lib/activity.server";

const ICON_BG: Record<ActivityItem["iconTone"], string> = {
  success: "var(--p-color-bg-fill-success-secondary, #cdfee1)",
  info: "var(--p-color-bg-fill-info-secondary, #e0f0ff)",
  warning: "var(--p-color-bg-fill-warning-secondary, #ffd6a4)",
  critical: "var(--p-color-bg-fill-critical-secondary, #fee9e8)",
};

interface ActivityRowProps {
  item: ActivityItem;
  onRestore: (item: ActivityItem) => void;
  busy: boolean;
}

/** One compact activity row (~56-60px). A grouped burst row (item.children
 * set) gets a chevron that expands, in place, to the individual rows
 * underneath — collapsed by default. */
export function ActivityRow({ item, onRestore, busy }: ActivityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = !!item.children && item.children.length > 1;

  return (
    <div>
      <Row
        item={item}
        onRestore={onRestore}
        busy={busy}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {hasChildren && expanded && (
        <div style={{ paddingLeft: 40 }}>
          {item.children!.map((child, i) => (
            <div key={child.id}>
              <Row item={child} onRestore={onRestore} busy={busy} indented />
              {i < item.children!.length - 1 && <s-divider />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  item,
  onRestore,
  busy,
  expandable,
  expanded,
  onToggle,
  indented,
}: {
  item: ActivityItem;
  onRestore: (item: ActivityItem) => void;
  busy: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  indented?: boolean;
}) {
  const isFailure = item.iconTone === "critical";

  return (
    <div
      className="shuffly-activity-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: indented ? "7px 16px 7px 0" : "11px 16px",
      }}
    >
      <div
        style={{
          width: indented ? 20 : 24,
          height: indented ? 20 : 24,
          flex: "none",
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: ICON_BG[item.iconTone],
        }}
      >
        <s-icon type={item.iconType} tone={item.iconTone} size="small" />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {expandable && (
            <button
              type="button"
              onClick={onToggle}
              aria-label={expanded ? "Collapse" : "Expand"}
              aria-expanded={expanded}
              style={{
                flex: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                border: "none",
                outline: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
                color: "var(--p-color-icon-secondary, #6b6b6b)",
                transform: expanded ? "rotate(90deg)" : "none",
                transition: "transform 120ms ease",
              }}
            >
              <ChevronGlyph />
            </button>
          )}
          <span
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: "var(--p-color-text, #131110)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {item.title}
          </span>
          {isFailure && <s-badge tone="critical">Failed</s-badge>}
        </div>
        {item.meta && (
          <div style={{ fontSize: 12, marginTop: 2 }}>
            <s-text color="subdued">{item.meta}</s-text>
          </div>
        )}
      </div>

      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 8 }}>
        {item.restore && (
          // Hidden until hover/focus via .shuffly-restore-slot in
          // app.activity.tsx's <style> block — always visible on touch and
          // narrow screens, since there's no hover there to reveal it.
          <div className="shuffly-restore-slot">
            <s-button variant="tertiary" onClick={() => onRestore(item)} {...(busy ? { loading: true } : {})}>
              Restore
            </s-button>
          </div>
        )}
        <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          <s-text color="subdued">{item.time}</s-text>
        </span>
      </div>
    </div>
  );
}

function ChevronGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Uppercase, letter-spaced day heading above each day's rows — "Today",
 * "Yesterday", then "20 August". */
export function ActivityDayHeading({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "20px 16px 8px",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--p-color-text-secondary, #6b6b6b)",
      }}
    >
      {label}
    </div>
  );
}
