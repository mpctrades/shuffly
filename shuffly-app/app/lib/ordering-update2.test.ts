import { describe, expect, it } from "vitest";
import {
  bumpTurnCounts,
  computeShuffledOrder,
  joinRotation,
  serializeTurnCounts,
  type ShuffleProductInput,
} from "./shuffle-algorithm.server";
import { arrivalTime, buildShuffleInputs, type SeenRow } from "./shuffle-inputs.server";
import type { ShopifyProductSummary } from "./collections.server";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type P = Partial<ShuffleProductInput> & { id: string };
function catalogue(items: P[]) {
  return new Map<string, ShuffleProductInput>(
    items.map((p) => [p.id, { isSoldOut: false, isNew: false, neverMove: false, newArrivalAt: null, ...p }]),
  );
}
const base = { pins: 0, pushSoldOutToEnd: true, boostNewArrivals: false, giveEveryoneATurn: true, keepNewOnTop: true };

describe("Update 2 ordering: pins → new arrivals → rotation → sold-out", () => {
  // p0 p1 pinned · n1 n2 n3 new (n3 newest, n2 sold out) · x excluded at
  // index 5 · s1 sold out · r1..r4 rotation.
  const order = ["p0", "p1", "r1", "n1", "s1", "x", "r2", "n2", "r3", "n3", "r4"];
  const products = catalogue([
    { id: "p0" },
    { id: "p1" },
    { id: "n1", newArrivalAt: 1_000 },
    { id: "n2", newArrivalAt: 2_000, isSoldOut: true },
    { id: "n3", newArrivalAt: 3_000 },
    { id: "x", neverMove: true },
    { id: "s1", isSoldOut: true },
    { id: "r1" },
    { id: "r2" },
    { id: "r3" },
    { id: "r4" },
  ]);

  it("produces the documented order on every seed", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = computeShuffledOrder(order, products, {}, { ...base, pins: 2 }, rng(seed));
      expect(r.order.slice(0, 2)).toEqual(["p0", "p1"]); // pins never move
      expect(r.order[5]).toBe("x"); // excluded product untouched, same index
      const rest = r.order.filter((id) => !["p0", "p1", "x"].includes(id));
      expect(rest.slice(0, 2)).toEqual(["n3", "n1"]); // live new arrivals, newest first
      expect(new Set(rest.slice(2, 6))).toEqual(new Set(["r1", "r2", "r3", "r4"])); // rotation
      expect(new Set(rest.slice(6))).toEqual(new Set(["s1", "n2"])); // sold-out last, sold-out new arrival too
      expect(r.newArrivalIds).toEqual(["n3", "n1"]);
    }
  });

  it("without Feature C, products with an arrival time are just rotation", () => {
    const r = computeShuffledOrder(order, products, {}, { ...base, pins: 2, keepNewOnTop: false }, rng(3));
    expect(r.newArrivalIds).toEqual([]);
  });

  it("Feature C overrides the older boostNewArrivals toggle", () => {
    const p = catalogue([{ id: "a", isNew: true }, { id: "b", newArrivalAt: 5 }, { id: "c" }]);
    for (let seed = 1; seed < 20; seed++) {
      const r = computeShuffledOrder(["a", "b", "c"], p, {}, { ...base, boostNewArrivals: true }, rng(seed));
      expect(r.order[0]).toBe("b");
    }
  });

  it("the one-time Insights priority boost comes after new arrivals", () => {
    const p = catalogue([{ id: "a" }, { id: "b", newArrivalAt: 5 }, { id: "c" }]);
    const r = computeShuffledOrder(["a", "b", "c"], p, {}, { ...base, priorityIds: new Set(["c"]) }, rng(1));
    expect(r.order.slice(0, 2)).toEqual(["b", "c"]);
  });
});

