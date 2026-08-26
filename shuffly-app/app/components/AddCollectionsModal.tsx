import { forwardRef, useEffect, useRef, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";

export interface AddCollectionsPickerData {
  addable: Array<{ id: string; title: string; productsCount: number }>;
  nonManualCount: number;
  plan: { name: string; maxCollections: number | null };
  firstTrackedTitle: string | null;
  trackedCount: number;
}

interface AddCollectionsModalProps {
  picker: {
    state: "idle" | "loading" | "submitting";
    data: AddCollectionsPickerData | undefined;
  };
  onSubmit: (formData: FormData) => void;
  onCancel: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
export const AddCollectionsModal = forwardRef<any, AddCollectionsModalProps>(
  function AddCollectionsModal({ picker, onSubmit, onCancel }, ref) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
    useModalDismissWorkaround(ref as { current: any }, onCancel);

    const data = picker.data;
    const formRef = useRef<HTMLFormElement>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());

    // A fresh picker load (every time the modal is opened) should start with
    // nothing selected, not whatever was checked last time.
    useEffect(() => {
      setSelected(new Set());
    }, [data]);

    function toggle(id: string, checked: boolean) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      });
    }

    const maxCollections = data?.plan.maxCollections ?? null;
    const trackedCount = data?.trackedCount ?? 0;
    const room =
      maxCollections == null
        ? Infinity
        : Math.max(0, maxCollections - trackedCount);
    const nothingSelected = selected.size === 0;
    const overLimit = selected.size > room;
    const addDisabled = nothingSelected || overLimit;

    let helperText: string | null = null;
    if (nothingSelected) {
      helperText = "Select at least one collection to add.";
    } else if (overLimit) {
      helperText =
        room === 0
          ? `Your ${data?.plan.name} plan is already at its limit of ${maxCollections} tracked collection${maxCollections === 1 ? "" : "s"}.`
          : `You can add up to ${room} more on your ${data?.plan.name} plan — uncheck ${selected.size - room} to continue.`;
    }

    return (
      <s-modal id="add-collections-modal" ref={ref} heading="Add collections">
        <ModalErrorBoundary onClose={onCancel}>
          {!data ? (
            <s-paragraph>Loading your collections…</s-paragraph>
          ) : (
            <form
              id="add-collections-form"
              ref={formRef}
              onSubmit={(e) => {
                // A real <Form> navigation left the modal with no signal to know
                // when the submission actually finished, so it never closed
                // itself — hand the data to the parent's fetcher instead, which
                // the parent watches to close this modal once it settles.
                e.preventDefault();
                onSubmit(new FormData(e.currentTarget));
              }}
            >
              <input type="hidden" name="_action" value="add-collections" />

              <s-stack direction="block" gap="base">
                <s-paragraph>
                  {data.addable.length} collection
                  {data.addable.length === 1 ? "" : "s"} aren&apos;t being
                  shuffled yet.
                </s-paragraph>

                {data.nonManualCount > 0 && (
                  <s-banner tone="warning">
                    {data.nonManualCount} collection
                    {data.nonManualCount === 1 ? "" : "s"} use
                    {data.nonManualCount === 1 ? "s" : ""} a different sort
                    order. Switch {data.nonManualCount === 1 ? "it" : "them"} to
                    Manual sort first.
                  </s-banner>
                )}

                {data.addable.length > 0 && (
                  <s-select
                    label="Start them with"
                    name="startWith"
                    value={data.firstTrackedTitle ? "same" : "sold-out-only"}
                  >
                    {data.firstTrackedTitle && (
                      <s-option value="same">
                        The same settings as &quot;{data.firstTrackedTitle}
                        &quot;
                      </s-option>
                    )}
                    <s-option value="sold-out-only">
                      Sold-out to the end only
                    </s-option>
                    <s-option value="nothing">
                      Nothing — I&apos;ll set it up myself
                    </s-option>
                  </s-select>
                )}

                {data.addable.length > 0 && (
                  <div>
                    <s-text color="subdued">
                      Collections to add
                      {maxCollections != null &&
                        ` · ${data.plan.name} plan allows up to ${maxCollections}`}
                    </s-text>
                    <div
                      style={{
                        marginTop: 8,
                        border: "1px solid var(--p-color-border, #e3e3e3)",
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      {data.addable.map((c, i) => (
                        <div key={c.id}>
                          <div style={{ padding: "10px 12px" }}>
                            <s-checkbox
                              name="collectionGid"
                              value={c.id}
                              label={`${c.title} — ${c.productsCount} product${c.productsCount === 1 ? "" : "s"}`}
                              checked={selected.has(c.id)}
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                              onChange={(e: any) =>
                                toggle(c.id, Boolean(e.currentTarget?.checked))
                              }
                            />
                          </div>
                          {i < data.addable.length - 1 && <s-divider />}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {data.addable.map((c) => (
                  <input
                    key={c.id}
                    type="hidden"
                    name={`collectionTitle:${c.id}`}
                    value={c.title}
                  />
                ))}

                {helperText && <s-text color="subdued">{helperText}</s-text>}
              </s-stack>
            </form>
          )}
        </ModalErrorBoundary>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => formRef.current?.requestSubmit()}
          disabled={addDisabled || undefined}
        >
          Add
        </s-button>
        <s-button slot="secondary-actions" onClick={onCancel}>
          Cancel
        </s-button>
      </s-modal>
    );
  },
);
