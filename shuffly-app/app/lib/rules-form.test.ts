import { describe, expect, it } from "vitest";
import { rulesChanged } from "./rules-form";

const saved = { pins: 0, pushSoldOutToEnd: true, boostNewArrivals: false, giveEveryoneATurn: false };

describe("collection page Rules: unsaved changes", () => {
  it("a re-render that re-emits the same values is NOT an unsaved change (the Resume bug)", () => {
    expect(rulesChanged(saved, { ...saved })).toBe(false);
  });

  it("any real edit is", () => {
    expect(rulesChanged(saved, { ...saved, pins: 3 })).toBe(true);
    expect(rulesChanged(saved, { ...saved, pushSoldOutToEnd: false })).toBe(true);
    expect(rulesChanged(saved, { ...saved, boostNewArrivals: true })).toBe(true);
    expect(rulesChanged(saved, { ...saved, giveEveryoneATurn: true })).toBe(true);
  });

  it("an edit undone by hand clears it again", () => {
    const edited = { ...saved, pins: 2 };
    expect(rulesChanged(saved, edited)).toBe(true);
    expect(rulesChanged(saved, { ...edited, pins: 0 })).toBe(false);
  });
});