describe("fair rotation across 24 runs a day", () => {
  /** Simulate hourly runs through the real pipeline pieces the engine uses:
   * joinRotation → computeShuffledOrder → bumpTurnCounts → serialize. */
  function simulate({
    products,
    runs,
    onRun,
  }: {
    products: string[];
    runs: number;
    onRun?: (run: number, ids: string[], catalogueFor: Map<string, ShuffleProductInput>) => void;
  }) {
    let ids = products.slice();
    let stored = "{}";
    const rand = rng(11);
    const history: Array<Record<string, number>> = [];
    for (let run = 0; run < runs; run++) {
      const cat = catalogue(ids.map((id) => ({ id })));
      onRun?.(run, ids, cat);
      ids = [...cat.keys()];
      const rotation = ids.filter((id) => cat.get(id)!.newArrivalAt == null);
      const counts = joinRotation(JSON.parse(stored), rotation);
      const r = computeShuffledOrder(ids, cat, counts, base, rand);
      const next = bumpTurnCounts(counts, r.order, 0, 4, new Set(r.newArrivalIds));
      stored = serializeTurnCounts(next);
      ids = r.order;
      history.push(next);
    }
    return history;
  }

  it("100 products, hourly for 3 days: everyone reaches the top before anyone repeats", () => {
    const products = Array.from({ length: 100 }, (_, i) => `p${i}`);
    const history = simulate({ products, runs: 72 });
    for (const counts of history) {
      const values = products.map((id) => counts[id] ?? 0);
      // Never more than one turn apart: nobody gets a second turn while
      // someone is still waiting for their first.
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
    // 72 runs × 4 featured slots = 288 turns = 2.88 full cycles.
    const final = history.at(-1)!;
    expect(products.every((id) => final[id] >= 2)).toBe(true);
  });

  it("a product added mid-cycle joins that cycle instead of hogging the top", () => {
    const products = Array.from({ length: 40 }, (_, i) => `p${i}`);
    let featuredRunsForNewcomer = 0;
    const history = simulate({
      products,
      runs: 48,
      onRun: (run, _ids, cat) => {
        if (run === 30) cat.set("late", { id: "late", isSoldOut: false, isNew: false, neverMove: false });
      },
    });
    for (let run = 31; run < 48; run++) {
      if ((history[run].late ?? 0) > (history[run - 1].late ?? 0)) featuredRunsForNewcomer++;
    }
    // At hourly volume a newcomer starting at 0 among products at ~3 turns
    // would take the top for 3 runs straight. Joined at the floor, it gets
    // at most one turn per cycle like everyone else.
    expect(featuredRunsForNewcomer).toBeLessThanOrEqual(2);
    const final = history.at(-1)!;
    const values = Object.entries(final).filter(([k]) => !k.startsWith("~")).map(([, v]) => v);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it("time on top as a new arrival is not counted as a rotation turn", () => {
    const products = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const history = simulate({
      products,
      runs: 10,
      onRun: (run, _ids, cat) => {
        // n1 is a new arrival for the first 6 runs, then its window ends.
        cat.set("n1", { id: "n1", isSoldOut: false, isNew: false, neverMove: false, newArrivalAt: run < 6 ? 1 : null });
      },
    });
    expect(history[5].n1).toBeUndefined(); // on top for 6 runs, no turns used
    // …and the four rotation slots behind it still went to rotation products.
    expect(Object.entries(history[5]).filter(([k]) => k.startsWith("p")).reduce((s, [, v]) => s + v, 0)).toBe(24);
    // After the window it joins rotation at the floor, like a newcomer.
    expect(history[6].n1).toBeGreaterThanOrEqual(0);
  });

  it("a pre-Update-2 partial map treats missing products as never featured (0), as before", () => {
    const counts = joinRotation({ a: 2, b: 1 }, ["a", "b", "c"]);
    expect(counts).toEqual({ a: 2, b: 1, c: 0 });
  });

  it("drops products that left the collection", () => {
    const counts = joinRotation(JSON.parse(serializeTurnCounts({ a: 1, gone: 5 })), ["a"]);
    expect(counts).toEqual({ a: 1 });
  });
});

describe("new-arrival window (Feature C inputs)", () => {
  const now = Date.UTC(2026, 10, 12, 12);
  const H = 3_600_000;
  const product = (id: string, createdHoursAgo: number): ShopifyProductSummary => ({
    id: `gid://shopify/Product/${id}`,
    title: id,
    createdAt: new Date(now - createdHoursAgo * H).toISOString(),
    totalInventory: 5,
    tracksInventory: true,
    tags: [],
  });
  const seen = (id: string, hoursAgo: number, baseline = false, createdHoursAgo?: number): SeenRow => ({
    productId: id,
    firstSeenAt: new Date(now - hoursAgo * H),
    baseline,
    productCreatedAt: createdHoursAgo != null ? new Date(now - createdHoursAgo * H) : null,
  });
  const config = {
    pins: 0,
    pushSoldOutToEnd: true,
    boostNewArrivals: false,
    giveEveryoneATurn: true,
    newArrivalDays: 14,
    turnCounts: "{}",
    priorityBoostIds: "[]",
    keepNewOnTop: true,
    newOnTopHours: 48,
  };

  it("an added product is new for the chosen window from when it was first seen, then joins rotation", () => {
    const products = [product("1", 1000), product("2", 1000)];
    const build = (seenRows: SeenRow[]) =>
      buildShuffleInputs({ config, products, currentOrder: products.map((p) => p.id), neverMoveTags: new Set(), now, seen: seenRows, newArrivalsAllowed: true });
    // Product 1 is an old product added to this collection 47h ago: new.
    expect(build([seen("1", 47)]).productsById.get("gid://shopify/Product/1")!.newArrivalAt).not.toBeNull();
    // 49h ago: the 48h window has ended.
    expect(build([seen("1", 49)]).productsById.get("gid://shopify/Product/1")!.newArrivalAt).toBeNull();
  });

  it("baseline products fall back to createdAt", () => {
    expect(arrivalTime(product("1", 10), seen("1", 0, true, 10))).toBe(now - 10 * H);
    const products = [product("1", 10), product("2", 500)];
    const r = buildShuffleInputs({
      config,
      products,
      currentOrder: products.map((p) => p.id),
      neverMoveTags: new Set(),
      now,
      seen: [seen("1", 0, true, 10), seen("2", 0, true, 500)],
      newArrivalsAllowed: true,
    });
    expect(r.productsById.get("gid://shopify/Product/1")!.newArrivalAt).toBe(now - 10 * H); // created 10h ago: new
    expect(r.productsById.get("gid://shopify/Product/2")!.newArrivalAt).toBeNull(); // created 3 weeks ago: not
  });

  it("is off when the plan doesn't include it, whatever the stored flag says", () => {
    const products = [product("1", 1)];
    const r = buildShuffleInputs({ config, products, currentOrder: [products[0].id], neverMoveTags: new Set(), now, seen: [seen("1", 1)], newArrivalsAllowed: false });
    expect(r.options.keepNewOnTop).toBe(false);
    expect(r.productsById.get(products[0].id)!.newArrivalAt).toBeNull();
  });

  it("counts excluded (never-move tagged) products for the card", () => {
    const tagged = { ...product("1", 1), tags: ["Gift-Card"] };
    const r = buildShuffleInputs({ config, products: [tagged, product("2", 1)], currentOrder: [], neverMoveTags: new Set(["gift-card"]), now, seen: [], newArrivalsAllowed: true });
    expect(r.excludedCount).toBe(1);
  });
});
