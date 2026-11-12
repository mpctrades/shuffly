// Turning a collection's live products + stored settings into the inputs of
// computeShuffledOrder. One builder for the real run and the "Shuffle all"
// preview, so the preview can never order things differently from the run.
// Pure (no DB, no network): callers pass in what they read.

import type { ShopifyProductSummary } from "./collections.server";
import { joinRotation, type ShuffleOptions, type ShuffleProductInput } from "./shuffle-algorithm.server";

export interface SeenRow {
  productId: string; // numeric, no gid prefix
  firstSeenAt: Date;
  baseline: boolean;
  productCreatedAt: Date | null;
}

export interface CollectionSettingsForRun {
  pins: number;
  pushSoldOutToEnd: boolean;
  boostNewArrivals: boolean;
  giveEveryoneATurn: boolean;
  newArrivalDays: number;
  turnCounts: string;
  priorityBoostIds: string;
  keepNewOnTop: boolean;
  newOnTopHours: number;
}

export const NEW_ON_TOP_HOURS = [24, 48, 72, 168] as const;

const shortId = (gid: string) => gid.replace("gid://shopify/Product/", "");

/**
 * When a product counts as having arrived, for Feature C: the moment
 * Shuffly first saw it in this collection — or, for a "baseline" product
 * that was already there when tracking started (so its arrival was never
 * seen), the product's own createdAt.
 */
export function arrivalTime(product: Pick<ShopifyProductSummary, "createdAt">, seen: SeenRow | undefined): number | null {
  if (seen && !seen.baseline) return seen.firstSeenAt.getTime();
  const created = seen?.productCreatedAt ?? (product.createdAt ? new Date(product.createdAt) : null);
  return created ? created.getTime() : null;
}

export function buildShuffleInputs({
  config,
  products,
  currentOrder,
  neverMoveTags,
  now,
  seen,
  newArrivalsAllowed,
}: {
  config: CollectionSettingsForRun;
  products: ShopifyProductSummary[];
  /** Order the run starts from (pins already reconciled). */
  currentOrder: string[];
  neverMoveTags: Set<string>;
  now: number;
  /** ProductSeen rows for this collection; empty when not tracking. */
  seen: SeenRow[];
  /** Whether the shop's plan includes Feature C (Pro) — checked on the run
   * path, not trusted from the stored flag alone. */
  newArrivalsAllowed: boolean;
}): {
  productsById: Map<string, ShuffleProductInput>;
  turnCounts: Record<string, number>;
  options: ShuffleOptions;
  excludedCount: number;
} {
  const keepNewOnTop = config.keepNewOnTop && newArrivalsAllowed;
  const windowMs = config.newOnTopHours * 3_600_000;
  const boostWindowMs = config.newArrivalDays * 86_400_000;
  const seenById = new Map(seen.map((r) => [r.productId, r]));

  const productsById = new Map<string, ShuffleProductInput>();
  for (const p of products) {
    const arrived = keepNewOnTop ? arrivalTime(p, seenById.get(shortId(p.id))) : null;
    productsById.set(p.id, {
      id: p.id,
      isSoldOut: p.tracksInventory && p.totalInventory <= 0,
      isNew: now - new Date(p.createdAt).getTime() <= boostWindowMs,
      neverMove: p.tags.some((t) => neverMoveTags.has(t.toLowerCase())),
      newArrivalAt: arrived != null && now - arrived <= windowMs ? arrived : null,
    });
  }

  // Fair rotation's pool: everything that isn't pinned or currently a new
  // arrival on top. The floor for newcomers is taken over the products that
  // can actually be featured (live and movable).
  const pinned = new Set(currentOrder.slice(0, Math.max(0, config.pins)));
  const rotationIds = currentOrder.filter((id) => !pinned.has(id) && productsById.get(id)?.newArrivalAt == null);
  const eligibleIds = rotationIds.filter((id) => {
    const p = productsById.get(id);
    return p && !p.neverMove && !(config.pushSoldOutToEnd && p.isSoldOut);
  });
  let stored: Record<string, number> = {};
  try {
    stored = JSON.parse(config.turnCounts || "{}");
  } catch {
    stored = {};
  }

  return {
    productsById,
    turnCounts: joinRotation(stored, rotationIds, eligibleIds),
    options: {
      pins: config.pins,
      pushSoldOutToEnd: config.pushSoldOutToEnd,
      boostNewArrivals: config.boostNewArrivals,
      giveEveryoneATurn: config.giveEveryoneATurn,
      priorityIds: new Set<string>(safeArray(config.priorityBoostIds)),
      keepNewOnTop,
    },
    excludedCount: [...productsById.values()].filter((p) => p.neverMove).length,
  };
}

function safeArray(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
