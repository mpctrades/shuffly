// Turns raw ShuffleRun rows into the entries the Activity screen renders.
//
// A single merchant action can produce several ShuffleRun rows (one per
// collection in a cron sweep or a "Shuffle all now", one per product for a
// burst of sold-out reactions) — this file's job is to re-group those rows
// back into the single human sentence a merchant should read, e.g. "Morning
// run — 6 collections, 891 products moved" instead of six separate lines.
// Bursts of same-batch (or same-minute) rows are collapsed into one summary
// row with the individual rows attached as `children`, for the feed's
// expand/collapse UI. Every day's pause/resume/setting-change rows are
// additionally collapsed into one muted line per day, for the same reason.
import db from "../db.server";
import { activityDayAndTime, getLocalHour, startOfLocalDay } from "./schedule.server";

export const ACTIVITY_PAGE_SIZE = 30;
const CLUSTER_WINDOW_MS = 60_000; // "within the same 60 seconds"

export type ActivityIconType = "check-circle-filled" | "bolt-filled" | "alert-triangle" | "alert-circle";
export type ActivityIconTone = "success" | "info" | "warning" | "critical";

/** The five event kinds the Activity screen distinguishes — drives dot
 * color, and is what the filter tabs actually filter on (client-side, over
 * an already-loaded page — see app.activity.tsx). */
export type ActivityKind = "run" | "automatic" | "attention" | "failure" | "setting";

export type ActivityRestore =
  | { kind: "single"; runId: string; collectionTitle: string }
  | { kind: "choice"; options: Array<{ runId: string; collectionTitle: string; movedCount: number }> }
  | null;

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  iconType: ActivityIconType;
  iconTone: ActivityIconTone;
  title: string;
  /** "" for a clean successful run — nothing worth saying beyond the title.
   * Duration (+ trigger, for automatic events) on success; the failure
   * reason on failure. */
  meta: string;
  /** Rendered as a small orange pill right after the title — "6 moved".
   * Only set on run-kind entries that actually moved something. */
  movedCount: number | null;
  time: string; // "06:01" — day is shown once, in the group heading above
  dayKey: string; // "2026-08-20", for grouping consecutive rows by day
  dayLabel: string; // "Today" | "Yesterday" | "20 August"
  createdAt: string; // ISO — only used as the "Load older" cursor
  restore: ActivityRestore;
  /** "See what changed" — an EXTERNAL_REORDER_DETECTED entry's before/after
   * diff (what the merchant's own drag looked like vs. what pins got put
   * back). Null everywhere else. */
  diff: { before: string[]; after: string[] } | null;
  /** Set only on a collapsed burst row (several same-batch/same-minute runs)
   * or a collapsed day's settings-change summary — the individual rows
   * underneath, shown when the summary row's "Show" toggle is expanded.
   * Null for every other kind of row. */
  children: ActivityItem[] | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ActivitySummary {
  runsToday: number;
  productsMovedToday: number;
  lastRunAtToday: string | null; // "04:44" — the most recent run today, any collection
}

export interface ActivityStatRow {
  nextRunAtMs: number | null;
  runningCount: number;
  last7DaysMoved: number;
  last7DaysRuns: number;
  last7DaysAnyFailed: boolean;
}

/** Every item's `kind` is what the filter tabs actually filter on. "All"
 * shows everything; "Runs" shows kind==="run"; "Automatic" shows
 * kind==="automatic"; "Needs attention" shows attention OR failure —
 * matching the old server-side ATTENTION_TRIGGERS+FAILED combo, just
 * computed client-side now over an already-loaded page instead of
 * re-querying per tab click. */
export type ActivityFilter = "all" | "runs" | "automatic" | "attention";

