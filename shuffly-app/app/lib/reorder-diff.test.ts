import { describe, expect, it } from "vitest";
import { applyMoves, diffToMoves, reorderCollectionProducts, type ReorderMove } from "./collections.server";

// Deterministic PRNG so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function permute(ids: string[], rand: () => number): string[] {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

/** O(n²) reference LIS length, independent of the implementation's. */
function lisLength(current: string[], target: string[]): number {
  const pos = new Map(target.map((id, i) => [id, i]));
  const seq = current.map((id) => pos.get(id)!);
  const best = seq.map(() => 1);
  for (let i = 0; i < seq.length; i++) for (let j = 0; j < i; j++) if (seq[j] < seq[i]) best[i] = Math.max(best[i], best[j] + 1);
  return Math.max(0, ...best);
}

describe("Shopify's newPosition semantics (applyMoves)", () => {
  it("matches the documented example: E→1 then C→4 on [A..E] gives [A,E,B,D,C]", () => {
    // From the collectionReorderProducts docs, Admin API 2026-07.
    const moves: ReorderMove[] = [
      { id: "E", newPosition: "1" },
      { id: "C", newPosition: "4" },
    ];
    expect(applyMoves(["A", "B", "C", "D", "E"], moves)).toEqual(["A", "E", "B", "D", "C"]);
  });

  it("each newPosition is read against the order left by the earlier moves", () => {
    // The same two moves in the opposite order land somewhere else — which is
    // why a move list must never be re-ordered, split out of order, or sent
    // in parallel chunks.
    const moves: ReorderMove[] = [
      { id: "D", newPosition: "0" },
      { id: "C", newPosition: "1" },
    ];
    const forward = applyMoves(["A", "B", "C", "D"], moves);
    const reversed = applyMoves(["A", "B", "C", "D"], moves.slice().reverse());
    expect(forward).toEqual(["D", "C", "A", "B"]);
    expect(reversed).toEqual(["D", "A", "C", "B"]);
    expect(reversed).not.toEqual(forward);
  });

  it("a position at or past the end means last", () => {
    expect(applyMoves(["A", "B", "C"], [{ id: "A", newPosition: "999999" }])).toEqual(["B", "C", "A"]);
    expect(applyMoves(["A", "B", "C"], [{ id: "A", newPosition: "2" }])).toEqual(["B", "C", "A"]);
  });
});

describe("diffToMoves — only move what changes", () => {
  it("one product from the top to the bottom is one move, not n−1", () => {
    const current = ids(1000);
    const target = [...current.slice(1), current[0]];
    const moves = diffToMoves(current, target);
    expect(moves).toEqual([{ id: "p0", newPosition: "999" }]);
    expect(applyMoves(current, moves)).toEqual(target);
  });

  it("one product from the bottom to the top is one move", () => {
    const current = ids(1000);
    const target = [current[999], ...current.slice(0, 999)];
    expect(diffToMoves(current, target)).toEqual([{ id: "p999", newPosition: "0" }]);
  });

  it("an adjacent swap is one move", () => {
    expect(diffToMoves(["a", "b", "c", "d"], ["a", "c", "b", "d"])).toHaveLength(1);
  });

  it("a full reversal needs n−1 moves (the minimum)", () => {
    const current = ids(50);
    const moves = diffToMoves(current, current.slice().reverse());
    expect(moves).toHaveLength(49);
    expect(applyMoves(current, moves)).toEqual(current.slice().reverse());
  });

  it("50 new products appended, then pulled to the top: 50 moves", () => {
    const current = ids(1050); // p1000..p1049 were just imported at the end
    const target = [...current.slice(1000), ...current.slice(0, 1000)];
    const moves = diffToMoves(current, target);
    expect(moves).toHaveLength(50);
    expect(applyMoves(current, moves)).toEqual(target);
  });

  it("random permutations: always reproduces the target with exactly n − LIS moves", () => {
    const rand = rng(42);
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 200);
      const current = permute(ids(n), rand);
      // Mix of near-sorted (hourly re-runs move little) and full shuffles.
      const target =
        trial % 2 === 0
          ? permute(current, rand)
          : current.map((id, i, a) => (rand() < 0.05 ? a[(i + 1) % n] : id)).filter((id, i, a) => a.indexOf(id) === i);
      const fullTarget = [...target, ...current.filter((id) => !target.includes(id))];
      const moves = diffToMoves(current, fullTarget);
      expect(applyMoves(current, moves)).toEqual(fullTarget);
      expect(moves).toHaveLength(n - lisLength(current, fullTarget));
    }
  });

  it("ignores ids that aren't in the collection and duplicate target ids", () => {
    const moves = diffToMoves(["a", "b", "c"], ["c", "ghost", "a", "c", "b"]);
    expect(applyMoves(["a", "b", "c"], moves)).toEqual(["c", "a", "b"]);
  });
});

describe("batches of 250, applied in sequence", () => {
  it("a 1,000-product shuffle split into 250-move chunks, each applied after the last, reaches the target", () => {
    const rand = rng(7);
    const current = ids(1000);
    const target = permute(current, rand);
    const moves = diffToMoves(current, target);
    expect(moves.length).toBeGreaterThan(250);
    let order = current;
    for (let i = 0; i < moves.length; i += 250) order = applyMoves(order, moves.slice(i, i + 250));
    expect(order).toEqual(target);
  });

  it("sends the chunks in order and waits for each job — the last one included — before the next call", async () => {
    const rand = rng(9);
    const current = ids(1000);
    const target = permute(current, rand);
    const moves = diffToMoves(current, target);

    // A fake Shopify that really applies each chunk, but only once its job is
    // polled as done — so sending a chunk before the previous job finished
    // would compute against the wrong order and fail the final assertion.
    let order = current;
    let pending: ReorderMove[] | null = null;
    const log: string[] = [];
    const admin = {
      graphql: async (query: string, opts?: { variables: { moves?: ReorderMove[] } }) => {
        if (query.includes("collectionReorderProducts")) {
          expect(pending).toBeNull(); // the previous job must have completed
          pending = opts!.variables.moves!;
          log.push(`send:${pending.length}`);
          return { json: async () => ({ data: { collectionReorderProducts: { job: { id: "j", done: false }, userErrors: [] } } }) };
        }
        order = applyMoves(order, pending!);
        pending = null;
        log.push("done");
        return { json: async () => ({ data: { job: { id: "j", done: true } } }) };
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    const result = await reorderCollectionProducts(admin as any, "gid://shopify/Collection/9", moves);
    expect(result.ok).toBe(true);
    expect(order).toEqual(target);
    expect(log.at(-1)).toBe("done"); // the final job was waited for too
    expect(log.filter((l) => l.startsWith("send")).every((l, i, a) => i === a.length - 1 || l === "send:250")).toBe(true);
  });
});
