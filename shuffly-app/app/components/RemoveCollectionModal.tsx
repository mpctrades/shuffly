import { forwardRef, useEffect, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";

export interface RemoveRestorable {
  /** The sort Shuffly switched this collection away from, e.g. "Best
   * selling". Null when it was already on Manual when it was added. */
  sortOrderLabel: string | null;
  /** True only when there's a real captured order to put back — i.e. the
   * collection was already Manual and we snapshotted it on the way in. */
  hasOrderSnapshot: boolean;
}

interface RemoveCollectionModalProps {
  title: string;
  restorable: RemoveRestorable;
  busy: boolean;
  onConfirm: (restore: boolean) => void;
  onCancel: () => void;
}

/**
 * Removing a collection asks what to do with Shuffly's footprint, defaulting
 * to putting it back. Never silent in either direction.
 *
 * The copy is driven entirely by `restorable`, so it only ever promises what
 * the code can deliver. The three cases are genuinely different:
 *
 *  - We switched the sort: restoring that sort is the meaningful restore.
 *    Product positions become irrelevant the moment an automatic sort is back
 *    on, because Shopify recomputes the order from the rule.
 *  - It was already Manual and we snapshotted it: the merchant's own curated
 *    order is what goes back.
 *  - No snapshot (added before this existed): nothing is promised at all.
 */
export const RemoveCollectionModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  RemoveCollectionModalProps
>(function RemoveCollectionModal({ title, restorable, busy, onConfirm, onCancel }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);

  const canRestore = Boolean(restorable.sortOrderLabel) || restorable.hasOrderSnapshot;
  // Defaults to restoring — the merchant is undoing something, so undoing it
  // properly is the expected outcome.
  const [restore, setRestore] = useState(true);
  useEffect(() => {
    setRestore(true);
  }, [title, restorable.sortOrderLabel, restorable.hasOrderSnapshot]);

  return (
    <s-modal id="remove-collection-modal" ref={ref} heading={`Remove ${title} from Shuffly?`}>
      <ModalErrorBoundary onClose={onCancel}>
        <s-stack direction="block" gap="base">
          <s-paragraph>Shuffly will stop shuffling this collection.</s-paragraph>

          {canRestore ? (
            <>
              <s-choice-list
                name="restore-choice"
                values={[restore ? "restore" : "leave"]}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.values isn't in the typed event map
                onChange={(e: any) => {
                  const next = e.currentTarget?.values?.[0] ?? "restore";
                  setRestore(next === "restore");
                }}
              >
                {/* s-choice takes its label as children; the React wrapper
                    omits `details`, so the explanation sits below instead. */}
                <s-choice value="restore">
                  {restorable.sortOrderLabel
                    ? `Put the sort back to ${restorable.sortOrderLabel}`
                    : "Put the original product order back"}
                </s-choice>
                <s-choice value="leave">Leave it exactly as it is</s-choice>
              </s-choice-list>

              <s-paragraph>
                <s-text color="subdued">
                  {restore
                    ? restorable.sortOrderLabel
                      ? `${title} goes back to sorting itself by ${restorable.sortOrderLabel}, the way it did before Shuffly. Shopify recalculates that sort, so the exact order Shuffly had set isn't kept.`
                      : "The order this collection had when you added it to Shuffly. Changes can take a few minutes to appear on your store."
                    : "Keeps the order Shuffly last set. Nothing changes for customers."}
                </s-text>
              </s-paragraph>
            </>
          ) : (
            <s-paragraph>
              The order it currently has stays exactly as it is — nothing reverts. Shuffly has no
              snapshot of an earlier order for this collection, so there&apos;s nothing to put back.
            </s-paragraph>
          )}
        </s-stack>
      </ModalErrorBoundary>

      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        onClick={() => onConfirm(canRestore ? restore : false)}
        disabled={busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        {canRestore && restore ? "Remove and restore" : "Remove"}
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
