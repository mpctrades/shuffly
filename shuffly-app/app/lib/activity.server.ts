// Turns raw ShuffleRun rows into the entries the Activity screen renders.
//
// A single merchant action can produce several ShuffleRun rows (one per
// collection in a cron sweep or a "Shuffle all now", one per product for a
// burst of sold-out reactions) — this file's job is to re-group those rows
// back into the single human sentence a merchant should read, e.g. "Morning
// run — 6 collections, 891 products moved" instead of six separate lines.
// Bursts of same-batch rows are collapsed into one summary row with the
// individual rows attached as `children`, for the feed's expand/collapse UI.
import db from "../db.server";
import { activityDayAndTime, getLocalHour, startOfLocalDay } from "./schedule.server";

export const ACTIVITY_PAGE_SIZE = 25;
const REACTION_CLUSTER_WINDOW_MS = 60_000; // "within a minute of selling out"

export type ActivityIconType = "check-circle-filled" | "bolt-filled" | "alert-triangle" | "alert-circle";
export type ActivityIconTone = "success" | "info" | "warning" | "critical";

export type ActivityRestore =
  | { kind: "single"; runId: string; collectionTitle: string }
  | { kind: "choice"; options: Array<{ runId: string; collectionTitle: string; movedCount: number }> }
  | null;

export interface ActivityItem {
  id: string;
  iconType: ActivityIconType;
  iconTone: ActivityIconTone;
  title: string;
  /** "" for a clean successful run — nothing worth saying beyond the title.
   * Duration (+ trigger, for automatic events) on success; the failure
   * reason on failure (the row shows a critical Badge alongside it). */
  meta: string;
  time: string; // "06:01" — day is shown once, in the group heading above
  dayKey: string; // "2026-08-20", for grouping consecutive rows by day
  dayLabel: string; // "Today" | "Yesterday" | "20 August"
  createdAt: string; // ISO — only used as the "Load older" cursor
  restore: ActivityRestore;
  /** Set only on a collapsed burst row (several same-batch runs within the
   * same sweep) — the individual rows underneath, shown indented when the
   * summary row is expanded. Null for every other kind of row. */
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
}

export type ActivityFilter = "all" | "runs" | "automatic" | "attention";

export interface ActivityQuery {
  filter: ActivityFilter;
  collectionId: string | null; // CollectionConfig.id
  showEmpty: boolean; // include standalone runs that moved 0 products
}

const RUN_TRIGGERS = ["SCHEDULED", "MANUAL"];
const AUTOMATIC_TRIGGERS = ["SCHEDULED", "SOLD_OUT_REACTION", "RESTOCK_REACTION"];
const ATTENTION_TRIGGERS = ["RETRIED", "EXTERNAL_REORDER_DETECTED"]; // retries + manual-edit detections

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma's where-clause type for this model isn't worth re-declaring here
function buildWhere(shop: string, query: ActivityQuery, cursor: Date | null): any {
  const where: Record<string, unknown> = { shop };
  if (cursor) where.createdAt = { lt: cursor };
  if (query.collectionId) where.collectionId = query.collectionId;

  if (query.filter === "runs") {
    where.trigger = { in: RUN_TRIGGERS };
  } else if (query.filter === "automatic") {
    where.trigger = { in: AUTOMATIC_TRIGGERS };
  } else if (query.filter === "attention") {
    where.OR = [{ status: "FAILED" }, { trigger: { in: ATTENTION_TRIGGERS } }];
  }

  if (!query.showEmpty) {
    // Hide standalone (not part of a batch) successful runs that moved
    // nothing — "Gift Card shuffled — 0 products moved" repeating forever
    // is noise, not information. Batched rows are left alone: the batch is
    // always shown as one collapsed summary regardless of individual
    // members' counts, so there's no equivalent noise to hide there.
    where.NOT = { batchId: null, trigger: { in: RUN_TRIGGERS }, status: "OK", movedCount: 0 };
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
    items: groupRows(rows, timezone, now),
    nextCursor: last ? last.createdAt.toISOString() : null,
    hasMore: rows.length === ACTIVITY_PAGE_SIZE,
  };
}

/** The subtitle's live summary — "12 runs today · 170 products moved" — a
 * shop-wide, filter-independent count of today's actual shuffle activity
 * (not status events like pause/resume, and not the dead-code RETRIED). */
