import { forwardRef } from "react";
import { useFetcher } from "react-router";
import type { ShuffleAllPreview } from "../lib/shuffle-preview.server";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";

interface ShuffleAllConfirmModalProps {
  undoRetentionDays: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ShuffleAllConfirmModal = forwardRef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  any,
  ShuffleAllConfirmModalProps
>(function ShuffleAllConfirmModal({ undoRetentionDays, onConfirm, onCancel }, ref) {
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
            <div className="shuffly-preview-tiles">
              {/* "Products moving" leads — the app-wide convention (Insights'
                 three tiles) is a 3px top bar, orange on the lead stat, ink
                 on the rest, rather than the plain grey-bordered boxes this
                 modal had before. */}
              <PreviewTile lead label="Products moving" value={preview.productsMoving} />
              <PreviewTile label="Sold-out moved down" value={preview.soldOutMovedDown} />
              <PreviewTile label="Pins held" value={preview.pinsHeld} />
            </div>
            {preview.notReady.length > 0 && (
              <div className="shuffly-preview-notready">
                <span className="shuffly-preview-notready-dot" aria-hidden="true" />
                <span>
                  {preview.notReady.length} collection{preview.notReady.length === 1 ? "" : "s"} won&apos;t run yet
                  (not on manual sort): {preview.notReady.join(", ")}.
                </span>
              </div>
            )}
            <s-paragraph>
              <s-text color="subdued">
                Usually takes about {preview.estimatedSeconds} second{preview.estimatedSeconds === 1 ? "" : "s"}.
                Order snapshots can be undone for {undoRetentionDays} day{undoRetentionDays === 1 ? "" : "s"}.
              </s-text>
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

      <style>{`
        .shuffly-preview-tiles {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          margin-bottom: 12px;
        }
        .shuffly-preview-tile {
          position: relative;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 10px;
          padding: 12px;
          overflow: hidden;
        }
        .shuffly-preview-tile-bar { position: absolute; top: 0; left: 0; right: 0; height: 3px; }
        .shuffly-preview-tile-label {
          font-size: 12px;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        .shuffly-preview-tile-value {
          font-size: 22px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          margin-top: 2px;
          color: var(--p-color-text, #131110);
        }
        .shuffly-preview-notready {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 10px 12px;
          margin-bottom: 12px;
          border-radius: 8px;
          background: var(--p-color-bg-fill-caution-secondary, #FFF4D6);
          font-size: 13px;
          color: var(--p-color-text, #131110);
        }
        .shuffly-preview-notready-dot {
          flex: none;
          width: 6px;
          height: 6px;
          margin-top: 6px;
          border-radius: 50%;
          background: var(--p-color-icon-caution, #946200);
        }
      `}</style>
    </s-modal>
  );
});

function PreviewTile({ label, value, lead }: { label: string; value: number; lead?: boolean }) {
  return (
    <div className="shuffly-preview-tile">
      <div
        className="shuffly-preview-tile-bar"
        style={{ background: lead ? "var(--p-color-bg-fill-warning, #FF4B1F)" : "var(--p-color-bg-fill-inverse, #131110)" }}
      />
      <div className="shuffly-preview-tile-label">{label}</div>
      <div className="shuffly-preview-tile-value">{value}</div>
    </div>
  );
}
