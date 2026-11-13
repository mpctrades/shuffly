// Feature B — "Reshuffle automatically when new products are added" (Pro),
// plus the first-seen tracking Feature C reads.
//
// Polling, not webhooks, for v1 (brief §5): easier to test, no missed
// events. Every 15 minutes each enabled collection is probed; a detected
// batch waits 10 minutes (imports arrive in bursts), then triggers one
// shuffle — at most one an hour per collection, and not at all when a
// scheduled run is due within 15 minutes (it will pick the products up).
//
// What counts as "new" is a product id this collection hasn't had before.
// Removals never trigger anything. The product count is only a cheap
// pre-check: a swap (one in, one out) leaves it unchanged, which is why ids
// are compared — see pollCollection for how that's kept cheap.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig, ShopSettings } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { adminGraphql } from "./admin-graphql.server";
import { mapWithLimit } from "./collections.server";
import { canUseNewArrivals } from "./plans";
import { syncPlanFromAdmin } from "./billing.server";
import { nextRunFor } from "./schedule-core";
import { resolveSchedule } from "./schedule-resolve";
import { runShuffleForCollection } from "./shuffle-engine.server";
import { shortId, startTracking, syncSeenProducts, type SeenInput } from "./product-seen.server";

export const POLL_INTERVAL_MS = 15 * 60_000;
export const DEBOUNCE_MS = 10 * 60_000;
export const MIN_TRIGGER_GAP_MS = 60 * 60_000;
export const SCHEDULED_SOON_MS = 15 * 60_000;
/** A full id scan runs at least this often even when nothing looks changed:
 * the safety net for an older product swapped in with the count unchanged. */
export const FULL_SCAN_MAX_AGE_MS = 60 * 60_000;
/** How many of the newest-created products the cheap probe reads. */
const PROBE_SIZE = 50;


// ---------------------------------------------------------------------------
// The decision, pure so the debounce and limits can be tested exhaustively.
// ---------------------------------------------------------------------------

export interface TriggerState {
  pendingSince: Date | null;
  pendingCount: number;
  lastTriggerAt: Date | null;
}

export type TriggerDecision =
  /** Nothing new, nothing waiting. */
  | { action: "idle" }
  /** A batch is waiting out its 10 minutes, or the hourly limit. */
  | { action: "wait"; reason: "debounce" | "hourly-limit" }
  /** A scheduled run is about to happen and will cover these products. */
  | { action: "leave-to-schedule" }
  | { action: "run"; added: number };

/** Fold this poll's detections into the pending batch. */
export function addDetections(state: TriggerState, added: number, now: Date): TriggerState {
  if (added <= 0) return state;
  return {
    ...state,
    // The wait starts at the FIRST detection of a batch and isn't restarted
    // by later ones, so a slow 2-hour import still gets a shuffle, rather
    // than being pushed back on every poll.
    pendingSince: state.pendingSince ?? now,
    pendingCount: state.pendingCount + added,
  };
}

export function decideTrigger(state: TriggerState, now: Date, nextScheduledAt: Date | null): TriggerDecision {
  if (!state.pendingSince || state.pendingCount <= 0) return { action: "idle" };
  if (now.getTime() - state.pendingSince.getTime() < DEBOUNCE_MS) return { action: "wait", reason: "debounce" };
  if (nextScheduledAt && nextScheduledAt.getTime() - now.getTime() <= SCHEDULED_SOON_MS) {
    return { action: "leave-to-schedule" };
  }
  if (state.lastTriggerAt && now.getTime() - state.lastTriggerAt.getTime() < MIN_TRIGGER_GAP_MS) {
    return { action: "wait", reason: "hourly-limit" };
  }
  return { action: "run", added: state.pendingCount };
}

// ---------------------------------------------------------------------------
// Reading Shopify.
// ---------------------------------------------------------------------------

interface Probe {
  sortOrder: string;
  count: number;
  newest: SeenInput[];
}

/** ~2 points for the count + ~52 for the 50 newest-created products: what
 * a quiet collection costs per poll. Catches the common case (an import of
 * freshly created products) on its own. */
