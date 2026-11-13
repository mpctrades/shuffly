import { describe, expect, it, vi } from "vitest";
import {
  diffToMoves,
  mapWithLimit,
  packProductIds,
  reorderCollectionProducts,
  sortOrderLabel,
  unpackProductIds,
} from "./collections.server";

/** Apply moves the same way collectionReorderProducts documents: remove
 * then reinsert at newPosition, applied sequentially in order. Used to
 * check that diffToMoves' output actually produces targetOrder, not just
 * that the moves "look plausible". */
function applyMoves(currentOrder: string[], moves: Array<{ id: string; newPosition: string }>): string[] {
  const working = currentOrder.slice();
  for (const move of moves) {
    const from = working.indexOf(move.id);
    if (from === -1) continue;
    working.splice(from, 1);
    working.splice(Number(move.newPosition), 0, move.id);
  }
  return working;
}

describe("diffToMoves", () => {
  it("emits no moves when the order is already correct", () => {
    const order = ["a", "b", "c"];
    expect(diffToMoves(order, order)).toEqual([]);
  });

  it("produces a move list that actually reproduces the target order", () => {
    const current = ["a", "b", "c", "d", "e"];
    const target = ["c", "a", "e", "b", "d"];
    const moves = diffToMoves(current, target);
    expect(applyMoves(current, moves)).toEqual(target);
  });

  it("handles a full reversal", () => {
    const current = ["a", "b", "c", "d"];
    const target = ["d", "c", "b", "a"];
    const moves = diffToMoves(current, target);
    expect(applyMoves(current, moves)).toEqual(target);
  });

  it("handles a single swap with a minimal move list", () => {
    const current = ["a", "b", "c"];
    const target = ["b", "a", "c"];
    const moves = diffToMoves(current, target);
    expect(applyMoves(current, moves)).toEqual(target);
    expect(moves.length).toBeLessThanOrEqual(2);
  });

  it("produces newPosition as a string, matching the mutation's expected input type", () => {
    const moves = diffToMoves(["a", "b"], ["b", "a"]);
    for (const m of moves) {
      expect(typeof m.newPosition).toBe("string");
    }
  });

  it("does nothing with empty arrays", () => {
    expect(diffToMoves([], [])).toEqual([]);
  });
});

describe("sortOrderLabel", () => {
  it("maps known Shopify sort order values to human labels", () => {
    expect(sortOrderLabel("BEST_SELLING")).toBe("Best selling");
    expect(sortOrderLabel("MANUAL")).toBe("Manual");
    expect(sortOrderLabel("CREATED_DESC")).toBe("Date created, new to old");
  });

  it("falls back to the raw value for an unrecognized sort order instead of throwing", () => {
    expect(sortOrderLabel("SOME_FUTURE_VALUE")).toBe("SOME_FUTURE_VALUE");
  });
});

// ---------------------------------------------------------------------------
// reorderCollectionProducts: 250-move chunking, per-collection serialization,
// and the TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS retry.
// ---------------------------------------------------------------------------

interface FakeCall {
  kind: "reorder" | "poll";
  moveCount: number;
}

/** Minimal stand-in for AdminApiContext — just enough `graphql` to drive the
 * reorder path, recording what it was actually asked to send. */
function fakeAdmin(options: { userErrors?: () => Array<{ message: string; code?: string }> } = {}) {
  const calls: FakeCall[] = [];
  let reorderCallCount = 0;
  const admin = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a hand-rolled test double for one method of AdminApiContext
    graphql: async (query: string, opts?: any): Promise<any> => {
      if (query.includes("collectionReorderProducts")) {
        reorderCallCount++;
        calls.push({ kind: "reorder", moveCount: opts?.variables?.moves?.length ?? 0 });
        const userErrors = options.userErrors?.() ?? [];
        return {
          json: async () => ({
            data: { collectionReorderProducts: { job: { id: "gid://shopify/Job/1", done: true }, userErrors } },
          }),
        };
      }
      calls.push({ kind: "poll", moveCount: 0 });
      return { json: async () => ({ data: { job: { id: "gid://shopify/Job/1", done: true } } }) };
    },
  };
  return { admin, calls, reorderCalls: () => reorderCallCount };
}

function movesOfLength(n: number): Array<{ id: string; newPosition: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `gid://shopify/Product/${i}`, newPosition: String(i) }));
}

