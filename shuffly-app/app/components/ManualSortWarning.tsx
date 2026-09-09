// The two consequences of switching a collection to Manual sort that the
// brief doesn't mention, and that a merchant genuinely needs before they
// click. Shared by every place that offers the switch — the Add modal, the
// "Not shuffled yet" rows, and a tracked collection's own page — so the
// warning can't drift between them.

/** Products newly matching an automated collection's rules are appended to
 * the end of a manually-sorted collection rather than slotted in by the old
 * sort. Shuffly's next run picks them up, which is worth saying out loud. */
export function ManualSortConsequences({ sortOrderLabel }: { sortOrderLabel: string }) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-unordered-list>
        <s-list-item>
          It stops re-sorting itself. It will no longer re-order by{" "}
          <s-text type="strong">{sortOrderLabel}</s-text> — Shuffly sets the order from now on.
        </s-list-item>
        <s-list-item>
          Switching it back later restores the {sortOrderLabel} sort, but{" "}
          <s-text type="strong">not</s-text> the exact order it had before.
        </s-list-item>
        <s-list-item>
          Products that start matching this collection&apos;s rules are added at the end. Shuffly&apos;s next
          run brings them into the rotation.
        </s-list-item>
      </s-unordered-list>
    </s-stack>
  );
}

/** collectionReorderProducts is asynchronous and the storefront is cached,
 * so a new order shows immediately in Shopify admin but lags on the live
 * store. Shown wherever a reorder is triggered. */
export function ReorderDelayNote() {
  return <s-text color="subdued">Changes can take a few minutes to appear on your store.</s-text>;
}
