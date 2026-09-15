import { forwardRef, useEffect, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ManualSortConsequences, ReorderDelayNote } from "./ManualSortWarning";

export interface SwitchToManualTarget {
  /** Empty for a collection Shuffly doesn't track yet — see `mode`. */
  id: string;
  gid: string;
  title: string;
  sortOrderLabel: string;
  /** "tracked" = already added, just switch it. "untracked" = switch it AND
   * add it in the same click, which is the one-click flow Fix 04 is about. */
  mode: "tracked" | "untracked";
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
          {/* The brief's required sentence, stated plainly and with the
              collection's actual current sort named — never a silent change. */}
          <s-paragraph>
            This will change your collection sort from{" "}
            <s-text type="strong">{target.sortOrderLabel}</s-text> to{" "}
            <s-text type="strong">Manual</s-text>. Shopify only lets an app set exact positions on a
            manually-sorted collection.
          </s-paragraph>

          <ManualSortConsequences sortOrderLabel={target.sortOrderLabel} />

          <s-switch
            label="Keep the current order to start with"
            checked={keepOrder}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
            onChange={(e: any) => setKeepOrder(Boolean(e.currentTarget?.checked))}
          />
          <s-paragraph>
            {keepOrder
              ? "Nothing visibly changes for customers right now — it keeps showing what it's showing, and the first scheduled shuffle takes it from there."
              : "It'll shuffle right away instead of just sitting in its current order."}
            {target.mode === "untracked" && " Shuffly starts shuffling it on your schedule from here."}
          </s-paragraph>
          {!keepOrder && (
            <s-paragraph>
              <ReorderDelayNote />
            </s-paragraph>
          )}
        </>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => onConfirm(keepOrder)}
        disabled={!target || busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        {target?.mode === "untracked" ? "Switch & start shuffling" : "Switch to Manual"}
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
