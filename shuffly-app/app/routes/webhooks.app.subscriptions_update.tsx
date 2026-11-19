import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { runInBackground } from "../lib/background.server";
import { syncPlanFromAdmin } from "../lib/billing.server";
import { isDuplicateDelivery } from "../lib/webhook-dedupe.server";

/**
 * A subscription was created, cancelled, frozen or changed (Update 2).
 *
 * Before this the plan was only re-checked when someone opened the app, so a
 * merchant who downgraded from Pro in Shopify admin and never came back kept
 * Pro's hourly schedules running indefinitely. Now the downgrade clamps —
 * Starter falls back to Daily, Free to Weekly, new-arrivals options off —
 * happen as soon as Shopify tells us.
 *
 * The payload is only the trigger. The plan itself is re-read from the app
 * installation's active subscriptions (the same source billing.check()
 * uses), so an out-of-order or retried delivery can't set a stale plan.
 * Answered immediately; the sync runs after the response, inside Shopify's
 * delivery deadline.
 *
 * No access scope is needed for this topic.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, topic, webhookId } = await authenticate.webhook(request);
  if (!admin) return new Response();
  if (await isDuplicateDelivery(webhookId, shop, topic)) return new Response();

  runInBackground(`app_subscriptions/update ${shop}`, async () => {
    const result = await syncPlanFromAdmin(shop, admin, { force: true });
    if (result?.changed) console.log(`[webhook:${topic}] ${shop} plan is now ${result.planId}; entitlements applied`);
  });
  return new Response();
};