describe("reorderCollectionProducts", () => {
  it("sends nothing at all when there are no moves", async () => {
    const { admin, calls } = fakeAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    const result = await reorderCollectionProducts(admin as any, "gid://shopify/Collection/1", []);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("sends a sub-250 reorder as a single call", async () => {
    const { admin, reorderCalls } = fakeAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    const result = await reorderCollectionProducts(admin as any, "gid://shopify/Collection/1", movesOfLength(250));
    expect(result.ok).toBe(true);
    expect(reorderCalls()).toBe(1);
  });

  it("chunks a reorder larger than Shopify's 250-move cap", async () => {
    const { admin, calls } = fakeAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    const result = await reorderCollectionProducts(admin as any, "gid://shopify/Collection/1", movesOfLength(600));
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "reorder").map((c) => c.moveCount)).toEqual([250, 250, 100]);
  });

  it("serializes two concurrent reorders of the same collection", async () => {
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    const admin: any = {
      graphql: async (query: string) => {
        if (query.includes("collectionReorderProducts")) {
          order.push("start");
          await new Promise((r) => setTimeout(r, 5));
          order.push("end");
          return {
            json: async () => ({
              data: { collectionReorderProducts: { job: { id: "j", done: true }, userErrors: [] } },
            }),
          };
        }
        return { json: async () => ({ data: { job: { id: "j", done: true } } }) };
      },
    };
    await Promise.all([
      reorderCollectionProducts(admin, "gid://shopify/Collection/1", movesOfLength(1)),
      reorderCollectionProducts(admin, "gid://shopify/Collection/1", movesOfLength(1)),
    ]);
    // Never interleaved: each reorder finishes before the next one starts.
    expect(order).toEqual(["start", "end", "start", "end"]);
  });

  it("lets reorders of different collections overlap", async () => {
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    const admin: any = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      graphql: async (query: string, opts?: any) => {
        if (query.includes("collectionReorderProducts")) {
          const tag = opts.variables.id.slice(-1);
          order.push(`start${tag}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end${tag}`);
          return {
            json: async () => ({
              data: { collectionReorderProducts: { job: { id: "j", done: true }, userErrors: [] } },
            }),
          };
        }
        return { json: async () => ({ data: { job: { id: "j", done: true } } }) };
      },
    };
    await Promise.all([
      reorderCollectionProducts(admin, "gid://shopify/Collection/1", movesOfLength(1)),
      reorderCollectionProducts(admin, "gid://shopify/Collection/2", movesOfLength(1)),
    ]);
    expect(order.slice(0, 2)).toEqual(["start1", "start2"]);
  });

  it("surfaces Shopify's error code, and does not retry a non-transient one", async () => {
    const { admin, reorderCalls } = fakeAdmin({
      userErrors: () => [
        { message: "Can't reorder products unless collection is manually sorted.", code: "MANUALLY_SORTED_COLLECTION" },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
    const result = await reorderCollectionProducts(admin as any, "gid://shopify/Collection/1", movesOfLength(1));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MANUALLY_SORTED_COLLECTION");
    expect(reorderCalls()).toBe(1);
  });

  it("retries TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS and succeeds once the earlier job clears", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { admin, reorderCalls } = fakeAdmin({
        userErrors: () => {
          attempts++;
          return attempts === 1
            ? [{ message: "Products are currently being reordered. Please try again later.", code: "TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS" }]
            : [];
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      const pending = reorderCollectionProducts(admin as any, "gid://shopify/Collection/1", movesOfLength(1));
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(reorderCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after exhausting the retry budget", async () => {
    vi.useFakeTimers();
    try {
      const { admin, reorderCalls } = fakeAdmin({
        userErrors: () => [
          { message: "Products are currently being reordered. Please try again later.", code: "TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS" },
        ],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      const pending = reorderCollectionProducts(admin as any, "gid://shopify/Collection/1", movesOfLength(1));
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.code).toBe("TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS");
      // Initial attempt + three backoff retries.
      expect(reorderCalls()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Adding any collection: the snapshot format and the batch limiter.
// ---------------------------------------------------------------------------

describe("packProductIds / unpackProductIds", () => {
  it("round-trips product gids", () => {
    const gids = ["gid://shopify/Product/1", "gid://shopify/Product/22", "gid://shopify/Product/333"];
    expect(unpackProductIds(packProductIds(gids))).toEqual(gids);
  });

  it("preserves order, which is the entire point of the snapshot", () => {
    const gids = ["gid://shopify/Product/9", "gid://shopify/Product/3", "gid://shopify/Product/7"];
    expect(unpackProductIds(packProductIds(gids))).toEqual(gids);
  });

  it("stores bare numeric ids, not the full gid", () => {
    expect(packProductIds(["gid://shopify/Product/42"])).toBe('["42"]');
  });

  it("is dramatically smaller than storing gids", () => {
    const gids = Array.from({ length: 500 }, (_, i) => `gid://shopify/Product/${1000000 + i}`);
    expect(packProductIds(gids).length).toBeLessThan(JSON.stringify(gids).length / 3);
  });

  it("treats a missing or corrupt snapshot as no snapshot, never throwing", () => {
    expect(unpackProductIds(null)).toEqual([]);
    expect(unpackProductIds("")).toEqual([]);
    expect(unpackProductIds("not json")).toEqual([]);
    expect(unpackProductIds('{"not":"an array"}')).toEqual([]);
  });
});

describe("mapWithLimit", () => {
  it("returns results in input order regardless of completion order", async () => {
    const out = await mapWithLimit([30, 10, 20, 0], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 0]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("actually runs concurrently rather than serially", async () => {
    const started = Date.now();
    await mapWithLimit(Array.from({ length: 8 }, (_, i) => i), 4, async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // Eight 20ms tasks, four at a time: ~40ms, not the ~160ms of a serial run.
    expect(Date.now() - started).toBeLessThan(140);
  });

  it("handles an empty batch without spawning workers", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });

  it("propagates a rejection so a caller can report the failure by name", async () => {
    await expect(
      mapWithLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("switch failed");
        return n;
      }),
    ).rejects.toThrow("switch failed");
  });
});
