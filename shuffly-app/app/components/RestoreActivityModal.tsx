import { forwardRef, useEffect, useState } from "react";
import type { ActivityRestore } from "../lib/activity.server";
import { useModalDismissWorkaround } from "../lib/polaris-modal";

interface RestoreActivityModalProps {
  restore: ActivityRestore;
  busy: boolean;
  onConfirm: (runId: string) => void;
  onCancel: () => void;
}

// Shown for any Activity row with a Restore button. A single-collection run
// confirms directly; a grouped run ("Morning run — 6 collections…") lets the
// merchant pick which of that run's collections to put back.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
export const RestoreActivityModal = forwardRef<any, RestoreActivityModalProps>(function RestoreActivityModal(
  { restore, busy, onConfirm, onCancel },
  ref,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);
  const options = restore?.kind === "choice" ? restore.options : [];
  const [selected, setSelected] = useState<string>(options[0]?.runId ?? "");

  // `restore` swaps to a different row's data each time Restore is clicked —
  // re-pick a default option rather than carrying over a stale selection.
  useEffect(() => {
    setSelected(restore?.kind === "choice" ? restore.options[0]?.runId ?? "" : "");
  }, [restore]);

  const selectedRunId = restore?.kind === "single" ? restore.runId : selected || options[0]?.runId;
  const selectedTitle =
    restore?.kind === "single"
      ? restore.collectionTitle
      : options.find((o) => o.runId === selectedRunId)?.collectionTitle;

  return (
    <s-modal id="restore-activity-modal" ref={ref} heading="Put back this order?">
      {restore?.kind === "choice" && (
        <s-choice-list
          name="runId"
          label="Which collection from this run?"
          values={selectedRunId ? [selectedRunId] : []}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.values isn't in the typed event map
          onChange={(e: any) => setSelected(e.currentTarget?.values?.[0] ?? options[0]?.runId ?? "")}
        >
          {options.map((o) => (
            <s-choice key={o.runId} value={o.runId}>
              {o.collectionTitle} — {o.movedCount} product{o.movedCount === 1 ? "" : "s"} moved
            </s-choice>
          ))}
        </s-choice-list>
      )}
      <s-paragraph>
        This puts back the order {selectedTitle ? <s-text type="strong">{selectedTitle}</s-text> : "it"} had right
        before that run, and pauses it so the next scheduled run doesn&apos;t immediately shuffle it again.
      </s-paragraph>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => selectedRunId && onConfirm(selectedRunId)}
        disabled={!selectedRunId || busy || undefined}
        {...(busy ? { loading: true } : {})}
      >
        Restore
      </s-button>
      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
    </s-modal>
  );
});