async function probe(admin: AdminApiContext, collectionGid: string): Promise<Probe | null> {
  const res = await adminGraphql(
    admin,
    `#graphql
    query ShufflyNewProductsProbe($id: ID!) {
      collection(id: $id) {
        id
        sortOrder
        productsCount { count }
        products(first: ${PROBE_SIZE}, sortKey: CREATED, reverse: true) { nodes { id createdAt } }
      }
    }`,
    { variables: { id: collectionGid } },
  );
  const json = await res.json();
  const c = json.data?.collection;
  if (!c) return null;
  return { sortOrder: c.sortOrder, count: c.productsCount?.count ?? 0, newest: c.products?.nodes ?? [] };
}

/** Every product id in the collection, 250 per page (~252 points a page). */
async function scanAllIds(admin: AdminApiContext, collectionGid: string): Promise<SeenInput[]> {
  const out: SeenInput[] = [];
  let after: string | null = null;
  for (;;) {
    const res: Response = await adminGraphql(
      admin,
      `#graphql
      query ShufflyCollectionProductIds($id: ID!, $after: String) {
        collection(id: $id) {
          id
          products(first: 250, after: $after) { nodes { id createdAt } pageInfo { hasNextPage endCursor } }
        }
      }`,
      { variables: { id: collectionGid, after } },
    );
    const json = await res.json();
    const page = json.data?.collection?.products;
    if (!page) break;
    out.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The poll.
// ---------------------------------------------------------------------------

export interface PollOutcome {
  collectionId: string;
  scanned: boolean;
  added: number;
  decision: TriggerDecision["action"] | "not-manual" | "gone";
}

/**
 * One poll of one collection. The cheap probe runs every time; the full id
 * scan only when the probe says something changed (count moved, or an
 * unseen id among the newest products) or once an hour as the safety net.
 *
 * Why not the newest-created probe alone: an older product newly added to
 * the collection isn't among the newest-created. Why not a full scan every
 * 15 minutes: four times the cost for every enabled collection, for no
 * extra detection in the common case.
 */
export async function pollCollection(
  admin: AdminApiContext,
  shop: string,
  config: CollectionConfig,
  settings: ShopSettings,
  now: Date,
): Promise<PollOutcome> {
  const base = { collectionId: config.id, scanned: false, added: 0 };
  // Between polls this is only here because a waiting batch's 10 minutes
  // are up: decide from the database alone, without asking Shopify again.
  const pollDue = !config.newCheckLastAt || now.getTime() - config.newCheckLastAt.getTime() >= POLL_INTERVAL_MS;
  if (!pollDue) return { ...base, decision: await decideAndMaybeRun(admin, shop, config, settings, now, 0) };

  const p = await probe(admin, config.collectionGid);
  if (!p) return { ...base, decision: "gone" };
  // Not on Manual: there's nothing we could write. The run path pauses it
  // and says so; the poll just leaves it alone.
  if (p.sortOrder !== "MANUAL") {
    await db.collectionConfig.update({ where: { id: config.id }, data: { newCheckLastAt: now } });
    return { ...base, decision: "not-manual" };
  }

  if (!config.newTrackingSince) {
    await startTracking(config.id, await scanAllIds(admin, config.collectionGid), now);
    await db.collectionConfig.update({
      where: { id: config.id },
      data: { newCheckLastAt: now, newCheckCount: p.count, newFullScanAt: now },
    });
    return { ...base, scanned: true, decision: "idle" };
  }

  const known = new Set(
    (
      await db.productSeen.findMany({
        where: { collectionId: config.id, productId: { in: p.newest.map((n) => shortId(n.id)) } },
        select: { productId: true },
      })
    ).map((r) => r.productId),
  );
  const unseenAmongNewest = p.newest.some((n) => !known.has(shortId(n.id)));
  const fullScanDue = !config.newFullScanAt || now.getTime() - config.newFullScanAt.getTime() >= FULL_SCAN_MAX_AGE_MS;
  const scan = p.count !== config.newCheckCount || unseenAmongNewest || fullScanDue;

  let added = 0;
  if (scan) {
    added = (await syncSeenProducts(config.id, await scanAllIds(admin, config.collectionGid), now)).added.length;
  }

  await db.collectionConfig.update({
    where: { id: config.id },
    data: { newCheckLastAt: now, newCheckCount: p.count, ...(scan ? { newFullScanAt: now } : {}) },
  });
  const decision = await decideAndMaybeRun(admin, shop, config, settings, now, added);
  return { ...base, scanned: scan, added, decision };
}

async function decideAndMaybeRun(
  admin: AdminApiContext,
  shop: string,
  config: CollectionConfig,
  settings: ShopSettings,
  now: Date,
  added: number,
): Promise<TriggerDecision["action"]> {
  const state = addDetections(
    { pendingSince: config.newPendingSince, pendingCount: config.newPendingCount, lastTriggerAt: config.lastNewTriggerAt },
    added,
    now,
  );
  const nextScheduledAt = nextRunFor(now, settings.timezone, resolveSchedule(config, settings));
  const decision = decideTrigger(state, now, nextScheduledAt);

  if (added > 0) {
    await db.collectionConfig.update({
      where: { id: config.id },
      data: { newPendingSince: state.pendingSince, newPendingCount: state.pendingCount },
    });
  }
  if (decision.action !== "run") return decision.action;

  const fresh = await db.collectionConfig.findUnique({ where: { id: config.id } });
  if (!fresh) return decision.action;
  const summary = await runShuffleForCollection(
    admin,
    shop,
    fresh,
    settings.timezone,
    settings.neverMoveTags,
    "NEW_PRODUCTS",
    undefined,
    settings.pageSize,
    {
      messageCode: "NEW_PRODUCTS",
      messageParams: { added: decision.added },
      message: `Triggered by new products (${decision.added} added)`,
    },
  );
  if (!summary.skipped) {
    // Counted against the hourly limit whether or not Shopify accepted it,
    // so a failing collection isn't retried every minute. A successful run
    // clears the pending batch itself (shuffle engine); a failed one is
    // dropped here so the next attempt is the next detection, not a loop.
    await db.collectionConfig.update({
      where: { id: config.id },
      data: { lastNewTriggerAt: now, ...(summary.ok ? {} : { newPendingSince: null, newPendingCount: 0 }) },
    });
  }
  return decision.action;
}

/** Collections this tick should look at: due a poll, or holding a batch
 * whose 10-minute wait is over (so the wait is ~10 minutes, not "until the
 * next 15-minute poll"). */
function dueWhere(now: Date) {
  return {
    status: "RUNNING",
    reshuffleOnNew: true,
    // Paused because the sort is no longer Manual: nothing could be written.
    sortOrderIssueAt: null,
    OR: [
      { newCheckLastAt: null },
      { newCheckLastAt: { lte: new Date(now.getTime() - POLL_INTERVAL_MS) } },
      { newPendingSince: { lte: new Date(now.getTime() - DEBOUNCE_MS) } },
    ],
  };
}

const shopsInFlight = new Set<string>();

/** Called every minute by the scheduler. Cheap when nothing is due: one
 * indexed query, no Shopify calls. */
export async function runNewProductsChecks(now: Date = new Date()): Promise<PollOutcome[]> {
  const due = await db.collectionConfig.findMany({ where: dueWhere(now) });
  if (due.length === 0) return [];

  const byShop = new Map<string, CollectionConfig[]>();
  for (const c of due) byShop.set(c.shop, [...(byShop.get(c.shop) ?? []), c]);

  const outcomes: PollOutcome[] = [];
  const shops = [...byShop].filter(([shop]) => !shopsInFlight.has(shop));
  await mapWithLimit(shops, 4, async ([shop, configs]) => {
    shopsInFlight.add(shop);
    try {
      const settings = await db.shopSettings.findUnique({ where: { shop } });
      // Pro only. A shop that isn't Pro has its flags cleared by the
      // downgrade clamps; this is the backstop for one that slipped through.
      if (!settings || !canUseNewArrivals(settings.plan)) return;
      const { admin } = await unauthenticated.admin(shop);
      // Same run-path plan check as the scheduled sweep: if Shopify says the
      // shop just left Pro, the clamps turn this option off and we stop.
      const synced = await syncPlanFromAdmin(shop, admin, { now }).catch((err) => {
        console.error(`[new-products] plan re-check for ${shop} failed:`, err);
        return null;
      });
      if (synced?.changed && !canUseNewArrivals(synced.planId)) return;
      for (const config of configs) {
        try {
          outcomes.push(await pollCollection(admin, shop, config, settings, now));
        } catch (err) {
          console.error(`[new-products] ${shop} ${config.collectionGid} poll failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[new-products] ${shop} failed:`, err);
    } finally {
      shopsInFlight.delete(shop);
    }
  });
  return outcomes;
}
