import { forwardRef, useEffect, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";
import { ReorderDelayNote } from "./ManualSortWarning";

export interface SortSwitchTarget {
  gid: string;
  title: string;
  /** Human label for the sort it's on now, e.g. "Best selling". */
  sortOrderLabel: string;
}

interface SwitchSortConfirmModalProps {
  /** Only the collections that actually need switching. Ones already on
   * Manual never appear here — they're skipped silently and get no mutation. */
  targets: SortSwitchTarget[];
  busy: boolean;
  onConfirm: (rememberChoice: boolean) => void;
  onCancel: () => void;
}

/**
 * ONE confirmation for a whole batch, not one per collection. Being
 * interrupted per collection was the actual annoyance behind this feature —
 * the click was never the problem.
 *
 * This dialog is not shown at all when every picked collection is already on
 * Manual sort, or when the merchant has previously chosen "don't ask again"
 * (ShopSettings.autoSwitchToManual).
 */
export const SwitchSortConfirmModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  SwitchSortConfirmModalProps
>(function SwitchSortConfirmModal({ targets, busy, onConfirm, onCancel }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);
  const [remember, setRemember] = useState(false);

  // A fresh batch starts with the box unticked — consent is per decision
  // until they explicitly make it standing.
  useEffect(() => {
    setRemember(false);
  }, [targets]);

  const count = targets.length;

  return (
    <s-modal
      id="switch-sort-confirm-modal"
      ref={ref}
      heading={count === 1 ? `Switch 1 collection to Manual sort?` : `Switch ${count} collections to Manual sort?`}
    >
      <ModalErrorBoundary onClose={onCancel}>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Shuffly can only reorder products in collections that use Manual sort.
          </s-paragraph>

          <s-stack direction="block" gap="small-200">
            <s-text type="strong">{count === 1 ? "This will be changed:" : "These will be changed:"}</s-text>
            <s-unordered-list>
              {targets.map((target) => (
                <s-list-item key={target.gid}>
                  {target.title} — {target.sortOrderLabel} → Manual
                </s-list-item>
              ))}
            </s-unordered-list>
          </s-stack>

          <s-paragraph>
            {count === 1 ? "It'll stop sorting itself" : "They'll stop sorting themselves"} automatically.
            Shuffly takes over the order from now on, and you can restore the original sort any time you
            remove a collection from Shuffly.
          </s-paragraph>

          <s-paragraph>
            <s-text color="subdued">
              For automated collections, which products belong stays rule-based — only the order changes.
            </s-text>
          </s-paragraph>

          <s-paragraph>
            <ReorderDelayNote />
          </s-paragraph>

          <s-checkbox
            label="Switch automatically from now on, don't ask again"
            details="You can turn this back off in Settings."
            checked={remember}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
            onChange={(e: any) => setRemember(Boolean(e.currentTarget?.checked))}
          />
        </s-stack>
      </ModalErrorBoundary>

      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => onConfirm(remember)}
        disabled={busy || count === 0 || undefined}
        {...(busy ? { loading: true } : {})}
      >
        Switch and enable
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
