// The tinted icon chip from the Collections bento, and nothing else.
//
// One tint, brand orange at the low opacity Polaris's own
// bg-fill-warning-secondary role gives — the same pairing the Collections
// stat tiles use, so the two pages read as one app. Deliberately not
// parameterised by tone: four hues on one settings page was decoration
// pretending to encode something.
//
// Sizes and radii are copied from that treatment rather than re-picked.

/** Polaris token, with a same-hue hex fallback that is never the source of
 * truth. */
export const CHIP_TINT = "var(--p-color-bg-fill-warning-secondary, #FFF1E4)";

export function IconChip({
  icon,
  size = 24,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- s-icon's `type` union isn't worth re-declaring here
  icon: any;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="shuffly-icon-chip"
      style={{ background: CHIP_TINT, width: size, height: size }}
    >
      <s-icon type={icon} tone="warning" />
    </span>
  );
}
