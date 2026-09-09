// Drives the Settings page's save path in CI instead of in a browser.
//
// Lives in lib/, not routes/, for the same reason the webhook route tests do:
// React Router's build treats everything under app/routes/ as part of the
// client graph, so a test file there drags vitest into the bundle and the
// production build fails outright.
//
// The browser automation failed to deliver clicks to this page three sessions
// running, so "does it actually save?" kept going unverified while the page
// looked correct — exactly what a screenshot cannot tell you. These tests
// take the form state a merchant would produce, build the submission with the
// same function the save bar uses, hand it to the real route action, and
// assert what reaches the database.
import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  getOrCreateShopSettings: vi.fn(),
  shopSettingsUpdate: vi.fn(),
  collectionFindMany: vi.fn(),
  collectionUpdate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));

vi.mock("../db.server", () => ({
  default: {
    shopSettings: { update: mocks.shopSettingsUpdate },
    collectionConfig: { findMany: mocks.collectionFindMany, update: mocks.collectionUpdate },
    $transaction: mocks.transaction,
  },
}));

vi.mock("./shop-context.server", () => ({
  getOrCreateShopSettings: mocks.getOrCreateShopSettings,
}));

// Only the loader touches this; stubbed so importing the route doesn't pull
// in the Admin GraphQL client.
vi.mock("./collections.server", () => ({
  getShopTimezone: vi.fn().mockResolvedValue("America/New_York"),
}));

// The route renders Polaris/App Bridge components. None of that runs in these
// tests, but the imports must not touch `window` at module load.
vi.mock("@shopify/app-bridge-react", () => ({ useAppBridge: () => ({}) }));

import { action } from "../routes/app.settings";
import { addTag, parseTags, removeTag, serializeTags, settingsSubmission } from "./settings-form";

const SHOP = "shuffly-test.myshopify.com";

/** Posts a form body to the route action, the way the save bar does.
 * The action returns react-router's `data()` wrapper rather than a Response,
 * so the payload is read off `.data`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DataWithResponseInit isn't exported
function post(fields: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(fields);
  const url = new URL("https://example.com/app/settings");
  return action({
    request: new Request(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    url,
    pattern: "/app/settings",
    params: {},
    context: {} as ActionFunctionArgs["context"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the action only needs `request`
  } as any) as unknown as Promise<any>;
}

/** The `data:` object the action wrote to ShopSettings. */
function written() {
  expect(mocks.shopSettingsUpdate).toHaveBeenCalledTimes(1);
  return mocks.shopSettingsUpdate.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue({ admin: {}, session: { shop: SHOP } });
  mocks.getOrCreateShopSettings.mockResolvedValue({
    shop: SHOP,
    timezone: "America/New_York",
    plan: "STARTER",
    neverMoveTags: "gift-card,preorder,bundle",
    autoSwitchToManual: false,
    defaultScheduleType: "WEEKLY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: 1,
  });
  mocks.shopSettingsUpdate.mockImplementation(async ({ data }) => ({
    shop: SHOP,
    timezone: "America/New_York",
    defaultScheduleType: "WEEKLY",
    defaultScheduleTime: "06:00",
    defaultScheduleTime2: null,
    defaultScheduleWeekday: 1,
    ...data,
  }));
  mocks.collectionFindMany.mockResolvedValue([]);
  mocks.transaction.mockResolvedValue([]);
});

