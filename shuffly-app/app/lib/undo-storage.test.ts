import { describe, expect, it } from "vitest";
import { packUndoOrder, unpackUndoOrder } from "./collections.server";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 1,000 realistic product GIDs: 13-digit ids from a few years of a shop's
 * catalogue, in a shuffled (post-run) order. */
function realisticOrder(n: number, seed = 1): string[] {
  const rand = rng(seed);
  const ids = Array.from({ length: n }, () => 7_000_000_000_000 + Math.floor(rand() * 2_500_000_000_000));
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.map((id) => `gid://shopify/Product/${id}`);
}

describe("compact undo snapshots", () => {
  it("round-trips exactly, order preserved", () => {
    const order = realisticOrder(1000);
    expect(unpackUndoOrder(packUndoOrder(order))).toEqual(order);
  });

  it("still reads the JSON older runs stored", () => {
    const order = realisticOrder(5);
    expect(unpackUndoOrder(JSON.stringify(order))).toEqual(order);
    expect(unpackUndoOrder(null)).toEqual([]);
    expect(unpackUndoOrder("not json")).toEqual([]);
  });

  it("1,000 products x 24 runs/day x 30 days fits in a few MB per collection", () => {
    const order = realisticOrder(1000);
    const legacy = Buffer.byteLength(JSON.stringify(order));
    const compact = Buffer.byteLength(packUndoOrder(order));
    const perCollection30d = compact * 24 * 30;
    // Recorded in docs/update-2-plan.md.
    console.info(
      `[undo size] legacy ${(legacy / 1024).toFixed(1)} KB/run, compact ${(compact / 1024).toFixed(1)} KB/run, ` +
        `30 days hourly: ${(perCollection30d / 1024 / 1024).toFixed(1)} MB (was ${((legacy * 720) / 1024 / 1024).toFixed(1)} MB)`,
    );
    expect(compact).toBeLessThan(legacy / 3);
    expect(perCollection30d).toBeLessThan(8 * 1024 * 1024);
  });
});
