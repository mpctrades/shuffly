import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// The three mandatory GDPR/CCPA compliance webhooks — configured together
// in shopify.app.toml under `compliance_topics` (not `topics`), which is why
// they share this one endpoint instead of three separate routes.
// https://shopify.dev/docs/apps/build/privacy-law-compliance
//
// Shuffly's scopes (read_products/write_products) mean it never stores
// customer data, so data_request/customers_redact have nothing to export or
// erase — we just have to acknowledge them. shop/redact is the one with real
// work to do: it's what backs the Settings screen's promise that Shuffly's
// data is deleted within 48 hours of uninstall.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST":
      case "CUSTOMERS_REDACT":
        // eslint-disable-next-line no-console
        console.log(`[compliance] ${topic} for ${shop}`, { customerId: payload?.customer?.id });
        break;
      case "SHOP_REDACT":
        // eslint-disable-next-line no-console
        console.log(`[compliance] ${topic} for ${shop} — deleting all stored data`);
        await db.collectionConfig.deleteMany({ where: { shop } });
        await db.shopSettings.deleteMany({ where: { shop } });
        await db.session.deleteMany({ where: { shop } });
        break;
      default:
        // eslint-disable-next-line no-console
        console.log(`[compliance] unrecognized topic ${topic} for ${shop}`);
    }
  } catch (err) {
    // Deliberately a 500, not a swallowed error: SHOP_REDACT backs the
    // "deleted within 48 hours" promise on the Settings/privacy pages. If
    // the delete actually failed, Shopify needs to see a failure and retry
    // — returning 200 here would let a real compliance failure go silent.
    // eslint-disable-next-line no-console
    console.error(`[compliance] ${topic} failed for ${shop}:`, err);
    return new Response(null, { status: 500 });
  }

  return new Response();
};
