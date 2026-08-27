import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { undoRun } from "../lib/shuffle-engine.server";
import {
  loadActivityPage,
  loadActivitySummary,
  loadActivityStatRow,
  loadActivityCollectionOptions,
  type ActivityItem,
  type ActivityRestore,
  type ActivityPage,
  type ActivityQuery,
} from "../lib/activity.server";
import { closeModal } from "../lib/polaris-modal";
import { ActivityRow, ActivityDayHeading } from "../components/ActivityRow";
import { RestoreActivityModal } from "../components/RestoreActivityModal";
import { ActivityDiffModal } from "../components/ActivityDiffModal";

type ActivityTab = "all" | "runs" | "automatic" | "attention";
const TABS: Array<{ value: ActivityTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "runs", label: "Runs" },
  { value: "automatic", label: "Automatic" },
  { value: "attention", label: "Needs attention" },
];

// Solid orange for today's group, fading through pale orange to grey for
// older ones — a few discrete stops rather than a true continuous
// gradient, since the rail is drawn per-row (see ActivityRow.tsx) across a
// variable number of variable-height entries.
const RAIL_STOPS = [
  "var(--p-color-bg-fill-warning, #FF4B1F)",
  "#FFB088",
  "#FFD9C2",
  "var(--p-color-border, #e3e3e3)",
];

