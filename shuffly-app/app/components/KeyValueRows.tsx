import type { ReactNode } from "react";

export interface KVRow {
  label: string;
  value: ReactNode;
  tone?: "success";
}

/** Label left in grey, value right-aligned and bold, thin divider between
 * rows, none after the last — the read-only row style used on Settings'
 * right column and Plan's feature lists. */
export function KeyValueRows({ rows }: { rows: KVRow[] }) {
  return (
    <s-stack direction="block" gap="none">
      {rows.map((r, i) => (
        <div key={r.label}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "9px 0",
              gap: 12,
            }}
          >
            <s-text color="subdued">{r.label}</s-text>
            {typeof r.value === "string" ? (
              <s-text type="strong" tone={r.tone}>
                {r.value}
              </s-text>
            ) : (
              r.value
            )}
          </div>
          {i < rows.length - 1 && <s-divider />}
        </div>
      ))}
    </s-stack>
  );
}
