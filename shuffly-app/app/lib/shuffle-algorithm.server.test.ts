import { describe, expect, it } from "vitest";
import { bumpTurnCounts, computeShuffledOrder, type ShuffleOptions, type ShuffleProductInput } from "./shuffle-algorithm.server";

// A deterministic "rng" so shuffle results are reproducible instead of
// flaky — Fisher-Yates driven by a fixed sequence of [0,1) values, cycling
// once exhausted. Good enough to pin down ordering behaviour without
// pretending to be a real PRNG.
function sequenceRng(seq: number[]): () => number {
  let i = 0;
  return () => seq[i++ % seq.length];
}

function product(id: string, overrides: Partial<ShuffleProductInput> = {}): ShuffleProductInput {
  return { id, isSoldOut: false, isNew: false, neverMove: false, ...overrides };
}

function productMap(products: ShuffleProductInput[]): Map<string, ShuffleProductInput> {
  return new Map(products.map((p) => [p.id, p]));
}

const baseOpts: ShuffleOptions = {
  pins: 0,
  pushSoldOutToEnd: false,
  boostNewArrivals: false,
  giveEveryoneATurn: false,
};

describe("computeShuffledOrder", () => {
  it("leaves the first `pins` products untouched, in place", () => {
    const order = ["a", "b", "c", "d", "e"];
    const products = productMap(order.map((id) => product(id)));
    const result = computeShuffledOrder(order, products, {}, { ...baseOpts, pins: 2 }, () => 0);

    expect(result.order.slice(0, 2)).toEqual(["a", "b"]);
    expect(result.pinnedCount).toBe(2);
    // Everything after the pins is still exactly the tail set, just possibly reordered.
    expect(result.order.slice(2).sort()).toEqual(["c", "d", "e"]);
    expect(result.order).toHaveLength(5);
  });

  it("clamps an out-of-range pins count instead of throwing", () => {
    const order = ["a", "b", "c"];
    const products = productMap(order.map((id) => product(id)));

    const tooHigh = computeShuffledOrder(order, products, {}, { ...baseOpts, pins: 99 }, () => 0);
    expect(tooHigh.order).toEqual(["a", "b", "c"]);
    expect(tooHigh.pinnedCount).toBe(3);

    const negative = computeShuffledOrder(order, products, {}, { ...baseOpts, pins: -5 }, () => 0);
    expect(negative.pinnedCount).toBe(0);
  });

  it("keeps a neverMove product in its original tail slot", () => {
    const order = ["a", "b", "c", "d"];
    const products = productMap([
      product("a"),
      product("b", { neverMove: true }),
      product("c"),
      product("d"),
    ]);

    const result = computeShuffledOrder(order, products, {}, baseOpts, sequenceRng([0.9, 0.9, 0.9]));

    // "b" started at tail index 1 (overall index 1, since pins = 0) and must
    // still be there no matter how the movable pool got shuffled.
    expect(result.order[1]).toBe("b");
    expect(result.order.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("pushes sold-out products after every live product when pushSoldOutToEnd is on", () => {
    const order = ["a", "b", "c", "d"];
    const products = productMap([
      product("a", { isSoldOut: true }),
      product("b"),
      product("c", { isSoldOut: true }),
      product("d"),
    ]);

    const result = computeShuffledOrder(order, products, {}, { ...baseOpts, pushSoldOutToEnd: true }, sequenceRng([0.1, 0.4, 0.7]));

    expect(result.soldOutCount).toBe(2);
    const liveIds = new Set(["b", "d"]);
    const soldOutIndices = result.order
      .map((id, i) => ({ id, i }))
      .filter(({ id }) => !liveIds.has(id))
      .map(({ i }) => i);
    const liveIndices = result.order
      .map((id, i) => ({ id, i }))
      .filter(({ id }) => liveIds.has(id))
      .map(({ i }) => i);
    expect(Math.min(...soldOutIndices)).toBeGreaterThan(Math.max(...liveIndices));
  });

  it("does not push sold-out products to the end when the option is off", () => {
    const order = ["a", "b"];
    const products = productMap([product("a", { isSoldOut: true }), product("b")]);

    const result = computeShuffledOrder(order, products, {}, baseOpts, () => 0);

    // With rng() always 0, Fisher-Yates leaves the array unchanged here —
    // the point of the assertion is soldOutCount staying 0, i.e. the
    // sold-out product was never split out of the normal pool at all.
    expect(result.soldOutCount).toBe(0);
    expect(result.order.sort()).toEqual(["a", "b"]);
  });

  it("boosts new-arrival products ahead of the rest of the movable pool", () => {
    const order = ["old1", "old2", "new1", "old3"];
    const products = productMap([
      product("old1"),
      product("old2"),
      product("new1", { isNew: true }),
      product("old3"),
    ]);

    const result = computeShuffledOrder(order, products, {}, { ...baseOpts, boostNewArrivals: true }, sequenceRng([0.2, 0.5, 0.8]));

    expect(result.order[0]).toBe("new1");
  });

  it("places priorityIds at the very front, ahead of the new-arrivals boost", () => {
    const order = ["a", "b", "new1", "prio1"];
    const products = productMap([
      product("a"),
      product("b"),
      product("new1", { isNew: true }),
      product("prio1"),
    ]);
    const opts: ShuffleOptions = { ...baseOpts, boostNewArrivals: true, priorityIds: new Set(["prio1"]) };

    const result = computeShuffledOrder(order, products, {}, opts, sequenceRng([0.3, 0.6, 0.9]));

    expect(result.order[0]).toBe("prio1");
  });

  it("orders tied products by ascending turn count when giveEveryoneATurn is on", () => {
    const order = ["a", "b", "c"];
    const products = productMap(order.map((id) => product(id)));
    const turnCounts = { a: 5, b: 0, c: 2 };

    const result = computeShuffledOrder(order, products, turnCounts, { ...baseOpts, giveEveryoneATurn: true }, () => 0);

    expect(result.order).toEqual(["b", "c", "a"]);
  });

  it("preserves the full id set with no duplicates or drops across all options combined", () => {
    const order = ["p1", "p2", "n1", "s1", "nm1", "reg1", "reg2"];
    const products = productMap([
      product("p1"),
      product("p2"),
      product("n1", { isNew: true }),
      product("s1", { isSoldOut: true }),
      product("nm1", { neverMove: true }),
      product("reg1"),
      product("reg2"),
    ]);
    const opts: ShuffleOptions = {
      pins: 2,
      pushSoldOutToEnd: true,
      boostNewArrivals: true,
      giveEveryoneATurn: true,
      priorityIds: new Set(["reg2"]),
    };

    const result = computeShuffledOrder(order, products, { reg1: 3 }, opts, sequenceRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]));

    expect(result.order.slice().sort()).toEqual(order.slice().sort());
    expect(new Set(result.order).size).toBe(order.length);
    expect(result.order.slice(0, 2)).toEqual(["p1", "p2"]);
  });
});

describe("bumpTurnCounts", () => {
  it("increments only products landing in the featured slots after pins", () => {
    const order = ["pin1", "pin2", "f1", "f2", "f3", "f4", "rest1", "rest2"];
    const result = bumpTurnCounts({}, order, 2, 4);

    expect(result).toEqual({ f1: 1, f2: 1, f3: 1, f4: 1 });
  });

  it("adds to existing counts instead of resetting them", () => {
    const order = ["a", "b"];
    const result = bumpTurnCounts({ a: 3, z: 9 }, order, 0, 2);

    expect(result).toEqual({ a: 4, b: 1, z: 9 });
  });

  it("does not mutate the input turnCounts object", () => {
    const input = { a: 1 };
    bumpTurnCounts(input, ["a"], 0, 1);
    expect(input).toEqual({ a: 1 });
  });

  it("handles fewer remaining products than featuredSlots without throwing", () => {
    const result = bumpTurnCounts({}, ["pin1", "only1"], 1, 4);
    expect(result).toEqual({ only1: 1 });
  });
});
