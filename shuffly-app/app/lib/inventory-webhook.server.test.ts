import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateWebhook: vi.fn(),
  reactToSoldOutProduct: vi.fn(),
  shopHasSoldOutReaction: vi.fn(),
}));

vi.mock("../shopify.server", () => ({
  authenticate: { webhook: mocks.authenticateWebhook },
}));

vi.mock("./sold-out-reaction.server", () => ({
  reactToSoldOutProduct: mocks.reactToSoldOutProduct,
  shopHasSoldOutReaction: mocks.shopHasSoldOutReaction,
}));

import { drainBackgroundTasks } from "./background.server";
import { action } from "../routes/webhooks.inventory-levels.update";

function actionArgs(): ActionFunctionArgs {
  const url = new URL("https://example.com/webhooks/inventory-levels/update");
  return {
    request: new Request(url, {
      method: "POST",
    }),
    url,
    pattern: "/webhooks/inventory-levels/update",
    params: {},
    context: {} as ActionFunctionArgs["context"],
  };
}

describe("inventory_levels/update webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shopHasSoldOutReaction.mockResolvedValue(true);
  });

  it("ignores a webhook when no Admin context is available", async () => {
    mocks.authenticateWebhook.mockResolvedValue({
      shop: "shop.myshopify.com",
      admin: undefined,
      payload: { inventory_item_id: 123 },
    });

    const response = await action(actionArgs());

    expect(response.status).toBe(200);
    expect(mocks.reactToSoldOutProduct).not.toHaveBeenCalled();
  });

  it("ignores an inventory item without an id", async () => {
    const graphql = vi.fn();
    mocks.authenticateWebhook.mockResolvedValue({
      shop: "shop.myshopify.com",
      admin: { graphql },
      payload: {},
    });

    const response = await action(actionArgs());

    expect(response.status).toBe(200);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("moves each distinct product only when its aggregate inventory is sold out", async () => {
    const graphql = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            inventoryItem: {
              variants: {
                nodes: [
                  { product: { id: "gid://shopify/Product/1", totalInventory: 0 } },
                  { product: { id: "gid://shopify/Product/1", totalInventory: 0 } },
                  { product: { id: "gid://shopify/Product/2", totalInventory: 4 } },
                ],
              },
            },
          },
        }),
      ),
    );
    const admin = { graphql };
    mocks.authenticateWebhook.mockResolvedValue({
      shop: "shop.myshopify.com",
      admin,
      payload: { inventory_item_id: 123 },
    });

    const response = await action(actionArgs());
    // The handler answers first and reacts afterwards.
    await drainBackgroundTasks(1000);

    expect(response.status).toBe(200);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("inventoryItem"), {
      variables: { id: "gid://shopify/InventoryItem/123" },
    });
    expect(mocks.reactToSoldOutProduct).toHaveBeenCalledTimes(1);
    expect(mocks.reactToSoldOutProduct).toHaveBeenCalledWith(
      admin,
      "shop.myshopify.com",
      "gid://shopify/Product/1",
    );
  });

  it("answers 200 before its GraphQL lookup, and logs a failure without reacting", async () => {
    const graphql = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "temporary failure" }] })),
    );
    mocks.authenticateWebhook.mockResolvedValue({
      shop: "shop.myshopify.com",
      admin: { graphql },
      payload: { inventory_item_id: 123 },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await action(actionArgs());
    expect(response.status).toBe(200);
    await drainBackgroundTasks(1000);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    expect(mocks.reactToSoldOutProduct).not.toHaveBeenCalled();
  });

  it("skips the Admin API entirely when the shop has nothing opted in", async () => {
    mocks.shopHasSoldOutReaction.mockResolvedValue(false);
    const graphql = vi.fn();
    mocks.authenticateWebhook.mockResolvedValue({
      shop: "shop.myshopify.com",
      admin: { graphql },
      payload: { inventory_item_id: 123 },
    });

    const response = await action(actionArgs());
    await drainBackgroundTasks(1000);

    expect(response.status).toBe(200);
    expect(graphql).not.toHaveBeenCalled();
    expect(mocks.reactToSoldOutProduct).not.toHaveBeenCalled();
  });
});
