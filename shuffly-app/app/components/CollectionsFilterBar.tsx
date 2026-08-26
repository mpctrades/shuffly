// Search + status filter + sort for the Collections list — only shown once
// there are enough tracked collections that finding one by scrolling stops
// being reasonable (see app.collections.tsx). Filtering/sorting itself
// happens entirely client-side on the already-loaded rows — this component
// just reports state changes upward.

export type CollectionStatusFilter = "all" | "running" | "paused" | "attention";
export type CollectionSortKey = "next-run" | "name" | "products" | "last-run";

export interface CollectionStatusCounts {
  all: number;
  running: number;
  paused: number;
  attention: number;
}

const STATUS_OPTIONS: Array<{ value: CollectionStatusFilter; label: string; countKey: keyof CollectionStatusCounts }> = [
  { value: "all", label: "All", countKey: "all" },
  { value: "running", label: "Running", countKey: "running" },
  { value: "paused", label: "Paused", countKey: "paused" },
  { value: "attention", label: "Needs attention", countKey: "attention" },
];

const SORT_OPTIONS: Array<{ value: CollectionSortKey; label: string }> = [
  { value: "next-run", label: "Next run" },
  { value: "name", label: "Name" },
  { value: "products", label: "Most products" },
  { value: "last-run", label: "Last run" },
];

interface CollectionsFilterBarProps {
  q: string;
  status: CollectionStatusFilter;
  sort: CollectionSortKey;
  counts: CollectionStatusCounts;
  onQChange: (v: string) => void;
  onStatusChange: (v: CollectionStatusFilter) => void;
  onSortChange: (v: CollectionSortKey) => void;
}

export function CollectionsFilterBar({
  q,
  status,
  sort,
  counts,
  onQChange,
  onStatusChange,
  onSortChange,
}: CollectionsFilterBarProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 16px" }}>
      <div style={{ flex: "1 1 220px", minWidth: 180 }}>
        <s-search-field
          label="Search collections"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search collections"
          value={q}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
          onChange={(e: any) => onQChange(e.currentTarget?.value ?? "")}
        />
      </div>

      <div className="shuffly-collections-filters" role="group" aria-label="Filter by status">
        {STATUS_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`shuffly-collections-filter-btn${status === o.value ? " shuffly-collections-filter-btn--active" : ""}`}
            onClick={() => onStatusChange(o.value)}
          >
            {o.label} {counts[o.countKey]}
          </button>
        ))}
      </div>

      <div style={{ minWidth: 170 }}>
        <s-select
          label="Sort by"
          labelAccessibilityVisibility="exclusive"
          value={sort}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
          onChange={(e: any) => onSortChange((e.currentTarget?.value as CollectionSortKey) ?? "next-run")}
        >
          {SORT_OPTIONS.map((o) => (
            <s-option key={o.value} value={o.value}>
              Sort: {o.label}
            </s-option>
          ))}
        </s-select>
      </div>
    </div>
  );
}
