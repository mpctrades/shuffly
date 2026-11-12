// Brief §10: "Starter merchant cannot select Pro frequencies (UI and API)".
// The UI half is greyed options; this is the API half — hand-rolled POSTs
// straight to every route action that writes a schedule, from a Starter
// shop, must be refused with nothing written.
//
// Lives in lib/ for the reason settings-save.server.test.ts gives.
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  getOrCreateShopSettings: vi.fn(),
  writes: [] as string[],
}));

vi.mock("../shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
  unauthenticated: { admin: vi.fn() },
}));

vi.mock("../db.server", () => {
  const write = (name: string) => vi.fn(async () => {
    mocks.writes.push(name);
    return {};
  });
  return {
    default: {
      shopSettings: { update: write("shopSettings.update"), findUnique: vi.fn() },
      collectionConfig: {
        findMany: vi.fn(async () => [{ id: "c1", shop: "s.myshopify.com", status: "RUNNING", scheduleType: null }]),
        findFirst: vi.fn(async () => ({ id: "c1", shop: "s.myshopify.com", status: "RUNNING", scheduleType: null })),
        update: write("collectionConfig.update"),
        updateMany: write("collectionConfig.updateMany"),
      },
      shuffleRun: { create: write("shuffleRun.create") },
      $transaction: write("$transaction"),
    },
  };
});

vi.mock("./shop-context.server", () => ({
  getOrCreateShopSettings: mocks.getOrCreateShopSettings,
  confirmShopTimezone: vi.fn().mockResolvedValue({ timezone: "UTC", error: null }),
}));

import { action as collectionsAction } from "../routes/app.collections";
import { action as workspaceAction } from "../routes/app.collections.$id";
import { action as settingsAction } from "../routes/app.settings";

function post(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://app.example/app/x", { method: "POST", body });
}

function shopOn(plan: string) {
  mocks.getOrCreateShopSettings.mockResolvedValue({
    shop: "s.myshopify.com",
    plan,
    timezone: "UTC",
    defaultScheduleType: "DAILY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: null,
  });
}

async function status(res: unknown): Promise<number> {
  // React Router's data() wraps the init; a thrown Response has .status.
  const r = res as { init?: { status?: number }; status?: number };
  return r.init?.status ?? r.status ?? 200;
}

const hourly = { scheduleType: "INTERVAL", intervalHours: "1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writes.length = 0;
  mocks.authenticateAdmin.mockResolvedValue({ admin: {}, session: { shop: "s.myshopify.com" } });
});

describe("a Starter shop posting an hourly schedule", () => {
  beforeEach(() => shopOn("STARTER"));

  it("is refused by the collections list (per-collection / bulk)", async () => {
    const res = await collectionsAction({ request: post({ _action: "set-schedule", id: "c1", ...hourly }), params: {} } as unknown as ActionFunctionArgs);
    expect(await status(res)).toBe(403);
    expect(mocks.writes).toEqual([]);
  });

  it("is refused as the shop default from the collections list", async () => {
    const res = await collectionsAction({ request: post({ _action: "set-shop-default", ...hourly }), params: {} } as unknown as ActionFunctionArgs);
    expect(await status(res)).toBe(403);
    expect(mocks.writes).toEqual([]);
  });

  it("is refused by the collection Workspace", async () => {
    const res = await workspaceAction({ request: post({ _action: "set-schedule", ...hourly }), params: { id: "c1" } } as unknown as ActionFunctionArgs);
    expect(await status(res)).toBe(403);
    expect(mocks.writes).toEqual([]);
  });

  it("is refused as the shop default from Settings", async () => {
    const res = await settingsAction({ request: post({ _action: "set-shop-default", ...hourly }), params: {} } as unknown as ActionFunctionArgs);
    expect(await status(res)).toBe(403);
    expect(mocks.writes).toEqual([]);
  });
});

describe("a Pro shop", () => {
  beforeEach(() => shopOn("PRO"));

  it("may set every hour", async () => {
    const res = await workspaceAction({ request: post({ _action: "set-schedule", ...hourly }), params: { id: "c1" } } as unknown as ActionFunctionArgs);
    expect(await status(res)).toBe(200);
    expect(mocks.writes).toContain("collectionConfig.update");
  });

  it("still can't go faster than hourly", async () => {
    const res = await workspaceAction({
      request: post({ _action: "set-schedule", scheduleType: "INTERVAL", intervalHours: "0.25" }),
      params: { id: "c1" },
    } as unknown as ActionFunctionArgs);
    expect(await status(res)).toBe(400);
    expect(mocks.writes).toEqual([]);
  });
});
