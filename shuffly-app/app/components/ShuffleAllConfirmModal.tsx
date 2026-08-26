import { forwardRef } from "react";
import { useFetcher } from "react-router";
import type { ShuffleAllPreview } from "../lib/shuffle-preview.server";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";

interface ShuffleAllConfirmModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export const ShuffleAllConfirmModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  ShuffleAllConfirmModalProps
>(function ShuffleAllConfirmModal({ onConfirm, onCancel }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);
  const previewFetcher = useFetcher<ShuffleAllPreview>({
    key: "shuffle-all-preview",
  });
  const preview = previewFetcher.data;
  const loading = previewFetcher.state !== "idle" || !preview;

  return (
    <s-modal id="shuffle-all-confirm-modal" ref={ref} heading="Shuffle all collections now?">
      <ModalErrorBoundary onClose={onCancel}>
        {loading ? (
          <s-paragraph>Working out what would move…</s-paragraph>
        ) : (
          <>
            <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-text color="subdued">Products moving</s-text>
                  <s-heading>{preview.productsMoving}</s-heading>
                </s-stack>
              </s-box>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-text color="subdued">Sold-out moved down</s-text>
                  <s-heading>{preview.soldOutMovedDown}</s-heading>
                </s-stack>
              </s-box>
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-text color="subdued">Pins held</s-text>
                  <s-heading>{preview.pinsHeld}</s-heading>
                </s-stack>
              </s-box>
            </s-grid>
            {preview.notReady.length > 0 && (
              <s-paragraph>
                {preview.notReady.length} collection
                {preview.notReady.length === 1 ? "" : "s"} won&apos;t run yet
                (not on manual sort): {preview.notReady.join(", ")}.
              </s-paragraph>
            )}
            <s-paragraph>
              Usually takes about {preview.estimatedSeconds} second
              {preview.estimatedSeconds === 1 ? "" : "s"}. Every run is saved
              for 30 days, so any of them can be undone.
            </s-paragraph>
          </>
        )}
      </ModalErrorBoundary>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={onConfirm}
        disabled={loading || undefined}
      >
        Shuffle now
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
