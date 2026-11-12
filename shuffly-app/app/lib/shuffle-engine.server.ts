import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig, Prisma } from "@prisma/client";
import db from "../db.server";
import {
  diffToMoves,
  getCollectionProductsInOrder,
  packUndoOrder,
  unpackUndoOrder,
  reorderCollectionProducts,
  restoreCollectionSort,
  setCollectionManualSort,
  unpackProductIds,
} from "./collections.server";
import { bumpTurnCounts, computeShuffledOrder, serializeTurnCounts } from "./shuffle-algorithm.server";
import { buildShuffleInputs } from "./shuffle-inputs.server";
import { canUseNewArrivals } from "./plans";
import { nextRunFor } from "./schedule.server";
import { recordProductPositions, recordKnownProducts, invalidateInsightsCache } from "./insights.server";
import { undoRetentionCutoff } from "./plans";
import { isRateLimitError } from "./admin-graphql.server";
import { isNotManualSortError, resolveNoMoveReason } from "./run-reason";
import { resolveSchedule } from "./schedule-resolve";
import { withRunLock } from "./run-lock.server";
import { startTracking, syncSeenProducts } from "./product-seen.server";

export interface ShuffleRunSummary {
  ok: boolean;
  /** Not run at all: another run held this collection's lock. */
  skipped?: boolean;
  error?: string;
  movedCount: number;
  pinnedCount: number;
  soldOutCount: number;
  durationMs: number;
  message: string;
}

function parseNeverMoveTags(csv: string): Set<string> {
  return new Set(
    csv
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** If a merchant has dragged products around in Shopify admin since our
 * last write, the pinned zone we'd naively read off `currentOrder` might
 * not be "our" pinned products any more. Compare against what we last
 * wrote (`lastKnownOrder`) and, if the pinned ids drifted, pull the
 * original pinned products back to the front for this run — matching
 * "your pins were put back on the next run" — and report how much drifted
 * so the Activity feed can say so. */
function reconcileExternalReorder(
  currentOrder: string[],
  lastKnownOrder: string[] | null,
  pins: number,
): { order: string[]; externalChangeCount: number; diff: { before: string[]; after: string[] } | null } {
  if (!lastKnownOrder || pins <= 0) return { order: currentOrder, externalChangeCount: 0, diff: null };

  const expectedPinned = lastKnownOrder.slice(0, pins).filter((id) => currentOrder.includes(id));
  const actualPinned = currentOrder.slice(0, pins);
  const drifted = expectedPinned.length > 0 && JSON.stringify(expectedPinned) !== JSON.stringify(actualPinned);
  if (!drifted) return { order: currentOrder, externalChangeCount: 0, diff: null };

  const pinnedSet = new Set(expectedPinned);
  const rest = currentOrder.filter((id) => !pinnedSet.has(id));
  // How many of our old top-N no longer occupy their spot — a simple,
  // honest measure of "how much someone moved", not a fabricated number.
  const externalChangeCount = actualPinned.filter((id, i) => id !== expectedPinned[i]).length;
  // The Activity feed's "See what changed" diff — what the merchant's own
  // drag actually showed (before we corrected it) vs. the pinned order we
  // put back (after). Just the pinned zone, since that's the only part
  // this reconciliation touches.
  return { order: [...expectedPinned, ...rest], externalChangeCount, diff: { before: actualPinned, after: expectedPinned } };
}

/** Runs one shuffle for a single collection: fetch → compute → reorder →
 * record history → advance the schedule. Used by the "Shuffle now" button,
 * "Shuffle all now", and the scheduled cron sweep. `batchId` — when several
 * collections are shuffled together (one sweep, or one "Shuffle all now")
 * — lets the Activity feed show them as a single grouped entry. */
export async function runShuffleForCollection(
  admin: AdminApiContext,
  shop: string,
  config: CollectionConfig,
  timezone: string,
  neverMoveTagsCsv: string,
  trigger: ShuffleTrigger,
  batchId?: string,
  pageSize = 24,
  context: RunContext = {},
): Promise<ShuffleRunSummary> {
  const started = Date.now();
  // One run at a time per collection. Taken before anything is read, so a
  // run can never compute its moves from an order another run is halfway
  // through rewriting.
  const lock = await withRunLock(config.id, () =>
    runLocked(admin, shop, config, timezone, neverMoveTagsCsv, trigger, batchId, pageSize, started, context),
  );
  if (lock.locked) return lock.value;
  return recordBusy(shop, config, trigger, batchId);
}

/** Why this run happened, for its Activity row — e.g. the new-products
 * trigger's "Triggered by new products (12 added)". */
export interface RunContext {
  messageCode?: string;
  messageParams?: Record<string, unknown>;
  /** English fallback; replaces the default "Shuffled — N moved" lead-in. */
  message?: string;
}

export const SKIPPED_IN_PROGRESS_MESSAGE = "Skipped — previous run still in progress";

/** The collection was locked by another run. An automatic run (a scheduled
 * slot, the new-products trigger) skips that slot and says so in Activity;
 * a merchant pressing Shuffle now is told straight away instead, with no
 * Activity row for something that never started. */
async function recordBusy(
  shop: string,
  config: CollectionConfig,
  trigger: ShuffleTrigger,
  batchId: string | undefined,
): Promise<ShuffleRunSummary> {
  const automatic = trigger === "SCHEDULED" || trigger === "NEW_PRODUCTS";
  const message = automatic
    ? SKIPPED_IN_PROGRESS_MESSAGE
    : "A shuffle is already running on this collection. Try again in a minute.";
  if (automatic) {
    await db.shuffleRun.create({
      data: {
        shop,
        collectionId: config.id,
        trigger,
        batchId,
        status: "SKIPPED",
        messageCode: "SKIPPED_IN_PROGRESS",
        message,
      },
    });
  }
  return { ok: false, skipped: true, error: "IN_PROGRESS", movedCount: 0, pinnedCount: 0, soldOutCount: 0, durationMs: 0, message };
}

async function runLocked(
  admin: AdminApiContext,
  shop: string,
  config: CollectionConfig,
  timezone: string,
  neverMoveTagsCsv: string,
  trigger: ShuffleTrigger,
  batchId: string | undefined,
  pageSize: number,
  started: number,
  context: RunContext,
): Promise<ShuffleRunSummary> {
  try {
    return await shuffleCollection(admin, shop, config, timezone, neverMoveTagsCsv, trigger, batchId, pageSize, started, context);
  } catch (err) {
    // Anything that throws — Shopify still throttling after our retries, a
    // network failure, a bad response — used to escape with no Activity row
    // at all: the merchant saw nothing, and a scheduled slot was silently
    // consumed. Every attempt now leaves a FAILED run behind.
    const message = isRateLimitError(err)
      ? trigger === "SCHEDULED"
        ? "Shopify was too busy to finish this shuffle. It will run again at the next scheduled time."
        : "Shopify was too busy to finish this shuffle. Try again in a minute."
      : `Shuffle failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[shuffle] ${shop} ${config.collectionGid} failed:`, err);
    const durationMs = Date.now() - started;
    try {
      await db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger,
          batchId,
          status: "FAILED",
          movedCount: 0,
          pinnedCount: 0,
          soldOutCount: 0,
          durationMs,
          noMoveReason: "FAILED",
          message,
        },
      });
    } catch (logErr) {
      console.error("[shuffle] couldn't record the failed run:", logErr);
    }
    return { ok: false, error: message, movedCount: 0, pinnedCount: 0, soldOutCount: 0, durationMs, message };
  }
}

