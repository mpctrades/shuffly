import { forwardRef, useEffect, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";

export interface BulkRemoveRestorable {
  title: string;
  /** The sort Shuffly switched this collection away from, or null when it was
   * already Manual and only its product order can go back. */
  sortOrderLabel: string | null;
}

interface BulkRemoveConfirmModalProps {
  titles: string[];
  /** The subset of the selection that has something to put back. */
  restorable: BulkRemoveRestorable[];
  busy: boolean;
  onConfirm: (restore: boolean) => void;
  onCancel: () => void;
}

export const BulkRemoveConfirmModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  BulkRemoveConfirmModalProps
>(function BulkRemoveConfirmModal({ titles, restorable, busy, onConfirm, onCancel }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);

  // Defaults to restoring, same as removing one collection — and it has to be
  // asked, not assumed: the action restores unless told otherwise, so a
  // dialog that didn't offer the choice would change sorts silently.
  const [restore, setRestore] = useState(true);
  useEffect(() => {
    setRestore(true);
  }, [titles.length, restorable.length]);

  const heading =
    titles.length === 1 ? `Stop shuffling ${titles[0]}?` : `Stop shuffling ${titles.length} collections?`;
  const switchedBack = restorable.filter((r) => r.sortOrderLabel);
  const orderOnly = restorable.length - switchedBack.length;

  return (
    <s-modal id="bulk-remove-confirm-modal" ref={ref} heading={heading}>
      <ModalErrorBoundary onClose={onCancel}>
        <s-stack direction="block" gap="base">
          {restorable.length === 0 ? (
            <s-paragraph>
              {titles.length === 1 ? "Its current order stays as it is." : "Their current order stays as it is."}{" "}
              Shuffly has nothing earlier to put back for{" "}
              {titles.length === 1 ? "this collection" : "these collections"}.
            </s-paragraph>
          ) : (
            <>
              <s-choice-list
                name="bulk-restore-choice"
                values={[restore ? "restore" : "leave"]}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.values isn't in the typed event map
                onChange={(e: any) => setRestore((e.currentTarget?.values?.[0] ?? "restore") === "restore")}
              >
                <s-choice value="restore">
                  Put back what Shuffly changed ({restorable.length} of {titles.length})
                </s-choice>
                <s-choice value="leave">Leave everything exactly as it is</s-choice>
              </s-choice-list>

              {restore ? (
                <s-stack direction="block" gap="small-200">
                  {switchedBack.length > 0 && (
                    <s-unordered-list>
                      {switchedBack.map((item) => (
                        <s-list-item key={item.title}>
                          {item.title} — sort back to {item.sortOrderLabel}
                        </s-list-item>
                      ))}
                    </s-unordered-list>
                  )}
                  {orderOnly > 0 && (
                    <s-text color="subdued">
                      {orderOnly} {orderOnly === 1 ? "collection was" : "collections were"} already on Manual
                      sort — {orderOnly === 1 ? "its" : "their"} original product order goes back instead.
                    </s-text>
                  )}
                  <s-text color="subdued">Changes can take a few minutes to appear on your store.</s-text>
                </s-stack>
              ) : (
                <s-text color="subdued">
                  Every collection keeps the order Shuffly last set. Nothing changes for customers.
                </s-text>
              )}
            </>
          )}

          {titles.length > 1 && (
            <s-paragraph>
              <s-text color="subdued">{titles.join(", ")}</s-text>
            </s-paragraph>
          )}
        </s-stack>
      </ModalErrorBoundary>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        onClick={() => onConfirm(restorable.length > 0 ? restore : false)}
        disabled={busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        {restorable.length > 0 && restore ? "Remove and restore" : "Remove"}
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
