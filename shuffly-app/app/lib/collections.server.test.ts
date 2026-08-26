import { describe, expect, it } from "vitest";
import { diffToMoves, sortOrderLabel } from "./collections.server";

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