export type ShuffleTrigger = "SCHEDULED" | "MANUAL" | "NEW_PRODUCTS" | "SOLD_OUT_REACTION" | "RESTOCK_REACTION";

async function shuffleCollection(
  admin: AdminApiContext,
  shop: string,
  config: CollectionConfig,
  timezone: string,
  neverMoveTagsCsv: string,
  trigger: ShuffleTrigger,
  batchId: string | undefined,
  pageSize: number,
  started: number,
  context: RunContext,
): Promise<ShuffleRunSummary> {
  const { sortOrder, products } = await getCollectionProductsInOrder(admin, config.collectionGid);
  const runAt = new Date();

  // First-seen tracking for Features B and C: every normal run records the
  // products it hasn't seen in this collection before (brief: "every normal
  // run updates first_seen_at"). Started as a baseline the first time, so
  // products already there when the feature was turned on aren't "new".
  if (config.reshuffleOnNew || config.keepNewOnTop || config.newTrackingSince) {
    const seenInput = products.map((p) => ({ id: p.id, createdAt: p.createdAt }));
    if (!config.newTrackingSince) await startTracking(config.id, seenInput, runAt);
    else await syncSeenProducts(config.id, seenInput, runAt);
  }

  // Record what customers actually saw today, in this exact order — real
  // observed history for Insights, independent of whether we're able to
  // write a new order back below. Two tables, two jobs: recordProductPositions
  // is the range-queryable page-1 history every numeric metric is computed
  // from; recordKnownProducts is a cheap title cache covering the WHOLE
  // order (not just page 1), so "Still never seen" can name a product that
  // has genuinely never once made page 1.
  const snapshotProducts = products.map((p) => ({ id: p.id, title: p.title, isSoldOut: p.tracksInventory && p.totalInventory <= 0 }));
  await Promise.all([
    recordProductPositions(shop, config.id, snapshotProducts, timezone, pageSize),
    recordKnownProducts(shop, config.id, snapshotProducts, pageSize),
  ]);
  invalidateInsightsCache(shop);

  if (sortOrder !== "MANUAL") {
    // Reachable when a merchant changes the sort back in Shopify admin
    // after Shuffly switched it. The Collections list and the collection's
    // own page both offer a one-click switch, so point there rather than
    // sending them to Shopify admin.
    // Brief §8: re-checked before every run; when the merchant has changed
    // it back, the collection is PAUSED (the sweep and the new-products poll
    // skip it while sortOrderIssueAt is set) instead of failing again every
    // hour, and the card shows a warning with the one-click switch.
    const message = "Paused — sort order changed";
    // This used to return without writing anything, which is why a
    // sort-order failure left no trace at all — no Activity entry, no last
    // run, nothing on the row until the next hydration happened to notice.
    // Record it on both the run and the collection so the table can say so
    // straight away.
    await db.$transaction([
      db.collectionConfig.update({
        where: { id: config.id },
        data: { sortOrderIssueAt: new Date() },
      }),
      db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger,
          batchId,
          status: "FAILED",
          movedCount: 0,
          pinnedCount: 0,
          soldOutCount: 0,
          durationMs: Date.now() - started,
          noMoveReason: "NOT_MANUAL",
          messageCode: "PAUSED_SORT",
          messageParams: JSON.stringify({ sortOrder }),
          message,
        },
      }),
    ]);
    return {
      ok: false,
      error: "NOT_MANUAL",
      movedCount: 0,
      pinnedCount: 0,
      soldOutCount: 0,
      durationMs: Date.now() - started,
      message,
    };
  }

  const fetchedOrder = products.map((p) => p.id);
  const lastKnownOrder: string[] | null = config.lastKnownOrder ? JSON.parse(config.lastKnownOrder) : null;
  const { order: currentOrder, externalChangeCount, diff: externalReorderDiff } = reconcileExternalReorder(fetchedOrder, lastKnownOrder, config.pins);

  const neverMoveTags = parseNeverMoveTags(neverMoveTagsCsv);
  const shopPlan = (await db.shopSettings.findUnique({ where: { shop }, select: { plan: true } }))?.plan;
  const seen = config.keepNewOnTop ? await db.productSeen.findMany({ where: { collectionId: config.id } }) : [];
  // Same builder as the "Shuffle all" preview. Feature C applies only while
  // the shop is on Pro — checked here on the run, not trusted from the flag.
  const { productsById, turnCounts, options, excludedCount } = buildShuffleInputs({
    config,
    products,
    currentOrder,
    neverMoveTags,
    now: runAt.getTime(),
    seen,
    newArrivalsAllowed: canUseNewArrivals(shopPlan),
  });

  const result = computeShuffledOrder(currentOrder, productsById, turnCounts, options);

  const moves = diffToMoves(fetchedOrder, result.order);
  const reorderResult = await reorderCollectionProducts(admin, config.collectionGid, moves);

  const durationMs = Date.now() - started;

  if (!reorderResult.ok) {
    // Shopify can reject the reorder for the same reason the pre-flight
    // check above catches — the sort was changed between our read and our
    // write. Same code, same collection stamp, so the row reads the same
    // either way.
    const sortRejected = isNotManualSortError(reorderResult.error);
    await db.$transaction([
      ...(sortRejected
        ? [db.collectionConfig.update({ where: { id: config.id }, data: { sortOrderIssueAt: new Date() } })]
        : []),
      db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger,
          batchId,
          status: "FAILED",
          movedCount: 0,
          pinnedCount: result.pinnedCount,
          soldOutCount: result.soldOutCount,
          durationMs,
          noMoveReason: sortRejected ? "NOT_MANUAL" : "FAILED",
          message: reorderResult.error ?? "Unknown error",
        },
      }),
    ]);
    return {
      ok: false,
      error: reorderResult.error,
      movedCount: 0,
      pinnedCount: result.pinnedCount,
      soldOutCount: result.soldOutCount,
      durationMs,
      message: reorderResult.error ?? "Shuffle failed",
    };
  }

  // New arrivals on top this run are not taking a rotation turn.
  const nextTurnCounts = bumpTurnCounts(turnCounts, result.order, result.pinnedCount, 4, new Set(result.newArrivalIds));
  // Advisory only — the cron sweep re-derives what's due from the stored
  // schedule (see cron.server.ts). This keeps the countdown honest and the
  // sweep's candidate query index-backed.
  // The collection may be inheriting its schedule, so the shop default is
  // needed to know when it next runs. One indexed read, negligible beside the
  // Shopify round trips this function already makes — and reading it here
  // rather than threading it through eight call sites means it can never be
  // passed stale.
  const scheduleDefaults = (await db.shopSettings.findUnique({
    where: { shop },
    select: {
      defaultScheduleType: true,
      defaultScheduleTime: true,
      defaultScheduleTime2: true,
      defaultScheduleWeekday: true,
    },
  })) ?? { defaultScheduleType: "WEEKLY", defaultScheduleTime: "06:00", defaultScheduleTime2: null, defaultScheduleWeekday: 1 };
  const nextRunAt = nextRunFor(new Date(), timezone, resolveSchedule(config, scheduleDefaults));

  // A run that moved nothing is not self-explanatory — "0 moved" alone can't
  // tell a merchant whether we worked and had nothing to do or quietly
  // failed. Every zero-move run carries the reason from here on.
  const noMoveReason =
    moves.length === 0
      ? resolveNoMoveReason({
          productCount: products.length,
          soldOutCount: result.soldOutCount,
          shuffledCount: result.shuffledCount,
        })
      : null;

  const writes = [
    db.collectionConfig.update({
      where: { id: config.id },
      data: {
        turnCounts: serializeTurnCounts(nextTurnCounts),
        lastExcludedCount: excludedCount,
        lastRunAt: new Date(),
        lastSoldOutCount: result.soldOutCount,
        lastKnownOrder: JSON.stringify(result.order),
        nextRunAt,
        productCount: products.length,
        // This run reached Shopify, so whatever sort problem we last
        // recorded is over.
        sortOrderIssueAt: null,
        // One-time boost, consumed — it only ever leads a single run.
        priorityBoostIds: "[]",
        // Any new products waiting on the new-products trigger are in this
        // order now, so that batch is handled.
        newPendingSince: null,
        newPendingCount: 0,
      },
    }),
    db.shuffleRun.create({
      data: {
        shop,
        collectionId: config.id,
        trigger,
        batchId,
        status: "OK",
        movedCount: moves.length,
        pinnedCount: result.pinnedCount,
        soldOutCount: result.soldOutCount,
        durationMs,
        noMoveReason,
        message: context.message
          ? `${context.message} · ${moves.length} product${moves.length === 1 ? "" : "s"} moved`
          : `Shuffled — ${moves.length} product${moves.length === 1 ? "" : "s"} moved`,
        messageCode: context.messageCode,
        messageParams: context.messageParams ? JSON.stringify(context.messageParams) : undefined,
        // Compact (numeric ids, deflated): what Undo needs and nothing else.
        previousOrder: packUndoOrder(fetchedOrder),
      },
    }),
  ];

  if (externalChangeCount > 0) {
    writes.push(
      db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger: "EXTERNAL_REORDER_DETECTED",
          status: "OK",
          movedCount: externalChangeCount,
          // Just the "what changed for you" clause — the Activity feed builds
          // its own title ("Someone re-ordered X by hand") from the collection,
          // and shows this as the meta line underneath.
          message: `Your ${config.pins} pin${config.pins === 1 ? "" : "s"} were put back at the next run`,
          // Reusing `previousOrder` for this trigger type only — it's a
          // {before, after} pinned-zone snapshot for the Activity feed's
          // "See what changed" diff, not the full-collection order Undo
          // uses for SCHEDULED/MANUAL runs (this trigger never offers
          // Restore, so there's no ambiguity between the two shapes).
          previousOrder: externalReorderDiff ? JSON.stringify(externalReorderDiff) : null,
        },
      }),
    );
  }

  await db.$transaction(writes);

  return {
    ok: true,
    movedCount: moves.length,
    pinnedCount: result.pinnedCount,
    soldOutCount: result.soldOutCount,
    durationMs,
    message: `Shuffled — ${moves.length} product${moves.length === 1 ? "" : "s"} moved`,
  };
}

