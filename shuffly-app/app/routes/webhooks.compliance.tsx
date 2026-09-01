import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateSessionlessWebhook } from "../lib/sessionless-webhook.server";

// The three mandatory GDPR/CCPA compliance webhooks — configured together
// in shopify.app.toml under `compliance_topics` (not `topics`), which is why
// they share this one endpoint instead of three separate routes.
// https://shopify.dev/docs/apps/build/privacy-law-compliance
//
// Shuffly's scopes (read_products/write_products) mean it never stores
// customer data, so data_request/customers_redact have nothing to export or
// erase — we just have to acknowledge them. shop/redact is the one with real
// work to do: it's what backs the Settings screen's promise that Shuffly's
// data is deleted when Shopify sends shop/redact 48 hours after uninstall.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateSessionlessWebhook(request, [
    "CUSTOMERS_DATA_REQUEST",
    "CUSTOMERS_REDACT",
    "SHOP_REDACT",
  ]);

  try {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST":
      case "CUSTOMERS_REDACT":
        // eslint-disable-next-line no-console
        console.log(`[compliance] ${topic} for ${shop} — no customer data stored`);
        break;
      case "SHOP_REDACT":
        // eslint-disable-next-line no-console
        console.log(`[compliance] ${topic} for ${shop} — deleting all stored data`);
        await db.$transaction([
          db.productPosition.deleteMany({ where: { shop } }),
          db.positionSnapshot.deleteMany({ where: { shop } }),
          db.productExposure.deleteMany({ where: { shop } }),
          db.shuffleRun.deleteMany({ where: { shop } }),
          db.collectionConfig.deleteMany({ where: { shop } }),
          db.shopSettings.deleteMany({ where: { shop } }),
          db.session.deleteMany({ where: { shop } }),
        ]);
        break;
      default:
        // eslint-disable-next-line no-console
        console.log(`[compliance] unrecognized topic ${topic} for ${shop}`);
    }
  } catch (err) {
    // Deliberately a 500, not a swallowed error: SHOP_REDACT backs the
    // deletion statement on the Settings/privacy pages. If
    // the delete actually failed, Shopify needs to see a failure and retry
    // — returning 200 here would let a real compliance failure go silent.
    // eslint-disable-next-line no-console
    console.error(`[compliance] ${topic} failed for ${shop}:`, err);
    return new Response(null, { status: 500 });
  }

  return new Response();
};
