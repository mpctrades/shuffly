import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useFetcher, useLoaderData, useNavigation, useSearchParams, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { undoRun } from "../lib/shuffle-engine.server";
import {
  loadActivityPage,
  loadActivitySummary,
  loadActivityCollectionOptions,
  type ActivityItem,
  type ActivityRestore,
  type ActivityPage,
  type ActivityFilter,
  type ActivityQuery,
} from "../lib/activity.server";
import { closeModal } from "../lib/polaris-modal";
import { ActivityRow, ActivityDayHeading } from "../components/ActivityRow";
import { RestoreActivityModal } from "../components/RestoreActivityModal";

const FILTERS: Array<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "runs", label: "Runs" },
  { value: "automatic", label: "Automatic" },
  { value: "attention", label: "Needs attention" },
];

function readQuery(url: URL): ActivityQuery {
  const filter = url.searchParams.get("filter");
  return {
    filter: (FILTERS.some((f) => f.value === filter) ? filter : "all") as ActivityFilter,
    collectionId: url.searchParams.get("collectionId"),
    showEmpty: url.searchParams.get("showEmpty") === "1",
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getOrCreateShopSettings(admin, shop);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const query = readQuery(url);

  try {
    const [page, summary, collectionOptions] = await Promise.all([
      loadActivityPage(shop, settings.timezone, cursor, query),
      loadActivitySummary(shop, settings.timezone, new Date()),
      loadActivityCollectionOptions(shop),
    ]);
    return { ...page, summary, collectionOptions, error: null as string | null };
  } catch {
    return {
      items: [],
      nextCursor: null,
      hasMore: false,
      summary: { runsToday: 0, productsMovedToday: 0 },
      collectionOptions: [],
      error: "Couldn't load activity just now. Try refreshing.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const runId = String(formData.get("runId"));
  const run = await db.shuffleRun.findFirst({ where: { id: runId, shop }, include: { collection: true } });
  if (!run) return data({ ok: false, error: "That run couldn't be found." }, { status: 404 });
  const result = await undoRun(admin, shop, run.collection, run.id);
  return data(result.ok ? { ok: true } : { ok: false, error: result.error ?? "Couldn't restore that order." });
};

export default function Activity() {
  const initial = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const loadOlderFetcher = useFetcher<ActivityPage & { error: string | null }>();
  const restoreFetcher = useFetcher<{ ok: boolean; error?: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const restoreModalRef = useRef<any>(null);

  const rawFilter = searchParams.get("filter");
  const filter: ActivityFilter = FILTERS.some((f) => f.value === rawFilter) ? (rawFilter as ActivityFilter) : "all";
  const collectionId = searchParams.get("collectionId") ?? "";
  const showEmpty = searchParams.get("showEmpty") === "1";

  // Seeded once from the initial load, then grown by "Load older". Restoring
  // an order revalidates this route's loader (a normal side effect of
  // submitting the restore action) but doesn't change anything about how an
  // already-visible entry reads, so we deliberately don't resync this list
  // to every revalidated load — that would collapse "Load older" progress
  // every time someone restores something. It DOES resync when the filter
  // bar changes (below), since that's a genuinely different list.
  const [items, setItems] = useState<ActivityItem[]>(() => initial.items);
  const [cursor, setCursor] = useState(() => initial.nextCursor);
  const [hasMore, setHasMore] = useState(() => initial.hasMore);
  const [pendingRestore, setPendingRestore] = useState<ActivityRestore>(null);

  useEffect(() => {
    setItems(initial.items);
    setCursor(initial.nextCursor);
    setHasMore(initial.hasMore);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync only when the filter bar (not a restore) produced a new `initial`
  }, [filter, collectionId, showEmpty]);

  useEffect(() => {
    if (loadOlderFetcher.state === "idle" && loadOlderFetcher.data) {
      const page = loadOlderFetcher.data;
      if (!page.error) {
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } else {
        shopify.toast.show(page.error, { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [loadOlderFetcher.state, loadOlderFetcher.data]);

  useEffect(() => {
    if (restoreFetcher.state === "idle" && restoreFetcher.data) {
      closeModal(restoreModalRef.current);
      if (restoreFetcher.data.ok) {
        shopify.toast.show("Order restored — collection paused");
      } else {
        shopify.toast.show(restoreFetcher.data.error ?? "Couldn't restore that order", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [restoreFetcher.state, restoreFetcher.data]);

  const isPageLoading = navigation.state === "loading" && navigation.location?.pathname === "/app/activity";

  function loadOlder() {
    if (!cursor) return;
    const params = new URLSearchParams();
    params.set("cursor", cursor);
    if (filter !== "all") params.set("filter", filter);
    if (collectionId) params.set("collectionId", collectionId);
    if (showEmpty) params.set("showEmpty", "1");
    loadOlderFetcher.load(`/app/activity?${params.toString()}`);
  }

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    next.delete("cursor"); // any filter change starts back at the first page
    if (value == null || value === "") next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  }

  function openRestore(item: ActivityItem) {
    if (!item.restore) return;
    setPendingRestore(item.restore);
    restoreModalRef.current?.showOverlay();
  }

  function confirmRestore(runId: string) {
    restoreFetcher.submit({ runId }, { method: "post" });
  }

  function exportCsv() {
    const rows = [["When", "Event", "Details"], ...items.map((it) => [`${it.dayLabel} ${it.time}`, it.title, it.meta])];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shuffly-activity.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // One heading per distinct day, in order, right before that day's first row.
  let lastDayKey: string | null = null;

  return (
    <s-page heading="Activity">
      <s-button slot="secondary-actions" onClick={exportCsv} disabled={items.length === 0 || undefined}>
        Export
      </s-button>
      <s-button slot="secondary-actions" command="--toggle" commandFor="activity-overflow-menu" accessibilityLabel="More actions">
        ···
      </s-button>
      <s-menu id="activity-overflow-menu" accessibilityLabel="More actions">
        <s-button onClick={() => shopify.toast.show("Retention settings aren't available yet")}>
          Retention settings
        </s-button>
      </s-menu>

      <s-text color="subdued">
        {initial.summary.runsToday} run{initial.summary.runsToday === 1 ? "" : "s"} today ·{" "}
        {initial.summary.productsMovedToday} products moved. Anything with a Restore button can be undone.
      </s-text>

      {/* Filter bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12, marginBottom: 4 }}>
        <div className="shuffly-activity-filters" role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`shuffly-activity-filter-btn${filter === f.value ? " shuffly-activity-filter-btn--active" : ""}`}
              onClick={() => updateParam("filter", f.value === "all" ? null : f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ minWidth: 180 }}>
          <s-select
            label="Collection"
            labelAccessibilityVisibility="exclusive"
            value={collectionId}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
            onChange={(e: any) => updateParam("collectionId", e.currentTarget?.value || null)}
          >
            <s-option value="">All collections</s-option>
            {initial.collectionOptions.map((c) => (
              <s-option key={c.id} value={c.id}>
                {c.title}
              </s-option>
            ))}
          </s-select>
        </div>

        <s-switch
          label="Show runs that changed nothing"
          checked={showEmpty || undefined}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
          onChange={(e: any) => updateParam("showEmpty", e.currentTarget?.checked ? "1" : null)}
        />
      </div>

      {initial.error && <s-banner tone="critical">{initial.error}</s-banner>}

      <s-section padding="none">
        {isPageLoading ? (
          <ActivitySkeletonRows />
        ) : items.length === 0 ? (
          <EmptyActivityState />
        ) : (
          <>
            {items.map((item) => {
              const showHeading = item.dayKey !== lastDayKey;
              lastDayKey = item.dayKey;
              return (
                <div key={item.id}>
                  {showHeading && <ActivityDayHeading label={item.dayLabel} />}
                  <ActivityRow item={item} onRestore={openRestore} busy={restoreFetcher.state !== "idle"} />
                  <s-divider />
                </div>
              );
            })}
            {loadOlderFetcher.state !== "idle" && <ActivitySkeletonRows count={3} />}
            <s-box padding="base">
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text color="subdued">Kept for 30 days</s-text>
                {hasMore ? (
                  <s-button
                    variant="tertiary"
                    onClick={loadOlder}
                    {...(loadOlderFetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    Load older
                  </s-button>
                ) : (
                  <s-text color="subdued">That&apos;s everything</s-text>
                )}
              </s-stack>
            </s-box>
          </>
        )}
      </s-section>

      <RestoreActivityModal
        ref={restoreModalRef}
        restore={pendingRestore}
        busy={restoreFetcher.state !== "idle"}
        onConfirm={confirmRestore}
        onCancel={() => closeModal(restoreModalRef.current)}
      />

      <style>{`
        .shuffly-restore-slot { opacity: 0; transition: opacity 100ms ease; }
        .shuffly-activity-row:hover .shuffly-restore-slot,
        .shuffly-activity-row:focus-within .shuffly-restore-slot {
          opacity: 1;
        }
        @media (hover: none), (max-width: 600px) {
          .shuffly-restore-slot { opacity: 1; }
        }
        .shuffly-activity-filters {
          display: inline-flex;
          flex-wrap: wrap;
          padding: 3px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 999px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-activity-filter-btn {
          border: none;
          outline: none;
          box-shadow: none;
          border-radius: 999px;
          padding: 7px 14px;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          color: var(--p-color-text-secondary, #6b6b6b);
          background: transparent;
          cursor: pointer;
          transition: background-color 120ms ease, color 120ms ease;
        }
        .shuffly-activity-filter-btn--active {
          background: var(--p-color-bg-fill-inverse, #131110);
          color: #ffffff;
        }
        .shuffly-activity-filter-btn:not(.shuffly-activity-filter-btn--active):hover {
          background: var(--p-color-bg-surface-secondary, #f1f1f1);
        }
        .shuffly-activity-filter-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
      `}</style>
    </s-page>
  );
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function EmptyActivityState() {
  return (
    <s-box padding="large-500">
      <s-stack direction="block" gap="small" alignItems="center">
        <s-icon type="automation" color="subdued" />
        <s-heading>Nothing yet</s-heading>
        <s-text color="subdued">Shuffle a collection and it will show up here.</s-text>
        <div style={{ marginTop: 4 }}>
          <Link to="/app/collections">
            <s-button variant="primary">Go to Collections</s-button>
          </Link>
        </div>
      </s-stack>
    </s-box>
  );
}

function ActivitySkeletonRow() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px" }}>
      <div
        style={{
          width: 24,
          height: 24,
          flex: "none",
          borderRadius: "50%",
          background: "var(--p-color-bg-surface-tertiary, #e3e3e3)",
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ width: 240, height: 12, borderRadius: 4, background: "var(--p-color-bg-surface-tertiary, #e3e3e3)" }} />
        <div style={{ width: 160, height: 10, borderRadius: 4, background: "var(--p-color-bg-surface-tertiary, #e3e3e3)" }} />
      </div>
      <div style={{ width: 50, height: 10, borderRadius: 4, background: "var(--p-color-bg-surface-tertiary, #e3e3e3)" }} />
    </div>
  );
}

function ActivitySkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <ActivitySkeletonRow />
          {i < count - 1 && <s-divider />}
        </div>
      ))}
    </>
  );
}
