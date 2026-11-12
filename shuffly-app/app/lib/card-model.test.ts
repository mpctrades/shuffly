import { describe, expect, it } from "vitest";
import { makeT, normalizeLang, translatePlural } from "../i18n";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { cadenceOf, describeNoticeSchedule, formatDuration, frequencyOptions, hasPresetApplied, looksLikeNewArrivals } from "./card-model";

const t = makeT("en");
const enabled = (plan: string, current = "DAILY") =>
  frequencyOptions(plan, current, t).filter((o) => !o.disabled).map((o) => o.value);
const locked = (plan: string) =>
  Object.fromEntries(frequencyOptions(plan, "WEEKLY", t).filter((o) => o.disabled).map((o) => [o.value, o.lockedTo]));

describe("Frequency dropdown gating (brief §4, prompt decisions)", () => {
  it("lists the brief's options in order", () => {
    expect(frequencyOptions("PRO", "DAILY", t).map((o) => o.label)).toEqual([
      "Every hour",
      "Every 2 hours",
      "Every 3 hours",
      "Every 4 hours",
      "Every 6 hours",
      "Every 12 hours",
      "Daily",
      "Weekly",
      "Only when I press Shuffle",
    ]);
  });

  it("Free: Weekly selectable; Daily greyed with a Starter badge; hourly greyed with a Pro badge", () => {
    expect(enabled("FREE")).toEqual(["WEEKLY", "MANUAL"]);
    expect(locked("FREE")).toMatchObject({ DAILY: "Starter", "INTERVAL:1": "Pro", "INTERVAL:12": "Pro" });
    expect(frequencyOptions("FREE", "WEEKLY", t).find((o) => o.value === "DAILY")?.label).toBe("Daily — Starter");
  });

  it("Starter: Daily and Weekly selectable; hourly greyed with a Pro badge", () => {
    expect(enabled("STARTER")).toEqual(["DAILY", "WEEKLY", "MANUAL"]);
    expect(frequencyOptions("STARTER", "DAILY", t)[0]).toMatchObject({ label: "Every hour — Pro", disabled: true });
  });

  it("Pro: everything selectable, unlimited down to every hour", () => {
    expect(enabled("PRO")).toHaveLength(9);
  });

  it("a legacy twice-daily schedule shows as 'Twice daily (current)' only while selected", () => {
    expect(frequencyOptions("PRO", "TWICE_DAILY", t).some((o) => o.label === "Twice daily (current)")).toBe(true);
    expect(frequencyOptions("PRO", "DAILY", t).some((o) => o.value === "TWICE_DAILY")).toBe(false);
  });

  it("maps schedules to dropdown values", () => {
    expect(cadenceOf({ scheduleType: "INTERVAL", intervalHours: 6 })).toBe("INTERVAL:6");
    expect(cadenceOf({ scheduleType: "WEEKLY" })).toBe("WEEKLY");
  });
});

describe("New arrivals preset suggestion", () => {
  it("shows the banner for titles containing new / nouveau / arrival / latest, any case", () => {
    for (const title of ["New Arrivals", "NOUVEAUTÉS vinyles", "Latest pressings", "Just arrived? arrivals", "newest"]) {
      expect(looksLikeNewArrivals(title)).toBe(true);
    }
    expect(looksLikeNewArrivals("Jazz LPs")).toBe(false);
  });

  it("knows when the preset is already in place", () => {
    expect(hasPresetApplied({ cadence: "INTERVAL:2", reshuffleOnNew: true, keepNewOnTop: true })).toBe(true);
    expect(hasPresetApplied({ cadence: "INTERVAL:2", reshuffleOnNew: false, keepNewOnTop: true })).toBe(false);
  });
});

describe("i18n", () => {
  it("French has every English key, and no empty strings", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    expect(Object.values(fr).every((v) => v.trim().length > 0)).toBe(true);
  });

  it("keeps the same {placeholders} in both languages", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(names(fr[key]), key).toBe(names(en[key]));
    }
  });

  it("uses each language's plural rules (French 0 and 1 are singular)", () => {
    expect(translatePlural("en", "card.products", 1)).toBe("1 product");
    expect(translatePlural("en", "card.products", 0)).toBe("0 products");
    expect(translatePlural("fr", "card.products", 0)).toBe("0 produit");
    expect(translatePlural("fr", "card.products", 1240)).toMatch(/^1\s240 produits$/);
  });

  it("detects the admin locale", () => {
    expect(normalizeLang("fr-CA")).toBe("fr");
    expect(normalizeLang("en-US")).toBe("en");
    expect(normalizeLang("de")).toBeNull();
  });

  it("formats the card's countdown and notice lines in French", () => {
    const tf = makeT("fr");
    expect(formatDuration(42 * 60_000, tf)).toBe("42 min");
    expect(formatDuration(185 * 60_000, tf)).toBe("3 h 5 min");
    expect(describeNoticeSchedule({ type: "DAILY", time: "14:30" }, tf)).toBe("tous les jours à 14:30");
    expect(describeNoticeSchedule({ type: "INTERVAL", intervalHours: 2 }, tf)).toBe("toutes les 2 heures");
  });
});
