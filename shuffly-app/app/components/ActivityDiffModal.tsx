import { forwardRef } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";

interface ActivityDiffModalProps {
  /** The pinned-zone snapshot from an EXTERNAL_REORDER_DETECTED entry —
   * what the merchant's own drag in Shopify admin actually showed
   * ("before"), and what Shuffly put back ("after"). Product GIDs only —
   * this is a quick "did this look right" check, not a full product
   * lookup, so it shows the position number and a shortened id rather
   * than fetching titles. */
  diff: { before: string[]; after: string[] } | null;
  onClose: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
export const ActivityDiffModal = forwardRef<any, ActivityDiffModalProps>(function ActivityDiffModal({ diff, onClose }, ref) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onClose);

  return (
    <s-modal id="activity-diff-modal" ref={ref} heading="What changed">
      <ModalErrorBoundary onClose={onClose}>
        <s-paragraph>
          Someone in Shopify admin dragged products around by hand. Here&apos;s what your pinned spots looked like right
          after that, and what Shuffly put back at the next run.
        </s-paragraph>
        {diff && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 8 }}>
            <DiffColumn heading="After their edit" ids={diff.before} tone="var(--p-color-text-critical, #D82C0D)" />
            <DiffColumn heading="Put back to" ids={diff.after} tone="var(--p-color-text-success, #008060)" />
          </div>
        )}
      </ModalErrorBoundary>
      <s-button slot="primary-action" onClick={onClose}>
        Done
      </s-button>
    </s-modal>
  );
});

function DiffColumn({ heading, ids, tone }: { heading: string; ids: string[]; tone: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: tone, marginBottom: 6 }}>{heading}</div>
      <s-stack direction="block" gap="small-200">
        {ids.map((id, i) => (
          <div key={id} style={{ display: "flex", gap: 6, fontSize: 13 }}>
            <s-text color="subdued">{i + 1}.</s-text>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              …{id.slice(-8)}
            </span>
          </div>
        ))}
      </s-stack>
    </div>
  );
}