export async function loadActivitySummary(shop: string, timezone: string, now: Date): Promise<ActivitySummary> {
  const since = startOfLocalDay(now, timezone);
  const [runsToday, moved] = await Promise.all([
    db.shuffleRun.count({
      where: { shop, createdAt: { gte: since }, trigger: { in: AUTOMATIC_TRIGGERS.concat("MANUAL") } },
    }),
    db.shuffleRun.aggregate({
      where: { shop, createdAt: { gte: since }, status: "OK" },
      _sum: { movedCount: true },
    }),
  ]);
  return { runsToday, productsMovedToday: moved._sum.movedCount ?? 0 };
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
        Math.abs(rows[j - 1].createdAt.getTime() - rows[j].createdAt.getTime()) <= REACTION_CLUSTER_WINDOW_MS
      ) {
        j++;
      }
      items.push(formatReactionCluster(rows.slice(i, j), trigger, timezone, now));
      i = j;
      continue;
    }

    items.push(formatSolo(row, timezone, now));
    i += 1;
  }
  return items;
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
      ? formatSeconds(totalDurationMs)
      : `${formatSeconds(totalDurationMs)} · ${pluralize(failed.length, "collection")} failed`;

  const restoreOptions = rows
    .filter((r) => r.status === "OK" && r.previousOrder && r.movedCount > 0)
    .map((r) => ({ runId: r.id, collectionTitle: r.collection.title, movedCount: r.movedCount }));

  const { dayKey, dayLabel, time } = activityDayAndTime(head.createdAt, timezone, now);

  return {
    id: `batch:${head.batchId}`,
    iconType: failed.length === 0 ? "check-circle-filled" : failed.length === rows.length ? "alert-circle" : "alert-triangle",
    iconTone: failed.length === 0 ? "success" : failed.length === rows.length ? "critical" : "warning",
    title: `${label} run — ${pluralize(collectionIds.size, "collection")}, ${pluralize(totalMoved, "product")} moved`,
    meta,
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
    // One row per collection in the batch, each formatted exactly like a
    // solo run — shown indented when the summary row is expanded. Only
    // worth offering when there's more than one to reveal.
    children: rows.length > 1 ? rows.map((r) => formatSolo(r, timezone, now)) : null,
  };
}

function formatReactionCluster(rows: RunRow[], trigger: string, timezone: string, now: Date): ActivityItem {
  const head = rows[0];
  const totalMoved = rows.reduce((sum, r) => (r.status === "OK" ? sum + r.movedCount : sum), 0);
  const collections = Array.from(new Set(rows.map((r) => r.collection.title))).join(", ");
  const isSoldOut = trigger === "SOLD_OUT_REACTION";
  const { dayKey, dayLabel, time } = activityDayAndTime(head.createdAt, timezone, now);

  return {
    id: `reaction:${head.id}`,
    iconType: "bolt-filled",
    iconTone: "info",
    title: isSoldOut
      ? `${pluralize(totalMoved, "product")} sold out — moved to the end`
      : `${pluralize(totalMoved, "product")} restocked — back in rotation`,
    meta: `${collections} · after ${isSoldOut ? "a stock change" : "restocking"}`,
    time,
    dayKey,
    dayLabel,
    createdAt: head.createdAt.toISOString(),
    restore: null,
    children: null,
  };
}

/** A single unrelated row — or, when `batchSiblings` is given, a "batch" of
 * exactly one collection (reported the same as any other solo shuffle). */
function formatSolo(row: RunRow, timezone: string, now: Date, batchSiblings?: RunRow[]): ActivityItem {
  const collectionTitle = row.collection.title;
  const { dayKey, dayLabel, time } = activityDayAndTime(row.createdAt, timezone, now);
  const base = { id: row.id, time, dayKey, dayLabel, createdAt: row.createdAt.toISOString(), children: null as null };

  switch (row.trigger) {
    case "SCHEDULED":
    case "MANUAL": {
      if (row.status === "FAILED") {
        return {
          ...base,
          iconType: "alert-circle",
          iconTone: "critical",
          title: `${collectionTitle} couldn't be shuffled`,
          meta: row.message ?? "Something went wrong on this run.",
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
        iconType: "check-circle-filled",
        iconTone: "success",
        title: `${collectionTitle} shuffled — ${pluralize(movedCount, "product")} moved`,
        meta,
        // Nothing to restore when nothing moved.
        restore: row.previousOrder && movedCount > 0 ? { kind: "single", runId: row.id, collectionTitle } : null,
      };
    }
    case "EXTERNAL_REORDER_DETECTED":
      return {
        ...base,
        iconType: "alert-triangle",
        iconTone: "warning",
        title: `Someone re-ordered ${collectionTitle} by hand`,
        meta: row.message ?? "Your pins were put back at the next run.",
        restore: null,
      };
    case "PAUSED":
      return {
        ...base,
        iconType: "check-circle-filled",
        iconTone: "success",
        title: `${collectionTitle} paused`,
        meta: "Won't shuffle again until it's resumed.",
        restore: null,
      };
    case "RESUMED":
      return {
        ...base,
        iconType: "check-circle-filled",
        iconTone: "success",
        title: `${collectionTitle} resumed`,
        meta: "Shuffling again on its usual schedule.",
        restore: null,
      };
    case "RETRIED":
      // Routine — not an error, so it gets the same calm styling as any
      // other "nothing to worry about" event, just an amber accent.
      return {
        ...base,
        iconType: "alert-triangle",
        iconTone: "warning",
        title: `${collectionTitle} run retried`,
        meta: row.message ?? "Routine — the first attempt was skipped, not failed.",
        restore: null,
      };
    default:
      return {
        ...base,
        iconType: row.status === "OK" ? "check-circle-filled" : "alert-circle",
        iconTone: row.status === "OK" ? "success" : "critical",
        title: row.message ?? `${collectionTitle} — ${row.trigger}`,
        meta: row.status === "OK" ? "" : "Failed",
        restore:
          row.status === "OK" && row.previousOrder && row.movedCount > 0
            ? { kind: "single", runId: row.id, collectionTitle }
            : null,
      };
  }
}