function readQuery(url: URL): ActivityQuery {
  return {
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
  const now = new Date();

  try {
    const [page, summary, statRow, collectionOptions] = await Promise.all([
      loadActivityPage(shop, settings.timezone, cursor, query),
      loadActivitySummary(shop, settings.timezone, now),
      loadActivityStatRow(shop, now),
      loadActivityCollectionOptions(shop),
    ]);
    return { ...page, summary, statRow, collectionOptions, error: null as string | null };
  } catch {
    return {
      items: [],
      nextCursor: null,
      hasMore: false,
      summary: { runsToday: 0, productsMovedToday: 0, lastRunAtToday: null },
      statRow: { nextRunAtMs: null, runningCount: 0, last7DaysMoved: 0, last7DaysRuns: 0, last7DaysAnyFailed: false },
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

function matchesTab(item: ActivityItem, tab: ActivityTab): boolean {
  if (tab === "all") return true;
  if (tab === "runs") return item.kind === "run";
  if (tab === "automatic") return item.kind === "automatic";
  return item.kind === "attention" || item.kind === "failure"; // "Needs attention"
}

function kindCounts(items: ActivityItem[]): Record<ActivityTab, number> {
  return {
    all: items.length,
    runs: items.filter((it) => it.kind === "run").length,
    automatic: items.filter((it) => it.kind === "automatic").length,
    attention: items.filter((it) => it.kind === "attention" || it.kind === "failure").length,
  };
}

export default function Activity() {
  const initial = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const loadOlderFetcher = useFetcher<ActivityPage & { error: string | null }>();
  const restoreFetcher = useFetcher<{ ok: boolean; error?: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const restoreModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const diffModalRef = useRef<any>(null);

  const collectionId = searchParams.get("collectionId") ?? "";
  const showEmpty = searchParams.get("showEmpty") === "1";
  const [tab, setTab] = useState<ActivityTab>("all");
  const [q, setQ] = useState("");

  const [items, setItems] = useState<ActivityItem[]>(() => initial.items);
  const [cursor, setCursor] = useState(() => initial.nextCursor);
  const [hasMore, setHasMore] = useState(() => initial.hasMore);
  const [pendingRestore, setPendingRestore] = useState<ActivityRestore>(null);
  const [pendingDiff, setPendingDiff] = useState<{ before: string[]; after: string[] } | null>(null);
  const [justArrivedIds, setJustArrivedIds] = useState<Set<string>>(new Set());

  // A real query change (collection/show-empty) replaces the list from
  // scratch. Any other loader revalidation — a 5s real-time poll, or the
  // restore action settling — just prepends whatever's genuinely new
  // (by id) instead, so "Load older" progress and scroll position survive
  // it, and the new entries can flash a brief highlight.
  const queryKeyRef = useRef(`${collectionId}|${showEmpty}`);
  useEffect(() => {
    const key = `${collectionId}|${showEmpty}`;
    if (key !== queryKeyRef.current) {
      queryKeyRef.current = key;
      setItems(initial.items);
      setCursor(initial.nextCursor);
      setHasMore(initial.hasMore);
      setJustArrivedIds(new Set());
      return;
    }
    setItems((prev) => {
      const existingIds = new Set(prev.map((it) => it.id));
      const fresh = initial.items.filter((it) => !existingIds.has(it.id));
      if (fresh.length === 0) return prev;
      setJustArrivedIds(new Set(fresh.map((it) => it.id)));
      return [...fresh, ...prev];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on initial.items identity (changes on every revalidation), not its contents
  }, [initial.items, collectionId, showEmpty]);

  useEffect(() => {
    if (justArrivedIds.size === 0) return;
    const t = setTimeout(() => setJustArrivedIds(new Set()), 3000);
    return () => clearTimeout(t);
  }, [justArrivedIds]);

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

  // Real-time poll: only while something is actually in flight — the
  // restore fetcher submitting, or a RUNNING collection whose nextRunAt has
  // already passed (the in-process scheduler ticks once a minute, so
  // there's a real gap between "countdown hit zero" and the row actually
  // showing up). Stops the moment neither is true — a quiet page makes no
  // background requests at all. revalidator.revalidate() re-runs THIS
  // route's own loader (unlike a fetcher's .load(), which wouldn't update
  // useLoaderData() at all) — that's what feeds the merge-new-entries
  // effect above, keyed on initial.items.
  const restoreBusy = restoreFetcher.state !== "idle";
  const overdueRunning = initial.statRow.runningCount > 0 && initial.statRow.nextRunAtMs != null && initial.statRow.nextRunAtMs <= Date.now();
  const shouldPoll = restoreBusy || overdueRunning;
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(id);
  }, [shouldPoll, revalidator]);

  function loadOlder() {
    if (!cursor) return;
    const params = new URLSearchParams();
    params.set("cursor", cursor);
    if (collectionId) params.set("collectionId", collectionId);
    if (showEmpty) params.set("showEmpty", "1");
    loadOlderFetcher.load(`/app/activity?${params.toString()}`);
  }

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    next.delete("cursor");
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

  function openDiff(item: ActivityItem) {
    if (!item.diff) return;
    setPendingDiff(item.diff);
    diffModalRef.current?.showOverlay();
  }

  const filteredItems = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (!matchesTab(it, tab)) return false;
      if (!needle) return true;
      return it.title.toLowerCase().includes(needle) || it.meta.toLowerCase().includes(needle);
    });
  }, [items, tab, q]);

  const counts = useMemo(() => kindCounts(items), [items]);

  function exportCsv() {
    const rows = [
      ["When", "Event", "Details"],
      ...filteredItems.map((it) => [`${it.dayLabel} ${it.time}`, it.title, it.meta]),
    ];
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

  // Day index (0 = newest visible day) drives the rail colour fade — and
  // whether a given row is the last one drawn in its day group, so the
  // rail line doesn't run on past the last dot.
  let lastDayKey: string | null = null;
  let dayIndex = -1;

  return (
    <s-page heading="Activity">
      <s-button slot="secondary-actions" onClick={exportCsv} disabled={filteredItems.length === 0 || undefined}>
        Export
      </s-button>
      <s-button slot="secondary-actions" command="--toggle" commandFor="activity-overflow-menu" accessibilityLabel="More actions">
        ···
      </s-button>
      <s-menu id="activity-overflow-menu" accessibilityLabel="More actions">
        <s-switch
          label="Show runs that changed nothing"
          checked={showEmpty || undefined}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
          onChange={(e: any) => updateParam("showEmpty", e.currentTarget?.checked ? "1" : null)}
        />
        <s-button onClick={() => shopify.toast.show("Retention settings aren't available yet")}>
          Retention settings
        </s-button>
      </s-menu>

      <StatRow summary={initial.summary} statRow={initial.statRow} />

      {initial.error && <s-banner tone="critical">{initial.error}</s-banner>}

      <div className="shuffly-activity-card">
        <div className="shuffly-activity-topbar" aria-hidden="true" />

        <div className="shuffly-activity-filterbar">
          <div style={{ flex: "1 1 220px", minWidth: 180 }}>
            <s-search-field
              label="Search activity"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search activity"
              value={q}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
              onChange={(e: any) => setQ(e.currentTarget?.value ?? "")}
            />
          </div>
          <div className="shuffly-activity-tabs" role="group" aria-label="Filter activity">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`shuffly-activity-tab${tab === t.value ? " shuffly-activity-tab--active" : ""}`}
                onClick={() => setTab(t.value)}
              >
                {t.label} {counts[t.value]}
              </button>
            ))}
          </div>
          <div style={{ minWidth: 170 }}>
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
        </div>

        {isPageLoading ? (
          <ActivitySkeletonRows />
        ) : filteredItems.length === 0 ? (
          <EmptyActivityState hasAnyItems={items.length > 0} />
        ) : (
          <>
            <div className="shuffly-activity-timeline">
              {filteredItems.map((item, idx) => {
                const showHeading = item.dayKey !== lastDayKey;
                if (showHeading) {
                  lastDayKey = item.dayKey;
                  dayIndex++;
                }
                const isLastInGroup = idx === filteredItems.length - 1 || filteredItems[idx + 1].dayKey !== item.dayKey;
                const railColor = RAIL_STOPS[Math.min(dayIndex, RAIL_STOPS.length - 1)];
                return (
                  <div key={item.id}>
                    {showHeading && <ActivityDayHeading label={item.dayLabel} isToday={item.dayLabel === "Today"} />}
                    <ActivityRow
                      item={item}
                      onRestore={openRestore}
                      onShowDiff={openDiff}
                      busy={restoreFetcher.state !== "idle"}
                      railColor={railColor}
                      isLastInGroup={isLastInGroup}
                      justArrived={justArrivedIds.has(item.id)}
                    />
                  </div>
                );
              })}
            </div>
            {loadOlderFetcher.state !== "idle" && <ActivitySkeletonRows count={3} />}
            <div className="shuffly-activity-footer">
              <s-text color="subdued">Kept for 30 days</s-text>
              {hasMore ? (
                <s-button variant="tertiary" onClick={loadOlder} {...(loadOlderFetcher.state !== "idle" ? { loading: true } : {})}>
                  Load older
                </s-button>
              ) : (
                <s-text color="subdued">That&apos;s everything</s-text>
              )}
            </div>
          </>
        )}
      </div>

      <RestoreActivityModal
        ref={restoreModalRef}
        restore={pendingRestore}
        busy={restoreFetcher.state !== "idle"}
        onConfirm={confirmRestore}
        onCancel={() => closeModal(restoreModalRef.current)}
      />

      <ActivityDiffModal ref={diffModalRef} diff={pendingDiff} onClose={() => closeModal(diffModalRef.current)} />

      <style>{`
        .shuffly-activity-card {
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 12px;
          background: var(--p-color-bg-surface, #ffffff);
          overflow: hidden;
          margin-top: 20px;
        }
        .shuffly-activity-topbar {
          height: 3px;
          background: linear-gradient(90deg, var(--p-color-bg-fill-warning, #FF4B1F), #ffcbb0);
        }
        .shuffly-activity-filterbar {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          padding: 12px 16px;
          border-bottom: 1px solid var(--p-color-border, #e3e3e3);
        }
        .shuffly-activity-tabs {
          display: inline-flex;
          flex-wrap: wrap;
          padding: 3px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 999px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-activity-tab {
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
        /* Ink, not orange — matches the same active-tab treatment on
           Collections, and keeps orange from being the answer to every
           single "what color is this" question on the page. */
        .shuffly-activity-tab--active {
          background: var(--p-color-bg-fill-inverse, #131110);
          color: #ffffff;
        }
        .shuffly-activity-tab:not(.shuffly-activity-tab--active):hover {
          background: var(--p-color-bg-surface-secondary, #f1f1f1);
        }
        .shuffly-activity-tab:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
        .shuffly-activity-timeline { padding: 4px 16px 8px; }
        .shuffly-activity-day-heading {
          padding: 20px 4px 10px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--p-color-text-secondary, #6b6b6b);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        /* Just the pulsing dot stays orange as the "this is live" signal —
           the heading text itself stays the same ink as every other day
           heading, so "Today" doesn't turn into one more orange thing on
           the page. */
        .shuffly-activity-day-heading--today { color: var(--p-color-text, #131110); }
        .shuffly-activity-pulse-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--p-color-bg-fill-warning, #FF4B1F);
          animation: shuffly-pulse 1.8s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .shuffly-activity-pulse-dot { animation: none; }
        }
        @keyframes shuffly-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.4); }
        }
        .shuffly-activity-row {
          display: flex;
          gap: 12px;
          padding: 4px;
          border-radius: 8px;
          transition: background-color 150ms ease;
        }
        /* Very pale orange hover — one of this page's sanctioned orange
           spots. */
        .shuffly-activity-row:hover { background: var(--p-color-bg-fill-warning-secondary, #FFF6F0); }
        .shuffly-activity-row--new { animation: shuffly-row-flash 3s ease-out; }
        @keyframes shuffly-row-flash {
          0% { background: var(--p-color-bg-fill-warning-secondary, #FFF1E4); }
          100% { background: transparent; }
        }
        @media (prefers-reduced-motion: reduce) {
          .shuffly-activity-row--new { animation: none; background: var(--p-color-bg-fill-warning-secondary, #FFF1E4); }
        }
        .shuffly-activity-rail-col {
          flex: none;
          width: 20px;
          position: relative;
          display: flex;
          justify-content: center;
        }
        .shuffly-activity-rail-line {
          position: absolute;
          top: 14px;
          bottom: -4px;
          width: 2px;
        }
        .shuffly-activity-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          margin-top: 5px;
          flex: none;
          position: relative;
          z-index: 1;
        }
        .shuffly-activity-body { flex: 1 1 0%; min-width: 0; padding: 3px 0 14px; }
        .shuffly-activity-title { font-weight: 600; font-size: 14px; color: var(--p-color-text, #131110); }
        /* Green (success), not orange — this pill appears on nearly every
           run, so it was the single biggest source of "everything is
           orange" — and "N moved" is a positive outcome, which is exactly
           what the green token already means everywhere else in the app. */
        .shuffly-activity-pill {
          display: inline-flex;
          align-items: center;
          height: 20px;
          padding: 0 8px;
          border-radius: 999px;
          background: var(--p-color-bg-fill-success-secondary, #E3F5EE);
          color: var(--p-color-text-success, #008060);
          font-size: 11px;
          font-weight: 700;
        }
        .shuffly-activity-meta { margin-top: 3px; font-size: 12px; color: var(--p-color-text-secondary, #6b6b6b); }
        .shuffly-activity-time { color: var(--p-color-text-secondary, #6b6b6b); }
        .shuffly-activity-dotsep { color: var(--p-color-text-secondary, #6b6b6b); }
        /* Blue (the standard link color), not orange — action links repeat
           on almost every row too, so recoloring these plus the pill above
           covers most of what was reading as "too much orange", while the
           rail/dots/hero stat stay orange as the actual brand identity. */
        .shuffly-activity-link {
          border: none;
          outline: none;
          background: transparent;
          padding: 0;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          color: var(--p-color-text-link, #1F5199);
          cursor: pointer;
        }
        .shuffly-activity-link:hover { color: var(--p-color-text-link-hover, #1a4680); }
        .shuffly-activity-link:disabled { opacity: 0.6; cursor: default; }
        .shuffly-activity-link:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
          border-radius: 3px;
        }
        .shuffly-activity-children {
          margin-left: 20px;
          padding-left: 14px;
          border-left: 2px solid var(--p-color-bg-fill-warning-secondary, #FFE4D6);
        }
        .shuffly-activity-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
          border-top: 1px solid var(--p-color-border, #e3e3e3);
        }
      `}</style>
    </s-page>
  );
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// ---- stat row ----

