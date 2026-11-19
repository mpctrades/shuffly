import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({ default: {} }));

import { giniCoefficient } from "./insights.server";

/** The original O(n²) definition, kept here as the reference. */
function pairwiseGini(values: number[]): number {
  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  if (n === 0 || sum === 0) return 0;
  let sumAbsDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) sumAbsDiff += Math.abs(values[i] - values[j]);
  }
  return sumAbsDiff / (2 * n * sum);
}

describe("giniCoefficient", () => {
  it("is 0 for an even spread and for no turns at all", () => {
    expect(giniCoefficient([3, 3, 3, 3])).toBe(0);
    expect(giniCoefficient([0, 0, 0])).toBe(0);
    expect(giniCoefficient([])).toBe(0);
  });

  it("approaches 1 when one product has every turn", () => {
    expect(giniCoefficient([0, 0, 0, 10])).toBeCloseTo(0.75, 10);
  });

  it("matches the pairwise definition on random turn counts", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 50; trial++) {
      const values = Array.from({ length: 1 + Math.floor(rand() * 300) }, () => Math.floor(rand() * 20));
      expect(giniCoefficient(values)).toBeCloseTo(pairwiseGini(values), 10);
    }
  });
});
