import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionConfig, ShopSettings } from "@prisma/client";

// ---------------------------------------------------------------------------
// In-memory fakes: a tiny ProductSeen table, one collection row, and a
// Shopify collection whose contents each test controls.
// ---------------------------------------------------------------------------
const world = vi.hoisted(() => ({
  seen: new Map<string, { productId: string; baseline: boolean }>(),
  row: {} as Record<string, unknown>,
  shopify: { ids: [] as string[], sortOrder: "MANUAL" },
  runs: [] as Array<{ trigger: string; context: { messageParams?: { added?: number } } }>,
  apiCalls: [] as string[],
}));

vi.mock("../db.server", () => ({
  default: {
    productSeen: {
      findMany: async ({ where }: { where: { productId?: { in: string[] } } }) =>
        [...world.seen.values()].filter((r) => !where.productId || where.productId.in.includes(r.productId)),
      createMany: async ({ data }: { data: Array<{ productId: string; baseline: boolean }> }) => {
        for (const r of data) world.seen.set(r.productId, r);
      },
      deleteMany: async ({ where }: { where: { productId: { in: string[] } } }) => {
        for (const id of where.productId.in) world.seen.delete(id);
      },
    },
    collectionConfig: {
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(world.row, data),
      findUnique: async () => ({ ...world.row }),
    },
  },
}));
vi.mock("../shopify.server", () => ({ unauthenticated: { admin: vi.fn() } }));
vi.mock("./billing.server", () => ({ syncPlanFromAdmin: vi.fn() }));
vi.mock("./shuffle-engine.server", () => ({
  runShuffleForCollection: vi.fn(async (...args: unknown[]) => {
    world.runs.push({ trigger: args[5] as string, context: args[8] as { messageParams?: { added?: number } } });
    // A successful run clears the pending batch, as the real engine does.
    Object.assign(world.row, { newPendingSince: null, newPendingCount: 0 });
    return { ok: true, skipped: false };
  }),
}));

import {
  addDetections,
  decideTrigger,
  DEBOUNCE_MS,
  pollCollection,
  type TriggerState,
} from "./new-products.server";