function StatRow({
  summary,
  statRow,
}: {
  summary: { runsToday: number; productsMovedToday: number; lastRunAtToday: string | null };
  statRow: { nextRunAtMs: number | null; runningCount: number; last7DaysMoved: number; last7DaysRuns: number; last7DaysAnyFailed: boolean };
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!statRow.nextRunAtMs || statRow.runningCount === 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [statRow.nextRunAtMs, statRow.runningCount]);

  const countdown =
    statRow.runningCount === 0 || !statRow.nextRunAtMs ? "Only when you press Shuffle" : formatCountdown(statRow.nextRunAtMs - nowMs);

  const last7Tone: "success" | "critical" = statRow.last7DaysAnyFailed ? "critical" : "success";
  const last7Colors = STAT_TONE_COLORS[last7Tone];

  return (
    <div className="shuffly-activity-stats">
      <div className="shuffly-activity-stat shuffly-activity-stat--lead">
        <div className="shuffly-activity-stat-chip" style={{ background: STAT_TONE_COLORS.warning.tint }}>
          <ClockGlyph color={STAT_TONE_COLORS.warning.accent} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="shuffly-activity-stat-label">Next run</div>
          <div className="shuffly-activity-stat-value shuffly-activity-stat-value--orange">{countdown}</div>
          <div className="shuffly-activity-stat-detail">
            {statRow.nextRunAtMs ? formatClock(new Date(statRow.nextRunAtMs)) : "—"} · {statRow.runningCount} collection
            {statRow.runningCount === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      <div className="shuffly-activity-stat">
        <div className="shuffly-activity-stat-chip" style={{ background: STAT_TONE_COLORS.info.tint }}>
          <CalendarGlyph color={STAT_TONE_COLORS.info.accent} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="shuffly-activity-stat-label">Today</div>
          <div className="shuffly-activity-stat-value">
            {summary.runsToday} run{summary.runsToday === 1 ? "" : "s"} · {summary.productsMovedToday} moved
          </div>
          <div className="shuffly-activity-stat-detail">{summary.lastRunAtToday ? `last at ${summary.lastRunAtToday}` : "Nothing yet today"}</div>
        </div>
      </div>
      <div className="shuffly-activity-stat">
        <div className="shuffly-activity-stat-chip" style={{ background: last7Colors.tint }}>
          {last7Tone === "critical" ? <AlertGlyph color={last7Colors.accent} /> : <CheckGlyph color={last7Colors.accent} />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="shuffly-activity-stat-label">Last 7 days</div>
          <div className="shuffly-activity-stat-value" style={last7Tone === "critical" ? { color: last7Colors.accent } : undefined}>
            {statRow.last7DaysMoved} moved
          </div>
          <div className="shuffly-activity-stat-detail">
            {statRow.last7DaysRuns} run{statRow.last7DaysRuns === 1 ? "" : "s"} · {statRow.last7DaysAnyFailed ? "some failed" : "nothing failed"}
          </div>
        </div>
      </div>
      <style>{`
        .shuffly-activity-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-top: 20px;
        }
        .shuffly-activity-stat {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 12px;
          background: var(--p-color-bg-surface, #ffffff);
          box-shadow: var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.06));
          padding: 16px;
        }
        .shuffly-activity-stat--lead {
          background: linear-gradient(135deg, var(--p-color-bg-fill-warning-secondary, #FFF1E4), var(--p-color-bg-surface, #ffffff));
          border-left: 3px solid var(--p-color-border-warning, #FF4B1F);
        }
        .shuffly-activity-stat-chip {
          flex: none;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .shuffly-activity-stat-label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        .shuffly-activity-stat-value {
          font-size: 22px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          color: var(--p-color-text, #131110);
          margin-top: 4px;
        }
        .shuffly-activity-stat-value--orange { color: var(--p-color-text-warning, #FF4B1F); }
        .shuffly-activity-stat-detail { font-size: 12px; color: var(--p-color-text-secondary, #6b6b6b); margin-top: 2px; }
        @container shuffly-activity-stats (max-width: 640px) {
          .shuffly-activity-stats { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "any moment";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function formatClock(d: Date): string {
  return `today at ${new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)}`;
}

// Every value here is a Polaris token — the hex after each is a same-hue
// fallback only, never the source of truth.
const STAT_TONE_COLORS = {
  warning: { accent: "var(--p-color-icon-warning, #FF4B1F)", tint: "var(--p-color-bg-fill-warning-secondary, #FFF1E4)" },
  info: { accent: "var(--p-color-icon-info, #1F5199)", tint: "var(--p-color-bg-fill-info-secondary, #EAF2FF)" },
  success: { accent: "var(--p-color-icon-success, #008060)", tint: "var(--p-color-bg-fill-success-secondary, #E3F5EE)" },
  critical: { accent: "var(--p-color-icon-critical, #D82C0D)", tint: "var(--p-color-bg-fill-critical-secondary, #FEE9E8)" },
} as const;

function ClockGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke={color} strokeWidth="1.4" />
      <path d="M8 4.8V8L10.2 9.4" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendarGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.2" width="11" height="10.3" rx="1.5" stroke={color} strokeWidth="1.4" />
      <path d="M2.5 6.3H13.5" stroke={color} strokeWidth="1.4" />
      <path d="M5.3 2V4.4M10.7 2V4.4" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke={color} strokeWidth="1.4" />
      <path d="M5.3 8.2L7.2 10L10.7 6.2" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke={color} strokeWidth="1.4" />
      <path d="M8 5V8.6" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="10.8" r="0.9" fill={color} />
    </svg>
  );
}

function EmptyActivityState({ hasAnyItems }: { hasAnyItems: boolean }) {
  if (hasAnyItems) {
    return (
      <s-box padding="large-500">
        <s-stack direction="block" gap="small" alignItems="center">
          <s-text color="subdued">Nothing matches this filter.</s-text>
        </s-stack>
      </s-box>
    );
  }
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
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 4px" }}>
      <div style={{ width: 24, height: 24, flex: "none", borderRadius: "50%", background: "var(--p-color-bg-surface-tertiary, #e3e3e3)" }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ width: 240, height: 12, borderRadius: 4, background: "var(--p-color-bg-surface-tertiary, #e3e3e3)" }} />
        <div style={{ width: 160, height: 10, borderRadius: 4, background: "var(--p-color-bg-surface-tertiary, #e3e3e3)" }} />
      </div>
    </div>
  );
}

function ActivitySkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="shuffly-activity-timeline">
      {Array.from({ length: count }).map((_, i) => (
        <ActivitySkeletonRow key={i} />
      ))}
    </div>
  );
}
