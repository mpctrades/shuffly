// The stat tile from the Collections bento, extracted so other pages can use
// the same treatment instead of a lookalike.
//
// Every value here is copied from the Collections page's own status row — 32px
// chip at 8px radius, 12px label over a 15px/700 value, 16px card padding at
// 12px radius, 16px grid gap — so the two pages read as one app rather than
// two designers' guesses. If the treatment changes, it changes here.
//
// Collections still carries its own copy of these rules under the
// `shuffly-status-*` class names; migrating it to this component is a
// follow-up worth doing, and deliberately not bundled into a Settings change.
import type React from "react";

/** Polaris tone tokens with same-hue hex fallbacks, never the source of
 * truth. `warning` is the brand orange role — the one place colour and brand
 * coincide, and the same pairing the Collections tiles use. */
export const STAT_TONES = {
  warning: { accent: "var(--p-color-icon-warning, #FF4B1F)", tint: "var(--p-color-bg-fill-warning-secondary, #FFF1E4)" },
  success: { accent: "var(--p-color-icon-success, #008060)", tint: "var(--p-color-bg-fill-success-secondary, #E3F5EE)" },
  critical: { accent: "var(--p-color-icon-critical, #D82C0D)", tint: "var(--p-color-bg-fill-critical-secondary, #FEE9E8)" },
  info: { accent: "var(--p-color-icon-info, #1F5199)", tint: "var(--p-color-bg-fill-info-secondary, #EAF2FF)" },
} as const;

export type StatTone = keyof typeof STAT_TONES;

/** A tinted icon chip at the treatment the Collections tiles use. Exported on
 * its own because the section headings want the chip without the tile. */
export function StatChip({
  icon,
  tone,
  size = 32,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- s-icon's `type` union isn't worth re-declaring here
  icon: any;
  tone: StatTone;
  size?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className="shuffly-stat-chip"
      style={{ background: STAT_TONES[tone].tint, width: size, height: size }}
    >
      <s-icon type={icon} tone={tone === "info" ? "info" : tone} />
    </div>
  );
}

export function StatTile({
  icon,
  tone,
  label,
  value,
  detail,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- s-icon's `type` union isn't worth re-declaring here
  icon: any;
  tone: StatTone;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="shuffly-stat-card">
      <StatChip icon={icon} tone={tone} />
      <div style={{ minWidth: 0 }}>
        <div className="shuffly-stat-label">{label}</div>
        <div className="shuffly-stat-value">{value}</div>
        {detail && <div className="shuffly-stat-detail">{detail}</div>}
      </div>
    </div>
  );
}

/** The grid, plus the one style block these tiles need. Rendered once per
 * page, wrapping the tiles. */
export function StatTileRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="shuffly-stat-row"
      style={{ containerType: "inline-size", containerName: "shuffly-stats" }}
    >
      {children}
      <style>{`
        .shuffly-stat-row {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
        }
        .shuffly-stat-card {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 16px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 12px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-stat-chip {
          flex: none;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .shuffly-stat-label { font-size: 12px; color: var(--p-color-text-secondary, #6b6b6b); }
        .shuffly-stat-value {
          font-size: 15px;
          font-weight: 700;
          color: var(--p-color-text, #131110);
          margin-top: 1px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .shuffly-stat-detail { font-size: 12px; color: var(--p-color-text-secondary, #6b6b6b); margin-top: 2px; }
        @container shuffly-stats (max-width: 900px) {
          .shuffly-stat-row { grid-template-columns: repeat(2, 1fr); }
        }
        @container shuffly-stats (max-width: 460px) {
          .shuffly-stat-row { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
