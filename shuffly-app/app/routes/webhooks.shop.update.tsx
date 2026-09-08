import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Keeps ShopSettings.timezone in step with the shop's own setting.
 *
 * Every schedule in Shuffly is a local wall-clock time interpreted in this
 * timezone, so a merchant who moves their store from, say, Asia/Phnom_Penh to
 * America/New_York must have their 06:00 shuffles follow them — not silently
 * keep firing at the old zone's 06:00. Before this webhook the value was only
 * re-read when someone happened to open the Settings page, which could be
 * weeks.
 *
 * `shop/update` fires for any shop-level change, so most deliveries are
 * irrelevant to us; the timezone is compared before writing and the row is
 * left alone when it hasn't moved.
 *
 * Note nextRunAt is deliberately NOT recomputed here. It is advisory only —
 * the sweep re-derives what's due from the stored local time on every pass
 * (see cron.server.ts), so the new timezone takes effect on the very next
 * sweep, and the sweep repairs the countdown itself.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  try {
    // Shopify sends the shop resource; `iana_timezone` is the REST spelling
    // of the same field the GraphQL query reads as `ianaTimezone`.
    const incoming =
      (payload as { iana_timezone?: string; timezone?: string })?.iana_timezone ?? null;
    if (!incoming) return new Response();

    const settings = await db.shopSettings.findUnique({
      where: { shop },
      select: { timezone: true },
    });
    // No row yet means the app hasn't been opened; getOrCreateShopSettings
    // will read the timezone live on first load, so there's nothing to fix.
    if (!settings || settings.timezone === incoming) return new Response();

    await db.shopSettings.update({ where: { shop }, data: { timezone: incoming } });
    console.log(
      `[webhook:${topic}] ${shop} timezone ${settings.timezone} -> ${incoming}; schedules now follow the new zone`,
    );
  } catch (err) {
    console.error(`[webhook:shop/update] failed for ${shop}:`, err);
    return new Response(null, { status: 500 });
  }

  return new Response();
};
