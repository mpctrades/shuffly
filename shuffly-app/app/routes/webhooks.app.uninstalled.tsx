import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateSessionlessWebhook } from "../lib/sessionless-webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateSessionlessWebhook(request, [
    "APP_UNINSTALLED",
  ]);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    // Webhooks can be delivered more than once. deleteMany is intentionally
    // idempotent and does not require an active/revoked Shopify session.
    await db.session.deleteMany({ where: { shop } });
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
