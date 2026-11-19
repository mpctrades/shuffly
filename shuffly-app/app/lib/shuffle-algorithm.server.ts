// Pure ordering logic — no network/DB calls — so it's easy to reason about
// and matches the behaviour demonstrated in the interactive mockup:
//   1. The first N products ("pins") never move.
//   2. Products tagged with a "never move" tag stay in whatever slot they
//      already hold among the non-pinned products.
//   3. Everything else is shuffled at random, with three optional twists:
//        - sold-out products get pushed to the very end
//        - "new" products (created within `newArrivalDays`) are boosted to
//          the front of the shuffled pool
//        - "give everyone a turn" fairness: among ties, products that have
//          been featured (moved into the front of the collection) least
//          recently are more likely to land near the front

export interface ShuffleProductInput {
  id: string;
  isSoldOut: boolean;
  isNew: boolean;
  neverMove: boolean;
  /** Feature C (Update 2): when this product arrived, as epoch ms, if it is
   * inside the "keep new on top" window; null/undefined otherwise. */
  newArrivalAt?: number | null;
}

export interface ShuffleOptions {
  pins: number;
  pushSoldOutToEnd: boolean;
  boostNewArrivals: boolean;
  giveEveryoneATurn: boolean;
  /** One-time "lead the next run" list (Insights' "Put these first tomorrow")
   * — placed at the very front of the shuffled pool, ahead of the new-arrivals
   * boost, then the caller is expected to clear it so it only affects this run. */
  priorityIds?: Set<string>;
  /** Feature C: products with a `newArrivalAt` lead the order, newest first,
   * right after the pins. Overrides `boostNewArrivals`. */
  keepNewOnTop?: boolean;
}

export interface ShuffleResult {
  order: string[]; // full new order, same ids as input, just reordered
  pinnedCount: number;
  soldOutCount: number;
  shuffledCount: number;
  /** Feature C: the live new arrivals placed on top. Their time up there is
   * not a "turn" for fair rotation — see bumpTurnCounts. */
  newArrivalIds: string[];
}

function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function computeShuffledOrder(
  currentOrder: string[],
  productsById: Map<string, ShuffleProductInput>,
  turnCounts: Record<string, number>,
  opts: ShuffleOptions,
  rng: () => number = Math.random,
): ShuffleResult {
  const pins = Math.max(0, Math.min(currentOrder.length, opts.pins));
  const pinnedIds = currentOrder.slice(0, pins);
  const tail = currentOrder.slice(pins);

  // Split the tail into slots that must stay put (never-move tag) and the
  // pool that's actually up for shuffling, remembering each frozen item's
  // position within the tail so we can reinsert it later.
  const frozenSlots: Array<{ index: number; id: string }> = [];
  const movable: string[] = [];
  tail.forEach((id, index) => {
    const p = productsById.get(id);
    if (p?.neverMove) {
      frozenSlots.push({ index, id });
    } else {
      movable.push(id);
    }
  });

  const arrange = (ids: string[]): string[] => {
    const shuffled = shuffle(ids, rng);
    if (!opts.giveEveryoneATurn) return shuffled;
    // Stable-ish: sort by turn count ascending, but keep the random
    // shuffle's relative order for ties (Array#sort is stable in modern JS).
    return shuffled.sort((a, b) => (turnCounts[a] ?? 0) - (turnCounts[b] ?? 0));
  };

  let soldOutIds: string[] = [];
  let liveIds = movable;
  if (opts.pushSoldOutToEnd) {
    soldOutIds = movable.filter((id) => productsById.get(id)?.isSoldOut);
    liveIds = movable.filter((id) => !productsById.get(id)?.isSoldOut);
  }

  // A one-time "lead the next run" boost beats everything else below —
  // pulled out first, arranged among themselves, and never re-considered by
  // the new-arrivals boost or fairness sort.
  const priorityIds = opts.priorityIds && opts.priorityIds.size > 0 ? liveIds.filter((id) => opts.priorityIds!.has(id)) : [];
  const prioritySet = new Set(priorityIds);
  liveIds = liveIds.filter((id) => !prioritySet.has(id));

  // Feature C: live new arrivals lead, newest first. Sold-out new arrivals
  // were already split off above and still go to the end.
  let newArrivalIds: string[] = [];
  if (opts.keepNewOnTop) {
    newArrivalIds = liveIds
      .filter((id) => productsById.get(id)?.newArrivalAt != null)
      .sort((a, b) => productsById.get(b)!.newArrivalAt! - productsById.get(a)!.newArrivalAt! || (a < b ? -1 : 1));
    const arrivalSet = new Set(newArrivalIds);
    liveIds = liveIds.filter((id) => !arrivalSet.has(id));
  }

  let newMovableOrder: string[];
  if (opts.boostNewArrivals && !opts.keepNewOnTop) {
    const newIds = liveIds.filter((id) => productsById.get(id)?.isNew);
    const restIds = liveIds.filter((id) => !productsById.get(id)?.isNew);
    newMovableOrder = [...arrange(newIds), ...arrange(restIds)];
  } else {
    newMovableOrder = arrange(liveIds);
  }
  // Pins (outside this pool) → new arrivals → one-time priority → rotation.
  newMovableOrder = [...newArrivalIds, ...shuffle(priorityIds, rng), ...newMovableOrder];
  newMovableOrder = [...newMovableOrder, ...shuffle(soldOutIds, rng)];

  // Reinsert frozen (never-move) items back at their original tail index.
  const newTail: string[] = new Array(tail.length);
  const frozenIndexSet = new Set(frozenSlots.map((f) => f.index));
  let cursor = 0;
  for (let i = 0; i < tail.length; i++) {
    if (frozenIndexSet.has(i)) {
      newTail[i] = frozenSlots.find((f) => f.index === i)!.id;
    } else {
      newTail[i] = newMovableOrder[cursor++];
    }
  }

  return {
    order: [...pinnedIds, ...newTail],
    pinnedCount: pinnedIds.length,
    soldOutCount: soldOutIds.length,
    shuffledCount: newMovableOrder.length - soldOutIds.length,
    newArrivalIds,
  };
}

