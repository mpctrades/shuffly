import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({ default: {} }));

import { groupRows } from "./activity.server";
import { makeT } from "../i18n";

const now = new Date("2026-11-12T15:00:00Z");
type Row = Parameters<typeof groupRows>[0][number];

function run(over: Partial<Row>): Row {
  return {
    id: Math.random().toString(36).slice(2),
    shop: "s",
    collectionId: "c1",
    collection: { title: "New Arrivals" },
    collectionTitle: null,
    trigger: "SCHEDULED",
    status: "OK",
    movedCount: 12,
    pinnedCount: 0,
    soldOutCount: 0,
    durationMs: 4000,
    message: null,
    noMoveReason: null,
    messageCode: null,
    messageParams: null,
    previousOrder: "z1:x",
    batchId: null,
    createdAt: now,
    ...over,
  } as unknown as Row;
}

describe("Activity — Update 2 messages", () => {
  it("logs the new-products trigger with its count, undoable", () => {
    const [item] = groupRows([run({ trigger: "NEW_PRODUCTS", messageCode: "NEW_PRODUCTS", messageParams: '{"added":12}' })], "UTC", now);
    expect(item.title).toBe("New Arrivals — Triggered by new products (12 added)");
    expect(item.restore).not.toBeNull();
  });

  it("…and in French", () => {
    const [item] = groupRows(
      [run({ trigger: "NEW_PRODUCTS", messageCode: "NEW_PRODUCTS", messageParams: '{"added":12}' })],
      "UTC",
      now,
      makeT("fr"),
    );
    expect(item.title).toBe("New Arrivals — Déclenché par de nouveaux produits (12 ajoutés)");
  });

  it("a skipped slot inside a sweep is its own line, not a 0-moved batch member", () => {
    const items = groupRows(
      [
        run({ batchId: "b1", collectionId: "c1" }),
        run({ batchId: "b1", collectionId: "c2", collection: { id: "c2", title: "Jazz" }, status: "SKIPPED", movedCount: 0, messageCode: "SKIPPED_IN_PROGRESS", previousOrder: null }),
      ],
      "UTC",
      now,
    );
    expect(items.map((i) => i.title)).toContain("Jazz — Skipped — previous run still in progress");
    expect(items).toHaveLength(2);
  });

  it("names a sort pause and a plan downgrade", () => {
    const items = groupRows(
      [
        run({ status: "FAILED", movedCount: 0, messageCode: "PAUSED_SORT", previousOrder: null }),
        run({
          trigger: "SCHEDULE_CHANGED",
          messageCode: "PLAN_DOWNGRADE",
          previousOrder: null,
          messageParams: JSON.stringify({ plan: "STARTER", from: { type: "INTERVAL", intervalHours: 1 }, to: { type: "DAILY", time: "14:30" }, keepNewOnTopOff: true }),
        }),
      ],
      "UTC",
      now,
    );
    expect(items[0].title).toBe("New Arrivals — Paused — sort order changed");
    expect(items[1].title).toBe("New Arrivals — Changed for the Starter plan");
    expect(items[1].meta).toContain("every hour → daily at 14:30");
  });
});
