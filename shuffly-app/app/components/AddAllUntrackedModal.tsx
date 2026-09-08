import { forwardRef } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";
import { ManualSortConsequences } from "./ManualSortWarning";

export interface AddAllUntrackedItem {
  gid: string;
  title: string;
  sortOrder: string;
  sortOrderLabel: string;
}

interface AddAllUntrackedModalProps {
  items: AddAllUntrackedItem[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for the "Add all N" button. It used to switch every
 * non-Manual collection in the list without asking, which is exactly the
 * silent sort change the brief rules out — and doing it in bulk is the case
 * where it matters most.
 */
export const AddAllUntrackedModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  AddAllUntrackedModalProps
>(function AddAllUntrackedModal({ items, busy, onConfirm, onCancel }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);

  const needsManual = items.filter((item) => item.sortOrder !== "MANUAL");

  return (
    <s-modal
      id="add-all-untracked-modal"
      ref={ref}
      heading={`Start shuffling ${items.length} collection${items.length === 1 ? "" : "s"}?`}
    >
      <ModalErrorBoundary onClose={onCancel}>
        {needsManual.length === 0 ? (
          <s-paragraph>
            All of them already use Manual sort, so nothing about how they&apos;re sorted changes.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              This will change{" "}
              <s-text type="strong">
                {needsManual.length} collection{needsManual.length === 1 ? "'s" : "s'"} sort
              </s-text>{" "}
              to Manual:
            </s-paragraph>
            <s-unordered-list>
              {needsManual.map((item) => (
                <s-list-item key={item.gid}>
                  {item.title} — {item.sortOrderLabel} → Manual
                </s-list-item>
              ))}
            </s-unordered-list>
            <ManualSortConsequences
              sortOrderLabel={needsManual.length === 1 ? needsManual[0].sortOrderLabel : "their current sort"}
            />
            <s-paragraph>
              <s-text color="subdued">
                The rest already use Manual sort, so nothing changes for those.
              </s-text>
            </s-paragraph>
          </s-stack>
        )}
      </ModalErrorBoundary>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={onConfirm}
        disabled={busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        {needsManual.length > 0 ? "Switch & add all" : "Add all"}
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
