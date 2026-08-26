import { forwardRef } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";

interface BulkRemoveConfirmModalProps {
  titles: string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const BulkRemoveConfirmModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  BulkRemoveConfirmModalProps
>(function BulkRemoveConfirmModal({ titles, busy, onConfirm, onCancel }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);

  const heading =
    titles.length === 1 ? `Stop shuffling ${titles[0]}?` : `Stop shuffling ${titles.length} collections?`;
  const body = titles.length === 1 ? "Its current order stays as it is." : "Their current order stays as it is.";

  return (
    <s-modal id="bulk-remove-confirm-modal" ref={ref} heading={heading}>
      <ModalErrorBoundary onClose={onCancel}>
        <s-paragraph>{body}</s-paragraph>
        {titles.length > 1 && (
          <s-paragraph>
            <s-text color="subdued">{titles.join(", ")}</s-text>
          </s-paragraph>
        )}
      </ModalErrorBoundary>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        onClick={onConfirm}
        disabled={busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        Remove
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
