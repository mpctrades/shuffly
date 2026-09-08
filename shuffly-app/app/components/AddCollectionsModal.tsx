import { Fragment, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { ModalErrorBoundary } from "./ModalErrorBoundary";
import { ManualSortConsequences } from "./ManualSortWarning";

export interface AddCollectionsPickerData {
  addable: Array<{
    id: string;
    title: string;
    productsCount: number;
    sortOrder: string;
    sortOrderLabel: string;
    /** True for an automated (or otherwise non-Manual) collection. Still
     * fully selectable — Shuffly switches it as part of adding it. */
    needsManual: boolean;
  }>;
  hasMore?: boolean;
  query?: string;
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
  /** Re-runs the picker loader with a title search — the list is capped
   * server-side (see listAllCollections), so this is how a store with more
   * collections than the cap narrows down to the one it wants. */
  onSearch: (query: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
export const AddCollectionsModal = forwardRef<any, AddCollectionsModalProps>(
  function AddCollectionsModal({ picker, onSubmit, onCancel, onSearch }, ref) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
    useModalDismissWorkaround(ref as { current: any }, onCancel);

    const data = picker.data;
    const formRef = useRef<HTMLFormElement>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [searchTerm, setSearchTerm] = useState("");
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Distinguishes "the modal was just (re)opened" from "a search
    // keystroke reloaded the same open modal" — both land here as a new
    // `data` reference from the same fetcher, but only the former should
    // wipe selections; the latter should keep whichever selected ids are
    // still in the filtered results.
    const searchReloadRef = useRef(false);

    useEffect(() => {
      if (searchReloadRef.current) {
        searchReloadRef.current = false;
        if (data) {
          setSelected((prev) => new Set([...prev].filter((id) => data.addable.some((c) => c.id === id))));
        }
        return;
      }
      // A fresh picker load (every time the modal is opened) should start
      // with nothing selected, not whatever was checked last time.
      setSelected(new Set());
      setSearchTerm("");
    }, [data]);

    useEffect(() => {
      return () => {
        if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      };
    }, []);

    function onSearchInput(value: string) {
      setSearchTerm(value);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => {
        searchReloadRef.current = true;
        onSearch(value);
      }, 300);
    }

    function toggle(id: string, checked: boolean) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (checked) next.add(id);
        else next.delete(id);
        return next;
      });
    }

    // Which of the selected collections Shuffly will have to switch to
    // Manual sort. This is what turns the Add into a confirmed switch.
    const selectedNeedingManual = useMemo(
      () => (data?.addable ?? []).filter((c) => selected.has(c.id) && c.needsManual),
      [data, selected],
    );
    const willSwitchAny = selectedNeedingManual.length > 0;
    // A single acknowledgement covers the whole selection. A nested modal
    // would be the other option, but Polaris modals don't nest reliably and
    // this has to name every collection's own current sort anyway.
    const [confirmedSwitch, setConfirmedSwitch] = useState(false);
    useEffect(() => {
      if (!willSwitchAny) setConfirmedSwitch(false);
    }, [willSwitchAny]);

    const maxCollections = data?.plan.maxCollections ?? null;
    const trackedCount = data?.trackedCount ?? 0;
    const room =
      maxCollections == null
        ? Infinity
        : Math.max(0, maxCollections - trackedCount);
    const nothingSelected = selected.size === 0;
    const overLimit = selected.size > room;
    const needsAcknowledgement = willSwitchAny && !confirmedSwitch;
    const addDisabled = nothingSelected || overLimit || needsAcknowledgement;

    let helperText: string | null = null;
    if (nothingSelected) {
      helperText = "Select at least one collection to add.";
    } else if (overLimit) {
      helperText =
        room === 0
          ? `Your ${data?.plan.name} plan is already at its limit of ${maxCollections} tracked collection${maxCollections === 1 ? "" : "s"}.`
          : `You can add up to ${room} more on your ${data?.plan.name} plan — uncheck ${selected.size - room} to continue.`;
    } else if (needsAcknowledgement) {
      helperText = "Confirm the sort change above to continue.";
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
                  shuffled yet. Pick any of them — Shuffly switches an
                  automated collection to Manual sort for you.
                </s-paragraph>

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

                <s-search-field
                  label="Search collections"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search by collection name"
                  value={searchTerm}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                  onInput={(e: any) => onSearchInput(e.currentTarget?.value ?? "")}
                />

                {data.hasMore && (
                  <s-banner tone="info">
                    Showing the first {data.addable.length} matching collections. Search by
                    name to find a specific one.
                  </s-banner>
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
                              details={
                                c.needsManual
                                  ? `Sorted by ${c.sortOrderLabel} — will be switched to Manual`
                                  : "Manual sort — ready to shuffle"
                              }
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
                  <Fragment key={c.id}>
                    <input type="hidden" name={`collectionTitle:${c.id}`} value={c.title} />
                    {/* So the action knows which ones to switch without
                        re-querying Shopify for every id. It re-checks the
                        live sort order before writing anyway. */}
                    <input type="hidden" name={`collectionSort:${c.id}`} value={c.sortOrder} />
                  </Fragment>
                ))}

                {willSwitchAny && (
                  <s-banner tone="warning" heading="This will change your collection sort to Manual">
                    <s-stack direction="block" gap="small-200">
                      <s-paragraph>
                        {selectedNeedingManual.length === 1
                          ? `"${selectedNeedingManual[0].title}" is sorted by ${selectedNeedingManual[0].sortOrderLabel}.`
                          : `${selectedNeedingManual.length} of the collections you picked use a different sort:`}
                      </s-paragraph>
                      {selectedNeedingManual.length > 1 && (
                        <s-unordered-list>
                          {selectedNeedingManual.map((c) => (
                            <s-list-item key={c.id}>
                              {c.title} — {c.sortOrderLabel} → Manual
                            </s-list-item>
                          ))}
                        </s-unordered-list>
                      )}
                      <ManualSortConsequences
                        sortOrderLabel={
                          selectedNeedingManual.length === 1
                            ? selectedNeedingManual[0].sortOrderLabel
                            : "their current sort"
                        }
                      />
                      <s-checkbox
                        label="I understand — switch them to Manual sort"
                        checked={confirmedSwitch}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                        onChange={(e: any) => setConfirmedSwitch(Boolean(e.currentTarget?.checked))}
                      />
                    </s-stack>
                  </s-banner>
                )}

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
          {willSwitchAny ? "Switch & add" : "Add"}
        </s-button>
        <s-button slot="secondary-actions" onClick={onCancel}>
          Cancel
        </s-button>
      </s-modal>
    );
  },
);
