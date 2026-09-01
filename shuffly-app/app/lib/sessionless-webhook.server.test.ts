import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateSessionlessWebhook } from "./sessionless-webhook.server";

const originalSecret = process.env.SHOPIFY_API_SECRET;

afterEach(() => {
  process.env.SHOPIFY_API_SECRET = originalSecret;
});

function signedRequest(topic = "shop/redact", modernHeaders = false): Request {
  const body = JSON.stringify({ shop_id: 1, shop_domain: "example.myshopify.com" });
  const hmac = createHmac("sha256", "test-secret").update(body).digest("base64");
  const prefix = modernHeaders ? "shopify" : "x-shopify";
  return new Request("https://app.example/webhooks/compliance", {
    method: "POST",
    headers: {
      [`${prefix}-hmac-sha256`]: hmac,
      [`${prefix}-topic`]: topic,
      [`${prefix}-shop-domain`]: "example.myshopify.com",
    },
    body,
  });
}

describe("authenticateSessionlessWebhook", () => {
  it("validates a legacy-header Shopify webhook without loading a session", async () => {
    process.env.SHOPIFY_API_SECRET = "test-secret";
    await expect(
      authenticateSessionlessWebhook(signedRequest(), ["SHOP_REDACT"]),
    ).resolves.toEqual({ shop: "example.myshopify.com", topic: "SHOP_REDACT" });
  });

  it("supports Shopify's modern webhook header names", async () => {
    process.env.SHOPIFY_API_SECRET = "test-secret";
    await expect(
      authenticateSessionlessWebhook(signedRequest("app/uninstalled", true), [
        "APP_UNINSTALLED",
      ]),
    ).resolves.toEqual({
      shop: "example.myshopify.com",
      topic: "APP_UNINSTALLED",
    });
  });

  it("rejects an invalid HMAC before returning the shop", async () => {
    process.env.SHOPIFY_API_SECRET = "wrong-secret";
    await expect(
      authenticateSessionlessWebhook(signedRequest(), ["SHOP_REDACT"]),
    ).rejects.toMatchObject({ status: 401 });
  });
});
