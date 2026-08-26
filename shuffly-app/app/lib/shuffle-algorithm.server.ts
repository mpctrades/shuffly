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
}

export interface ShuffleResult {
  order: string[]; // full new order, same ids as input, just reordered
  pinnedCount: number;
  soldOutCount: number;
  shuffledCount: number;
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

  let newMovableOrder: string[];
  if (opts.boostNewArrivals) {
    const newIds = liveIds.filter((id) => productsById.get(id)?.isNew);
    const restIds = liveIds.filter((id) => !productsById.get(id)?.isNew);
    newMovableOrder = [...arrange(newIds), ...arrange(restIds)];
  } else {
    newMovableOrder = arrange(liveIds);
  }
  newMovableOrder = [...shuffle(priorityIds, rng), ...newMovableOrder];
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
  };
}

/** Bump the turn counter for the first `n` non-pinned, non-sold-out products
 * that landed in the "featured" front slots this run — mirrors the mockup's
 * `s.turns[i]++` bookkeeping so "give everyone a turn" actually converges. */
export function bumpTurnCounts(
  turnCounts: Record<string, number>,
  order: string[],
  pins: number,
  featuredSlots = 4,
): Record<string, number> {
  const next = { ...turnCounts };
  order.slice(pins, pins + featuredSlots).forEach((id) => {
    next[id] = (next[id] ?? 0) + 1;
  });
  return next;
}