const gid = (n: number) => `gid://shopify/Product/${n}`;
const T0 = new Date("2026-11-12T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

// A fake Admin client answering the two queries the poll uses.
const admin = {
  graphql: async (query: string) => {
    const ids = world.shopify.ids;
    if (query.includes("ShufflyNewProductsProbe")) {
      world.apiCalls.push("probe");
      // Newest-created first: higher numbers were created later.
      const newest = ids.slice().sort((a, b) => Number(b.split("/").pop()) - Number(a.split("/").pop())).slice(0, 50);
      return {
        json: async () => ({
          data: {
            collection: {
              sortOrder: world.shopify.sortOrder,
              productsCount: { count: ids.length },
              products: { nodes: newest.map((id) => ({ id, createdAt: T0.toISOString() })) },
            },
          },
        }),
      };
    }
    world.apiCalls.push("scan");
    return {
      json: async () => ({
        data: { collection: { products: { nodes: ids.map((id) => ({ id, createdAt: T0.toISOString() })), pageInfo: { hasNextPage: false } } } },
      }),
    };
  },
};

const settings = {
  timezone: "UTC",
  neverMoveTags: "",
  pageSize: 24,
  defaultScheduleType: "WEEKLY",
  defaultScheduleTime: "06:00",
  defaultScheduleTime2: null,
  defaultScheduleWeekday: 1,
} as unknown as ShopSettings;

function config(): CollectionConfig {
  return { ...world.row } as unknown as CollectionConfig;
}

async function poll(minutes: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
  return pollCollection(admin as any, "s.myshopify.com", config(), settings, at(minutes));
}

beforeEach(() => {
  world.seen.clear();
  world.runs = [];
  world.apiCalls = [];
  world.shopify = { ids: Array.from({ length: 1000 }, (_, i) => gid(i + 1)), sortOrder: "MANUAL" };
  world.row = {
    id: "c1",
    collectionGid: "gid://shopify/Collection/1",
    status: "RUNNING",
    reshuffleOnNew: true,
    // A weekly Monday-06:00 schedule: never "due within 15 minutes" here.
    scheduleType: "WEEKLY",
    scheduleTime: "06:00",
    scheduleTime2: null,
    scheduleWeekday: 1,
    newTrackingSince: null,
    newCheckLastAt: null,
    newCheckCount: null,
    newFullScanAt: null,
    newPendingSince: null,
    newPendingCount: 0,
    lastNewTriggerAt: null,
  };
});

// ---------------------------------------------------------------------------
describe("decideTrigger — debounce and limits", () => {
  const idle: TriggerState = { pendingSince: null, pendingCount: 0, lastTriggerAt: null };

  it("does nothing with nothing pending", () => {
    expect(decideTrigger(idle, T0, null)).toEqual({ action: "idle" });
  });

  it("waits 10 minutes from the first detection", () => {
    const s = addDetections(idle, 12, T0);
    expect(decideTrigger(s, at(9), null)).toEqual({ action: "wait", reason: "debounce" });
    expect(decideTrigger(s, at(10), null)).toEqual({ action: "run", added: 12 });
  });

  it("later detections join the batch without restarting the wait", () => {
    let s = addDetections(idle, 30, T0);
    s = addDetections(s, 20, at(5));
    expect(s.pendingSince).toEqual(T0);
    expect(decideTrigger(s, at(10), null)).toEqual({ action: "run", added: 50 });
  });

  it("at most once an hour", () => {
    const s = { ...addDetections(idle, 3, at(0)), lastTriggerAt: at(-30) };
    expect(decideTrigger(s, at(15), null)).toEqual({ action: "wait", reason: "hourly-limit" });
    expect(decideTrigger(s, at(30), null)).toEqual({ action: "run", added: 3 });
  });

  it("leaves it to a scheduled run due within 15 minutes", () => {
    const s = addDetections(idle, 5, T0);
    expect(decideTrigger(s, at(10), at(24))).toEqual({ action: "leave-to-schedule" });
    expect(decideTrigger(s, at(10), at(26))).toEqual({ action: "run", added: 5 });
  });
});

// ---------------------------------------------------------------------------
describe("polling a collection", () => {
  it("the first poll is a baseline: products already there aren't new", async () => {
    const r = await poll(0);
    expect(r).toMatchObject({ scanned: true, decision: "idle" });
    expect(world.seen.size).toBe(1000);
    expect([...world.seen.values()].every((s) => s.baseline)).toBe(true);
    expect(world.runs).toEqual([]);
  });

  it("50 products imported at once → exactly one reshuffle, after the 10-minute wait", async () => {
    await poll(0); // baseline
    world.shopify.ids.push(...Array.from({ length: 50 }, (_, i) => gid(5000 + i)));

    expect((await poll(15)).decision).toBe("wait"); // detected, waiting
    expect(world.row.newPendingCount).toBe(50);
    expect((await poll(20)).decision).toBe("wait"); // between polls: no Shopify call
    expect((await poll(25)).decision).toBe("run");
    expect(world.runs).toHaveLength(1);
    expect(world.runs[0]).toMatchObject({ trigger: "NEW_PRODUCTS", context: { messageParams: { added: 50 } } });

    // Nothing more happens on later polls.
    for (const m of [30, 45, 60, 75, 90]) await poll(m);
    expect(world.runs).toHaveLength(1);
  });

  it("an import that spans two polls is still one shuffle", async () => {
    await poll(0);
    world.shopify.ids.push(...Array.from({ length: 30 }, (_, i) => gid(6000 + i)));
    await poll(15);
    world.shopify.ids.push(...Array.from({ length: 20 }, (_, i) => gid(7000 + i)));
    await poll(30); // > 10 min since the first detection
    expect(world.runs).toHaveLength(1);
    expect(world.runs[0].context.messageParams?.added).toBe(50);
  });

  it("a swap (one added, one removed: same count) is detected by id", async () => {
    await poll(0);
    world.shopify.ids = [...world.shopify.ids.slice(1), gid(9000)];
    const r = await poll(15);
    expect(r.added).toBe(1);
  });

  it("an older product moved into the collection (not among the newest) is caught by the hourly full scan", async () => {
    await poll(0);
    // Product 1 leaves and an old product (-7, not among the 50 newest)
    // joins: count unchanged, newest-50 unchanged. Within the hour, no scan…
    world.shopify.ids = Array.from({ length: 999 }, (_, i) => gid(i + 2)).concat(gid(-7));
    const early = await poll(15);
    expect(early.scanned).toBe(false);
    const hourly = await poll(60);
    expect(hourly).toMatchObject({ scanned: true, added: 1 });
  });

  it("removals never trigger anything", async () => {
    await poll(0);
    world.shopify.ids = world.shopify.ids.slice(100);
    const r = await poll(15);
    expect(r.added).toBe(0);
    for (const m of [30, 45]) await poll(m);
    expect(world.runs).toEqual([]);
  });

  it("a quiet collection costs one cheap probe per poll, no full scan", async () => {
    await poll(0);
    world.apiCalls = [];
    await poll(15);
    await poll(30);
    expect(world.apiCalls).toEqual(["probe", "probe"]);
  });

  it("does nothing on a collection that's no longer on Manual sort", async () => {
    await poll(0);
    world.shopify.sortOrder = "BEST_SELLING";
    world.shopify.ids.push(gid(8000));
    expect((await poll(15)).decision).toBe("not-manual");
  });

  it("respects the 1-per-hour limit across two separate batches", async () => {
    await poll(0);
    world.shopify.ids.push(gid(10001));
    await poll(15);
    await poll(25); // run #1 at minute 25
    world.shopify.ids.push(gid(10002));
    await poll(30); // detected
    await poll(45); // > 10 min, but < 1 h since the last trigger
    expect(world.runs).toHaveLength(1);
    await poll(85); // an hour after minute 25
    expect(world.runs).toHaveLength(2);
  });
});

it("DEBOUNCE_MS is the brief's 10 minutes", () => {
  expect(DEBOUNCE_MS).toBe(10 * 60_000);
});
