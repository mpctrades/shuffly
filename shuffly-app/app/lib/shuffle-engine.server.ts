import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig } from "@prisma/client";
import db from "../db.server";
import {
  diffToMoves,
  getCollectionProductsInOrder,
  reorderCollectionProducts,
  setCollectionManualSort,
} from "./collections.server";
import { bumpTurnCounts, computeShuffledOrder, type ShuffleProductInput } from "./shuffle-algorithm.server";
import { computeNextRun, type ScheduleType } from "./schedule.server";
import { recordProductPositions, recordKnownProducts, invalidateInsightsCache } from "./insights.server";

export interface ShuffleRunSummary {
  ok: boolean;
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
  trigger: "SCHEDULED" | "MANUAL" | "SOLD_OUT_REACTION" | "RESTOCK_REACTION",
  batchId?: string,
  pageSize = 24,
): Promise<ShuffleRunSummary> {
  const started = Date.now();
  const { sortOrder, products } = await getCollectionProductsInOrder(admin, config.collectionGid);

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
    return {
      ok: false,
      error: "NOT_MANUAL",
      movedCount: 0,
      pinnedCount: 0,
      soldOutCount: 0,
      durationMs: Date.now() - started,
      message: `"${config.title}" uses a sort order Shuffly can't set positions on yet. Switch it to manual sort first.`,
    };
  }

  const fetchedOrder = products.map((p) => p.id);
  const lastKnownOrder: string[] | null = config.lastKnownOrder ? JSON.parse(config.lastKnownOrder) : null;
  const { order: currentOrder, externalChangeCount, diff: externalReorderDiff } = reconcileExternalReorder(fetchedOrder, lastKnownOrder, config.pins);

  const neverMoveTags = parseNeverMoveTags(neverMoveTagsCsv);
  const now = Date.now();
  const newArrivalMs = config.newArrivalDays * 86_400_000;

  const productsById = new Map<string, ShuffleProductInput>(
    products.map((p) => [
      p.id,
      {
        id: p.id,
        isSoldOut: p.tracksInventory && p.totalInventory <= 0,
        isNew: now - new Date(p.createdAt).getTime() <= newArrivalMs,
        neverMove: p.tags.some((t) => neverMoveTags.has(t.toLowerCase())),
      },
    ]),
  );

  const turnCounts: Record<string, number> = JSON.parse(config.turnCounts || "{}");
  const priorityIds = new Set<string>(JSON.parse(config.priorityBoostIds || "[]"));

  const result = computeShuffledOrder(currentOrder, productsById, turnCounts, {
    pins: config.pins,
    pushSoldOutToEnd: config.pushSoldOutToEnd,
    boostNewArrivals: config.boostNewArrivals,
    giveEveryoneATurn: config.giveEveryoneATurn,
    priorityIds,
  });

  const moves = diffToMoves(fetchedOrder, result.order);
  const reorderResult = await reorderCollectionProducts(admin, config.collectionGid, moves);

  const durationMs = Date.now() - started;

  if (!reorderResult.ok) {
    await db.shuffleRun.create({
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
        message: reorderResult.error ?? "Unknown error",
      },
    });
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

  const nextTurnCounts = bumpTurnCounts(turnCounts, result.order, result.pinnedCount);
  const nextRunAt = computeNextRun(
    new Date(),
    timezone,
    config.scheduleType as ScheduleType,
    config.scheduleTime,
    config.scheduleWeekday,
  );

  const writes = [
    db.collectionConfig.update({
      where: { id: config.id },
      data: {
        turnCounts: JSON.stringify(nextTurnCounts),
        lastRunAt: new Date(),
        lastSoldOutCount: result.soldOutCount,
        lastKnownOrder: JSON.stringify(result.order),
        nextRunAt,
        productCount: products.length,
        // One-time boost, consumed — it only ever leads a single run.
        priorityBoostIds: "[]",
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
        message: `Shuffled — ${moves.length} products moved`,
        previousOrder: JSON.stringify(fetchedOrder),
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
    message: `Shuffled — ${moves.length} products moved`,
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
  const run = runId
    ? await db.shuffleRun.findUnique({ where: { id: runId } })
    : await db.shuffleRun.findFirst({
        where: { collectionId: config.id, status: "OK", previousOrder: { not: null } },
        orderBy: { createdAt: "desc" },
      });
  if (!run?.previousOrder) return { ok: false, error: "Nothing to restore" };

  const targetOrder: string[] = JSON.parse(run.previousOrder);
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
