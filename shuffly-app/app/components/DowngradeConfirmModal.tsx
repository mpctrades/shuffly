import { forwardRef } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";

export interface DowngradeImpact {
  targetPlanName: string;
  collectionsToPause: string[]; // titles
  maxCollections: number | null; // the target plan's cap, null = unlimited
  undoLossDays: number | null; // set only when the target's undo window is shorter
}

interface DowngradeConfirmModalProps {
  impact: DowngradeImpact | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DowngradeConfirmModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  DowngradeConfirmModalProps
>(function DowngradeConfirmModal({ impact, busy, onConfirm, onCancel }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);

  return (
    <s-modal
      id="downgrade-confirm-modal"
      ref={ref}
      heading={impact ? `Switch to ${impact.targetPlanName}?` : "Switch plan?"}
    >
      {impact && (
        <>
          {impact.collectionsToPause.length > 0 && (
            <s-paragraph>
              {impact.targetPlanName} allows{" "}
              {impact.maxCollections ?? "unlimited"} collection
              {impact.maxCollections === 1 ? "" : "s"}. These{" "}
              {impact.collectionsToPause.length} will be paused:{" "}
              {impact.collectionsToPause.join(", ")}.
            </s-paragraph>
          )}
          {impact.undoLossDays != null && (
            <s-paragraph>
              Snapshots older than {impact.undoLossDays} day
              {impact.undoLossDays === 1 ? "" : "s"} will be deleted.
            </s-paragraph>
          )}
        </>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={onConfirm}
        disabled={busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        Continue
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
