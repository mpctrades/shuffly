import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER_SETS = [
  {
    hmac: "x-shopify-hmac-sha256",
    topic: "x-shopify-topic",
    shop: "x-shopify-shop-domain",
  },
  {
    hmac: "shopify-hmac-sha256",
    topic: "shopify-topic",
    shop: "shopify-shop-domain",
  },
] as const;

function normalizedTopic(value: string): string {
  return value.trim().toUpperCase().replaceAll("/", "_").replaceAll("-", "_");
}

/**
 * Authenticate a webhook without loading or refreshing the shop's offline
 * session. Shopify can deliver uninstall/privacy webhooks only after the app
 * token is revoked; HMAC authentication is sufficient and still mandatory.
 *
 * This is a targeted workaround for Shopify/shopify-app-js#3360. Product and
 * inventory webhooks keep using the official authenticated Admin context.
 */
export async function authenticateSessionlessWebhook(
  request: Request,
  allowedTopics: string[],
): Promise<{ shop: string; topic: string }> {
  if (request.method !== "POST") {
    throw new Response(null, { status: 405, statusText: "Method not allowed" });
  }

  const headers = HEADER_SETS.find(({ hmac }) => request.headers.has(hmac));
  if (!headers) {
    throw new Response(null, { status: 400, statusText: "Missing webhook headers" });
  }

  const suppliedHmac = request.headers.get(headers.hmac);
  const rawTopic = request.headers.get(headers.topic);
  const shop = request.headers.get(headers.shop);
  if (!suppliedHmac || !rawTopic || !shop) {
    throw new Response(null, { status: 400, statusText: "Missing webhook headers" });
  }

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Response(null, { status: 500, statusText: "Webhook secret unavailable" });
  }

  const rawBody = await request.text();
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedHmac, "base64");
  } catch {
    throw new Response(null, { status: 401, statusText: "Unauthorized" });
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Response(null, { status: 401, statusText: "Unauthorized" });
  }

  const topic = normalizedTopic(rawTopic);
  if (!allowedTopics.includes(topic)) {
    throw new Response(null, { status: 400, statusText: "Unexpected webhook topic" });
  }

  return { shop, topic };
}
