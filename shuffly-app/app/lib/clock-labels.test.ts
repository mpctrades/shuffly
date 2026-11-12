import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clockTime, dayRelativeClockLabel } from "./clock-labels";

// The live case from the dev store on 2026-11-12: shop in America/New_York,
// next run stored as 11:00 UTC (= 06:00 EST), viewed from a laptop at UTC+7.
const NEXT_RUN = new Date("2026-11-12T11:00:00Z");
const NOW = new Date("2026-11-12T08:23:00Z"); // 03:23 in New York
const SHOP_TZ = "America/New_York";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

describe("next/last run labels are in the shop's timezone", () => {
  it("reads 06:00 for the real 06:00 New York run", () => {
    expect(clockTime(NEXT_RUN, SHOP_TZ)).toBe("06:00");
    expect(dayRelativeClockLabel(NEXT_RUN, SHOP_TZ, NOW)).toBe("today at 06:00");
  });

  it("gives the same answer whatever timezone the code runs in (server UTC, browser UTC+7)", () => {
    for (const runtimeTz of ["UTC", "Asia/Phnom_Penh", "Pacific/Kiritimati"]) {
      process.env.TZ = runtimeTz;
      expect(dayRelativeClockLabel(NEXT_RUN, SHOP_TZ, NOW)).toBe("today at 06:00");
    }
  });

  it("documents the bug: a formatter with no timeZone shows the viewer's clock", () => {
    process.env.TZ = "Asia/Phnom_Penh";
    const buggy = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(NEXT_RUN);
    expect(buggy).toBe("18:00");
  });

  it("names the day in the shop's timezone, not 'today' for everything", () => {
    // Monday 16 Nov 06:00 New York, seen on Thursday 12 Nov.
    expect(dayRelativeClockLabel(new Date("2026-11-16T11:00:00Z"), SHOP_TZ, NOW)).toBe("11/16 at 06:00");
    expect(dayRelativeClockLabel(new Date("2026-11-13T11:00:00Z"), SHOP_TZ, NOW)).toBe("tomorrow at 06:00");
    // 01:00 UTC on the 13th is still the evening of the 12th in New York.
    expect(dayRelativeClockLabel(new Date("2026-11-13T01:00:00Z"), SHOP_TZ, NOW)).toBe("today at 20:00");
  });
});

describe("guard: no date formatting in app/ without an explicit timezone", () => {
  // Every user-facing time in Shuffly is a shop-local wall clock. A
  // formatter without `timeZone` silently uses the runtime's (UTC on the
  // server, the viewer's in the browser) — the cause of the 06:00/18:00 bug.
  const ALLOWED = new Set([
    // A Shopify billing date shown on the Plan page; not a schedule time.
    "app/lib/billing.server.ts",
  ]);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("every Intl.DateTimeFormat / toLocale*String call names a timeZone", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("app")) {
      if (ALLOWED.has(file)) continue;
      const src = readFileSync(file, "utf8");
      const calls = /new Intl\.DateTimeFormat\(|\.toLocale(?:Date|Time)?String\(/g;
      for (let m; (m = calls.exec(src)); ) {
        // A mention in a comment isn't a call.
        const lineStart = src.lastIndexOf("\n", m.index) + 1;
        if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, m.index))) continue;
        // The call's own arguments: up to the matching close paren.
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < src.length && depth > 0) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")") depth--;
          i++;
        }
        const args = src.slice(m.index + m[0].length, i);
        if (!/timeZone/.test(args)) {
          offenders.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