/** Bump the turn counter for the first `featuredSlots` products after the
 * pins that landed in the "featured" front slots this run — mirrors the
 * mockup's `s.turns[i]++` bookkeeping so "give everyone a turn" converges.
 *
 * `notATurn` (Update 2): products whose place at the top this run wasn't a
 * rotation turn — Feature C's new arrivals. They are skipped, and the
 * featured slots are the first `featuredSlots` *rotation* products after
 * them, so a new arrival's time on top neither uses up its turn nor steals
 * one from the products behind it. */
export function bumpTurnCounts(
  turnCounts: Record<string, number>,
  order: string[],
  pins: number,
  featuredSlots = 4,
  notATurn: Set<string> = new Set(),
): Record<string, number> {
  const next = { ...turnCounts };
  let bumped = 0;
  for (let i = pins; i < order.length && bumped < featuredSlots; i++) {
    const id = order[i];
    if (notATurn.has(id)) continue;
    next[id] = (next[id] ?? 0) + 1;
    bumped++;
  }
  return next;
}

/** Marks a turn-count map that lists every product (see joinRotation). Not
 * a product id: stripped on read, never compared. */
const COMPLETE_MARKER = "~complete";

/**
 * Ready a stored turn-count map for this run (Update 2 fairness fix):
 *
 *  - Products that have left the collection are dropped, so the map can't
 *    grow forever on a high-churn collection.
 *  - A product joining rotation — newly added, or whose new-arrivals window
 *    just ended — starts at the CURRENT MINIMUM of the pool, not at 0.
 *    Starting at 0 among products already at 5 would give it the top spot
 *    for five hourly runs in a row; at the minimum it simply takes its place
 *    in the current cycle. ("Every product reaches the top before any
 *    repeats" — a product that arrived mid-cycle joins that cycle.)
 *
 * Telling "joined since last run" from "has never been featured" needs a map
 * that lists every product, so once normalized the map is complete and
 * carries COMPLETE_MARKER. A map written before Update 2 only listed
 * products that had been featured; on that first pass every missing product
 * is an existing one and starts at 0, exactly as before.
 */
export function joinRotation(
  stored: Record<string, number>,
  rotationIds: string[],
  /** The products that can actually be featured this run (live, not pinned,
   * not frozen). The minimum is taken over these only: a pinned or sold-out
   * product never gets a turn, and would otherwise hold the floor at 0. */
  eligibleIds: string[] = rotationIds,
): Record<string, number> {
  const complete = stored[COMPLETE_MARKER] === 1;
  const present = new Set(rotationIds);
  const known = Object.entries(stored).filter(([id]) => id !== COMPLETE_MARKER && present.has(id));
  const counts: Record<string, number> = Object.fromEntries(known);
  const floor = complete
    ? eligibleIds.reduce((min, id) => (id in counts ? Math.min(min, counts[id]) : min), Infinity)
    : 0;
  for (const id of rotationIds) {
    if (!(id in counts)) counts[id] = Number.isFinite(floor) ? floor : 0;
  }
  return counts;
}

/** The map as stored: complete, marked. */
export function serializeTurnCounts(counts: Record<string, number>): string {
  return JSON.stringify({ ...counts, [COMPLETE_MARKER]: 1 });
}