/** Restores the order captured just before the most recent run (or a
 * specific run, if `runId` is given), then pauses the collection so
 * tomorrow's schedule doesn't immediately shuffle it again. */
export async function undoRun(
  admin: AdminApiContext,
  shop: string,
  config: CollectionConfig,
  runId?: string,
  pauseAfter = true,
): Promise<{ ok: boolean; error?: string }> {
  const lock = await withRunLock(config.id, () => undoRunLocked(admin, shop, config, runId, pauseAfter));
  if (lock.locked) return lock.value;
  return { ok: false, error: "A shuffle is running on this collection right now. Try Undo again in a minute." };
}

async function undoRunLocked(
  admin: AdminApiContext,
  shop: string,
  config: CollectionConfig,
  runId: string | undefined,
  pauseAfter: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const cutoff = undoRetentionCutoff(settings?.plan);
  const eligibleRun = {
    shop,
    collectionId: config.id,
    status: "OK",
    trigger: { in: ["SCHEDULED", "MANUAL", "NEW_PRODUCTS"] },
    createdAt: { gte: cutoff },
    previousOrder: { not: null },
  } satisfies Prisma.ShuffleRunWhereInput;
  const run = runId
    ? await db.shuffleRun.findFirst({ where: { id: runId, ...eligibleRun } })
    : await db.shuffleRun.findFirst({
        where: eligibleRun,
        orderBy: { createdAt: "desc" },
      });
  if (!run?.previousOrder) return { ok: false, error: "Nothing to restore" };

  const targetOrder = unpackUndoOrder(run.previousOrder);
  const { products } = await getCollectionProductsInOrder(admin, config.collectionGid);
  const currentOrder = products.map((p) => p.id);
  // Only restore ids that still exist in the collection today.
  const stillPresent = new Set(currentOrder);
  const filteredTarget = targetOrder.filter((id) => stillPresent.has(id));
  const missingAtEnd = currentOrder.filter((id) => !filteredTarget.includes(id));
  const restoredOrder = [...filteredTarget, ...missingAtEnd];
  const moves = diffToMoves(currentOrder, restoredOrder);
  const reorderResult = await reorderCollectionProducts(admin, config.collectionGid, moves);
  if (!reorderResult.ok) return reorderResult;

  await db.collectionConfig.update({
    where: { id: config.id },
    data: {
      lastKnownOrder: JSON.stringify(restoredOrder),
      ...(pauseAfter ? { status: "PAUSED", nextRunAt: null } : {}),
    },
  });
  return { ok: true };
}

