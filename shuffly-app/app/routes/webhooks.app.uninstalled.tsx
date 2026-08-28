import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    // Webhook requests can trigger multiple times and after an app has already been uninstalled.
    // If this webhook already ran, the session may have been deleted previously.
    if (session) {
      await db.session.deleteMany({ where: { shop } });
    }
  } catch (err) {
    // Surfacing a 500 (rather than swallowing this) is deliberate: it tells
    // Shopify to retry, which is correct if this was a transient DB error —
    // silently returning 200 here would mean a failed cleanup looks
    // successful and never gets retried.
    console.error(`[webhook:app/uninstalled] failed for ${shop}:`, err);
    return new Response(null, { status: 500 });
  }

  return new Response();
};