export interface ActivityQuery {
  collectionId: string | null; // CollectionConfig.id
  showEmpty: boolean; // include standalone runs that moved 0 products
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma's where-clause type for this model isn't worth re-declaring here
function buildWhere(shop: string, query: ActivityQuery, cursor: Date | null): any {
  const where: Record<string, unknown> = { shop };
  if (cursor) where.createdAt = { lt: cursor };
  if (query.collectionId) where.collectionId = query.collectionId;

  if (!query.showEmpty) {
    // Hide standalone (not part of a batch) successful runs that moved
    // nothing — "Gift Card shuffled — 0 products moved" repeating forever
    // is noise, not information. Batched rows are left alone: the batch is
    // always shown as one collapsed summary regardless of individual
    // members' counts, so there's no equivalent noise to hide there.
    where.NOT = { batchId: null, trigger: { in: ["SCHEDULED", "MANUAL"] }, status: "OK", movedCount: 0 };
  }

  return where;
}

async function fetchRows(shop: string, query: ActivityQuery, cursor: Date | null, take: number) {
  return db.shuffleRun.findMany({
    where: buildWhere(shop, query, cursor),
    orderBy: { createdAt: "desc" },
    take,
    include: { collection: { select: { id: true, title: true } } },
  });
}

type RunRow = Awaited<ReturnType<typeof fetchRows>>[number];

export async function loadActivityPage(
  shop: string,
  timezone: string,
  cursorIso: string | null,
  query: ActivityQuery,
): Promise<ActivityPage> {
  const cursor = cursorIso ? new Date(cursorIso) : null;
  const rows = await fetchRows(shop, query, cursor, ACTIVITY_PAGE_SIZE);
  const now = new Date();
  const last = rows[rows.length - 1];
  return {
    items: collapseSettingsPerDay(groupRows(rows, timezone, now)),
    nextCursor: last ? last.createdAt.toISOString() : null,
    hasMore: rows.length === ACTIVITY_PAGE_SIZE,
  };
}

/** The subtitle/stat-row's live summary — shop-wide, filter-independent
 * counts of today's actual shuffle activity (not status events like
 * pause/resume, and not the dead-code RETRIED). */
export async function loadActivitySummary(shop: string, timezone: string, now: Date): Promise<ActivitySummary> {
  const since = startOfLocalDay(now, timezone);
  const RUN_KINDS = ["SCHEDULED", "MANUAL", "SOLD_OUT_REACTION", "RESTOCK_REACTION"];
  const [runsToday, moved, lastRun] = await Promise.all([
    db.shuffleRun.count({ where: { shop, createdAt: { gte: since }, trigger: { in: RUN_KINDS } } }),
    db.shuffleRun.aggregate({ where: { shop, createdAt: { gte: since }, status: "OK" }, _sum: { movedCount: true } }),
    db.shuffleRun.findFirst({
      where: { shop, createdAt: { gte: since }, trigger: { in: RUN_KINDS } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return {
    runsToday,
    productsMovedToday: moved._sum.movedCount ?? 0,
    lastRunAtToday: lastRun ? activityDayAndTime(lastRun.createdAt, timezone, now).time : null,
  };
}

/** Stat row's "Next run" (across every tracked collection, not just the
 * loaded activity page) and "Last 7 days" figures. */
export async function loadActivityStatRow(shop: string, now: Date): Promise<ActivityStatRow> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [running, last7] = await Promise.all([
    db.collectionConfig.findMany({ where: { shop, status: "RUNNING" }, select: { nextRunAt: true } }),
    db.shuffleRun.findMany({
      where: { shop, createdAt: { gte: sevenDaysAgo }, trigger: { in: ["SCHEDULED", "MANUAL", "SOLD_OUT_REACTION", "RESTOCK_REACTION"] } },
      select: { status: true, movedCount: true },
    }),
  ]);
  const nextRunMs = running
    .map((c) => c.nextRunAt?.getTime())
    .filter((ms): ms is number => ms != null)
    .sort((a, b) => a - b)[0];
  return {
    nextRunAtMs: nextRunMs ?? null,
    runningCount: running.length,
    last7DaysMoved: last7.reduce((sum, r) => (r.status === "OK" ? sum + r.movedCount : sum), 0),
    last7DaysRuns: last7.length,
    last7DaysAnyFailed: last7.some((r) => r.status === "FAILED"),
  };
}

/** Options for the filter bar's collection Select. */
export async function loadActivityCollectionOptions(shop: string): Promise<Array<{ id: string; title: string }>> {
  return db.collectionConfig.findMany({
    where: { shop },
    select: { id: true, title: true },
    orderBy: { title: "asc" },
  });
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatSeconds(ms: number): string {
  return pluralize(Math.max(1, Math.round(ms / 1000)), "second");
}

function timeOfDayLabel(hour: number): string {
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 21) return "Evening";
  return "Night";
}

/** Walk the page of rows (already newest-first) and fold adjacent rows that
 * belong to the same real-world event into one entry. */
function groupRows(rows: RunRow[], timezone: string, now: Date): ActivityItem[] {
  const items: ActivityItem[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];

    if (row.batchId) {
      const batchId = row.batchId;
      let j = i + 1;
      while (j < rows.length && rows[j].batchId === batchId) j++;
      items.push(formatBatch(rows.slice(i, j), timezone, now));
      i = j;
      continue;
    }

    if (row.trigger === "SOLD_OUT_REACTION" || row.trigger === "RESTOCK_REACTION") {
      const trigger = row.trigger;
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j].trigger === trigger &&
        !rows[j].batchId &&
        Math.abs(rows[j - 1].createdAt.getTime() - rows[j].createdAt.getTime()) <= CLUSTER_WINDOW_MS
      ) {
        j++;
      }
      items.push(formatReactionCluster(rows.slice(i, j), trigger, timezone, now));
      i = j;
      continue;
    }

    // Runs of DIFFERENT collections that happened within the same 60
    // seconds, but never got a shared batchId (e.g. two separate "Shuffle
    // now" clicks a moment apart) — cluster them the same way a real batch
    // would render, so the feed doesn't show them as unrelated events.
    if ((row.trigger === "SCHEDULED" || row.trigger === "MANUAL") && !row.batchId) {
      let j = i + 1;
      const seenCollections = new Set([row.collectionId]);
      while (
        j < rows.length &&
        (rows[j].trigger === "SCHEDULED" || rows[j].trigger === "MANUAL") &&
        !rows[j].batchId &&
        Math.abs(rows[j - 1].createdAt.getTime() - rows[j].createdAt.getTime()) <= CLUSTER_WINDOW_MS
      ) {
        seenCollections.add(rows[j].collectionId);
        j++;
      }
      if (seenCollections.size > 1) {
        items.push(formatBatch(rows.slice(i, j), timezone, now));
        i = j;
        continue;
      }
    }

    items.push(formatSolo(row, timezone, now));
    i += 1;
  }
  return items;
}

/** After grouping, replace each day's individual PAUSED/RESUMED entries
 * with one muted "N settings changes" line for that day, the originals
 * attached as `children` behind a "Show" toggle. Runs, reactions and
 * attention entries in that same day are left exactly where they are. */
function collapseSettingsPerDay(items: ActivityItem[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  let cursor = 0;
  while (cursor < items.length) {
    const dayKey = items[cursor].dayKey;
    const dayItems: ActivityItem[] = [];
    let end = cursor;
    while (end < items.length && items[end].dayKey === dayKey) {
      dayItems.push(items[end]);
      end++;
    }

    const settings = dayItems.filter((it) => it.kind === "setting");
    const rest = dayItems.filter((it) => it.kind !== "setting");
    out.push(...rest);

    if (settings.length > 0) {
      // Re-insert the summary at the position of the day's first (newest)
      // settings entry, so it doesn't always land at the very bottom of a
      // busy day.
      const collections = Array.from(new Set(settings.map((s) => s.title.replace(/ (paused|resumed)$/, ""))));
      const collectionsLabel =
        collections.length <= 2 ? collections.join(" and ") : `${collections[0]} and ${collections.length - 1} others`;
      const actionsLabel = describeSettingsActions(settings);
      const first = settings[0];
      const lastEl = settings[settings.length - 1];
      out.push({
        id: `settings:${dayKey}`,
        kind: "setting",
        iconType: "check-circle-filled",
        iconTone: "success",
        title: pluralize(settings.length, "settings change"),
        meta: `${lastEl.time} – ${first.time} · ${collectionsLabel} ${actionsLabel}`,
        movedCount: null,
        time: first.time,
        dayKey,
        dayLabel: first.dayLabel,
        createdAt: first.createdAt,
        restore: null,
        diff: null,
        children: settings,
      });
    }
    cursor = end;
  }
  // Settings summaries were appended after `rest` within each day, not
  // necessarily newest-first overall — re-sort each day's slice by time
  // isn't needed since day boundaries already group them; just keep the
  // natural push order (rest newest→oldest, then that day's summary).
  return out;
}

function describeSettingsActions(settings: ActivityItem[]): string {
  const paused = settings.some((s) => s.title.endsWith("paused"));
  const resumed = settings.some((s) => s.title.endsWith("resumed"));
  if (paused && resumed) return "paused and resumed";
  if (paused) return "paused";
  return "resumed";
}

function formatBatch(rows: RunRow[], timezone: string, now: Date): ActivityItem {
  const head = rows[0];
  const collectionIds = new Set(rows.map((r) => r.collectionId));

  // A "batch" of one collection is just a regular shuffle — describe it the
  // same way a solo run would be.
  if (collectionIds.size === 1) return formatSolo(head, timezone, now, rows);

  const totalMoved = rows.reduce((sum, r) => (r.status === "OK" ? sum + r.movedCount : sum), 0);
  const failed = rows.filter((r) => r.status === "FAILED");
  const totalDurationMs = rows.reduce((sum, r) => sum + r.durationMs, 0);
  const label = timeOfDayLabel(getLocalHour(head.createdAt, timezone));

  const meta =
    failed.length === 0
      ? `${pluralize(collectionIds.size, "collection")} · ${formatSeconds(totalDurationMs)}`
      : `${pluralize(collectionIds.size, "collection")} · ${formatSeconds(totalDurationMs)} · ${pluralize(failed.length, "collection")} failed`;

  const restoreOptions = rows
    .filter((r) => r.status === "OK" && r.previousOrder && r.movedCount > 0)
    .map((r) => ({ runId: r.id, collectionTitle: r.collection.title, movedCount: r.movedCount }));

  const { dayKey, dayLabel, time } = activityDayAndTime(head.createdAt, timezone, now);

  return {
    id: `batch:${head.batchId ?? head.id}`,
    kind: failed.length > 0 ? "failure" : "run",
    iconType: failed.length === 0 ? "check-circle-filled" : failed.length === rows.length ? "alert-circle" : "alert-triangle",
    iconTone: failed.length === 0 ? "success" : failed.length === rows.length ? "critical" : "warning",
    title: `${label} run`,
    meta,
    movedCount: totalMoved > 0 ? totalMoved : null,
    time,
    dayKey,
    dayLabel,
    createdAt: head.createdAt.toISOString(),
    restore:
      restoreOptions.length === 0
        ? null
        : restoreOptions.length === 1
          ? { kind: "single", runId: restoreOptions[0].runId, collectionTitle: restoreOptions[0].collectionTitle }
          : { kind: "choice", options: restoreOptions },
    diff: null,
    // One row per collection in the batch, each formatted exactly like a
    // solo run — shown when the summary row's "Show" toggle is expanded.
    // Only worth offering when there's more than one to reveal.
    children: rows.length > 1 ? rows.map((r) => formatSolo(r, timezone, now, undefined, true)) : null,
  };
}

function formatReactionCluster(rows: RunRow[], trigger: string, timezone: string, now: Date): ActivityItem {
  const head = rows[0];
  const totalMoved = rows.reduce((sum, r) => (r.status === "OK" ? sum + r.movedCount : sum), 0);
  const collections = Array.from(new Set(rows.map((r) => r.collection.title))).join(", ");
  const isSoldOut = trigger === "SOLD_OUT_REACTION";
  const { dayKey, dayLabel, time } = activityDayAndTime(head.createdAt, timezone, now);
  const afterMs = rows.length === 1 ? head.durationMs : null;

  return {
    id: `reaction:${head.id}`,
    kind: "automatic",
    iconType: "bolt-filled",
    iconTone: "info",
    title: isSoldOut
      ? `${pluralize(totalMoved, "product")} sold out — moved to the end`
      : `${pluralize(totalMoved, "product")} restocked — back in rotation`,
    meta: `${collections} · ${isSoldOut ? "after a stock change" : "after restocking"}${afterMs != null ? ` · ${formatSeconds(afterMs)} later` : ""}`,
    movedCount: null,
    time,
    dayKey,
    dayLabel,
    createdAt: head.createdAt.toISOString(),
    restore: null,
    diff: null,
    children: null,
  };
}

/** A single unrelated row — or, when `batchSiblings` is given, a "batch" of
 * exactly one collection (reported the same as any other solo shuffle). Set
 * `asChild` when this is one row inside an expanded multi-collection batch
 * — those render as a compact "Sale — 7 products moved" line instead of
 * the standalone "Sale shuffled" title + pill, since the parent row above
 * already carries the pill/rail/restore-link treatment. */
function formatSolo(row: RunRow, timezone: string, now: Date, batchSiblings?: RunRow[], asChild = false): ActivityItem {
  const collectionTitle = row.collection.title;
  const { dayKey, dayLabel, time } = activityDayAndTime(row.createdAt, timezone, now);
  const base = {
    id: row.id,
    time,
    dayKey,
    dayLabel,
    createdAt: row.createdAt.toISOString(),
    diff: null as null,
    children: null as null,
  };

  switch (row.trigger) {
    case "SCHEDULED":
    case "MANUAL": {
      if (row.status === "FAILED") {
        return {
          ...base,
          kind: "failure",
          iconType: "alert-circle",
          iconTone: "critical",
          title: `${collectionTitle} couldn't be shuffled`,
          meta: row.message ?? "Something went wrong on this run.",
          movedCount: null,
          restore: null,
        };
      }
      const movedCount = batchSiblings ? batchSiblings.reduce((sum, r) => sum + r.movedCount, 0) : row.movedCount;
      const durationMs = batchSiblings ? batchSiblings.reduce((sum, r) => sum + r.durationMs, 0) : row.durationMs;
      // A clean success says nothing more than how long it took — no more
      // "nothing failed" on every single row. Scheduled runs additionally
      // name the trigger, since "why did this happen" matters more for an
      // automatic event than a button the merchant just clicked themself.
      const meta = row.trigger === "SCHEDULED" ? `${formatSeconds(durationMs)} · on schedule` : formatSeconds(durationMs);
      return {
        ...base,
        kind: "run",
        iconType: "check-circle-filled",
        iconTone: "success",
        title: asChild ? `${collectionTitle} — ${pluralize(movedCount, "product")} moved` : `${collectionTitle} shuffled`,
        meta: asChild ? "" : meta,
        movedCount: asChild ? null : movedCount > 0 ? movedCount : null,
        // Nothing to restore when nothing moved — and never on a child row,
        // which only ever appears already-expanded under a parent whose own
        // restore already covers every collection in the batch (or offers
        // a choice between them).
        restore: !asChild && row.previousOrder && movedCount > 0 ? { kind: "single", runId: row.id, collectionTitle } : null,
      };
    }
    case "EXTERNAL_REORDER_DETECTED": {
      // `previousOrder` on this trigger type holds a {before, after}
      // pinned-zone snapshot, not the full-order array SCHEDULED/MANUAL
      // rows use it for (see shuffle-engine.server.ts) — this trigger
      // never offers Restore, so there's no shape ambiguity.
      let diff: { before: string[]; after: string[] } | null = null;
      if (row.previousOrder) {
        try {
          const parsed = JSON.parse(row.previousOrder);
          if (parsed && Array.isArray(parsed.before) && Array.isArray(parsed.after)) diff = parsed;
        } catch {
          diff = null;
        }
      }
      return {
        ...base,
        kind: "attention",
        iconType: "alert-triangle",
        iconTone: "warning",
        title: `Someone re-ordered ${collectionTitle} by hand`,
        meta: row.message ?? "Your pins were put back at the next run.",
        movedCount: null,
        restore: null,
        diff,
      };
    }
    case "PAUSED":
      return {
        ...base,
        kind: "setting",
        iconType: "check-circle-filled",
        iconTone: "success",
        title: `${collectionTitle} paused`,
        meta: "Won't shuffle again until it's resumed.",
        movedCount: null,
        restore: null,
      };
    case "RESUMED":
      return {
        ...base,
        kind: "setting",
        iconType: "check-circle-filled",
        iconTone: "success",
        title: `${collectionTitle} resumed`,
        meta: "Shuffling again on its usual schedule.",
        movedCount: null,
        restore: null,
      };
    case "RETRIED":
      return {
        ...base,
        kind: "failure",
        iconType: "alert-triangle",
        iconTone: "warning",
        title: `${collectionTitle} run retried`,
        meta: row.message ?? "Routine — the first attempt was skipped, not failed.",
        movedCount: null,
        restore: null,
      };
    default:
      return {
        ...base,
        kind: row.status === "OK" ? "run" : "failure",
        iconType: row.status === "OK" ? "check-circle-filled" : "alert-circle",
        iconTone: row.status === "OK" ? "success" : "critical",
        title: row.message ?? `${collectionTitle} — ${row.trigger}`,
        meta: row.status === "OK" ? "" : "Failed",
        movedCount: row.status === "OK" && row.movedCount > 0 ? row.movedCount : null,
        restore:
          row.status === "OK" && row.previousOrder && row.movedCount > 0
            ? { kind: "single", runId: row.id, collectionTitle }
            : null,
      };
  }
}
