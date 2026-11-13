// The per-collection data the Collections loader builds. The table row that
// used to render it was replaced by CollectionCard in Update 2 (brief §7:
// "one card per collection"); CollectionCardData extends this, and the bulk
// actions and modals still read these fields.

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
  /** The live product count on its own, unmixed with the sold-out figure —
   * the schedule modal's subtitle needs the number, not the sentence. */
  productCount: number;
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
  schedule: {
    scheduleType: string;
    scheduleTime: string;
    scheduleTime2: string | null;
    scheduleWeekday: number | null;
    intervalHours?: number | null;
  };
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
