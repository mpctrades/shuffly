import { forwardRef, useEffect, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";

export interface SwitchToManualTarget {
  id: string;
  gid: string;
  title: string;
  sortOrderLabel: string;
}

interface SwitchToManualModalProps {
  target: SwitchToManualTarget | null;
  busy: boolean;
  onConfirm: (keepOrder: boolean) => void;
  onCancel: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
export const SwitchToManualModal = forwardRef<any, SwitchToManualModalProps>(function SwitchToManualModal(
  { target, busy, onConfirm, onCancel },
  ref,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);
  const [keepOrder, setKeepOrder] = useState(true);

  // Reset to the default every time a different collection is targeted.
  useEffect(() => {
    setKeepOrder(true);
  }, [target]);

  return (
    <s-modal
      id="switch-to-manual-modal"
      ref={ref}
      heading={target ? `Switch "${target.title}" to Manual sort?` : "Switch to Manual sort?"}
    >
      {target && (
        <>
          <s-paragraph>
            It&apos;s currently sorted by <s-text type="strong">{target.sortOrderLabel}</s-text>. Shopify only lets
            an app set exact positions when a collection uses Manual sort, so Shuffly needs to switch it before it
            can start shuffling.
          </s-paragraph>
          <s-switch
            label="Keep the current order to start with"
            checked={keepOrder}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
            onChange={(e: any) => setKeepOrder(Boolean(e.currentTarget?.checked))}
          />
          <s-paragraph>
            {keepOrder
              ? "Nothing visibly changes for customers right now — it keeps showing what it's showing."
              : "It'll shuffle right away instead of just sitting in its current order."}{" "}
            You can always switch it back to {target.sortOrderLabel} sort from Shopify admin.
          </s-paragraph>
        </>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => onConfirm(keepOrder)}
        disabled={!target || busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        Switch to Manual
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