export async function ensureManualSort(admin: AdminApiContext, collectionGid: string) {
  return setCollectionManualSort(admin, collectionGid);
}

export interface RemoveRestoreResult {
  /** What was actually put back, for the toast — never a promise, always a
   * report of what happened. */
  restoredSort: string | null;
  restoredOrder: boolean;
  error?: string;
}

/**
 * Undo Shuffly's footprint on a collection as it's removed.
 *
 * The two restores are mutually exclusive by nature, which is why this picks
 * one rather than offering both:
 *
 *  - We switched the sort (previousSortOrder is set). Putting that automatic
 *    sort back makes product positions irrelevant — Shopify recomputes the
 *    order from the rule — so restoring the sort IS the restore, and
 *    reordering products first would be wasted work.
 *  - It was already Manual when it was added (previousSortOrder is null).
 *    Then the merchant's own curated order is the thing worth putting back,
 *    from the never-pruned originalOrder snapshot.
 *
 * Anything not present is simply not claimed: no snapshot, no order restore.
 */
export async function restoreOnRemove(
  admin: AdminApiContext,
  config: CollectionConfig,
): Promise<RemoveRestoreResult> {
  if (config.previousSortOrder) {
    const result = await restoreCollectionSort(admin, config.collectionGid, config.previousSortOrder);
    if (!result.ok) return { restoredSort: null, restoredOrder: false, error: result.error };
    return { restoredSort: config.previousSortOrder, restoredOrder: false };
  }

  const original = unpackProductIds(config.originalOrder);
  if (original.length === 0) return { restoredSort: null, restoredOrder: false };

  const { products } = await getCollectionProductsInOrder(admin, config.collectionGid);
  const currentOrder = products.map((p) => p.id);
  // Only ids still in the collection; anything added since goes to the end,
  // the same reconciliation undoRun does.
  const stillPresent = new Set(currentOrder);
  const target = original.filter((id) => stillPresent.has(id));
  const appended = currentOrder.filter((id) => !target.includes(id));
  const result = await reorderCollectionProducts(admin, config.collectionGid, diffToMoves(currentOrder, [...target, ...appended]));
  if (!result.ok) return { restoredSort: null, restoredOrder: false, error: result.error };
  return { restoredSort: null, restoredOrder: true };
}