describe("the save bar's submit reaches the action and writes", () => {
  it("persists the Manual-sort toggle when it is turned on", async () => {
    const res = await post(settingsSubmission({ tags: parseTags("gift-card"), autoSwitchToManual: true }));

    expect(res.data).toMatchObject({ ok: true });
    expect(written()).toMatchObject({
      where: { shop: SHOP },
      data: { autoSwitchToManual: true, neverMoveTags: "gift-card" },
    });
  });

  it("persists the Manual-sort toggle when it is turned off", async () => {
    // The off case is the one a "truthy string" bug hides: submitting
    // "false" instead of "" would still read as on.
    const submission = settingsSubmission({ tags: parseTags("gift-card"), autoSwitchToManual: false });
    expect(submission.autoSwitchToManual).toBe("");

    await post(submission);
    expect(written().data.autoSwitchToManual).toBe(false);
  });

  it("persists an added tag", async () => {
    const before = parseTags("gift-card,preorder");
    const after = addTag(before, "clearance");
    expect(after).toEqual(["gift-card", "preorder", "clearance"]);

    await post(settingsSubmission({ tags: after, autoSwitchToManual: false }));
    expect(written().data.neverMoveTags).toBe("gift-card,preorder,clearance");
  });

  it("persists a removed tag", async () => {
    const before = parseTags("gift-card,preorder,bundle");
    const after = removeTag(before, "preorder");

    await post(settingsSubmission({ tags: after, autoSwitchToManual: false }));
    expect(written().data.neverMoveTags).toBe("gift-card,bundle");
  });

  it("persists removing the last tag as an empty list, not a stale value", async () => {
    await post(settingsSubmission({ tags: removeTag(["gift-card"], "gift-card"), autoSwitchToManual: false }));
    expect(written().data.neverMoveTags).toBe("");
  });

  it("writes the tags and the toggle in one update, scoped to this shop", async () => {
    await post(settingsSubmission({ tags: ["a", "b"], autoSwitchToManual: true }));
    const call = written();
    expect(call.where).toEqual({ shop: SHOP });
    expect(Object.keys(call.data).sort()).toEqual(["autoSwitchToManual", "neverMoveTags"]);
  });

  it("never writes a timezone, whatever is posted", async () => {
    // Shopify owns the timezone. Even a hand-rolled POST must not move it.
    await post({ ...settingsSubmission({ tags: [], autoSwitchToManual: false }), timezone: "" });
    expect(written().data).not.toHaveProperty("timezone");
  });

  it("does not touch the shop's default schedule", async () => {
    await post(settingsSubmission({ tags: ["gift-card"], autoSwitchToManual: false }));
    const keys = Object.keys(written().data);
    expect(keys.filter((k) => k.startsWith("defaultSchedule"))).toEqual([]);
  });
});

describe("a full edit round trip", () => {
  // The closest thing to clicking through the page: start from what the
  // loader gives the component, apply the edits a merchant makes, submit
  // through the real builder, and check the database write.
  it("carries an add, a remove and a toggle through to the write", async () => {
    let tags = parseTags("gift-card,preorder,bundle");
    tags = addTag(tags, " clearance ");   // typed with stray spaces
    tags = removeTag(tags, "preorder");   // chip dismissed
    tags = addTag(tags, "CLEARANCE");     // typed again, different case

    expect(tags).toEqual(["gift-card", "bundle", "clearance"]);

    await post(settingsSubmission({ tags, autoSwitchToManual: true }));
    expect(written().data).toEqual({
      neverMoveTags: "gift-card,bundle,clearance",
      autoSwitchToManual: true,
    });
  });

  it("round-trips through the stored CSV without drift", async () => {
    const stored = "gift-card,preorder,bundle";
    expect(serializeTags(parseTags(stored))).toBe(stored);
  });
});

describe("the tag editor's own rules", () => {
  it("ignores an empty or whitespace-only tag", () => {
    expect(addTag(["a"], "")).toEqual(["a"]);
    expect(addTag(["a"], "   ")).toEqual(["a"]);
  });

  it("trims what the merchant typed", () => {
    expect(addTag([], "  gift-card  ")).toEqual(["gift-card"]);
  });

  it("refuses a duplicate regardless of case", () => {
    expect(addTag(["gift-card"], "Gift-Card")).toEqual(["gift-card"]);
  });

  it("returns the same array when nothing changed, so the page stays clean", () => {
    // Identity is what the component's markDirty() check relies on: an
    // ignored keystroke must not light up the save bar.
    const tags = ["gift-card"];
    expect(addTag(tags, "gift-card")).toBe(tags);
    expect(addTag(tags, "")).toBe(tags);
  });

  it("tolerates a messy stored value", () => {
    expect(parseTags(" gift-card , ,preorder, ")).toEqual(["gift-card", "preorder"]);
  });
});
