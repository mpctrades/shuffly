import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getShopTimezone } from "./collections.server";

/** Get this shop's settings row, creating it (with its real timezone) on
 * first touch so every other route can assume it exists. */
export async function getOrCreateShopSettings(admin: AdminApiContext, shop: string) {
  let settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings) {
    const timezone = await getShopTimezone(admin);
    settings = await db.shopSettings.create({ data: { shop, timezone } });
  }
  return settings;
}

/**
 * Re-confirm the shop's timezone against Shopify, and self-heal our cache.
 *
 * The timezone is Shopify's setting, not ours. We cache it on ShopSettings
 * because every schedule calculation needs it on every request, and the
 * `shop/update` webhook keeps that cache fresh — but a webhook that was
 * missed, deferred or delivered while the app was down leaves the cache
 * stale with nothing to correct it. A stale timezone is not a cosmetic bug:
 * every "next run" a merchant is shown, and every time they pick, is a wall
 * clock in it.
 *
 * So the screens that show or set shuffle times confirm it live and repair
 * the row when it has moved. Returns the value the caller should actually
 * use — the live one when Shopify answered, the cached one when it didn't,
 * never a guess — plus a message for callers that have somewhere to show it.
 *
 * Deliberately never throws: a page must still render on the last known
 * timezone if the Admin API is briefly unreachable.
 */
export async function confirmShopTimezone(
  admin: AdminApiContext,
  shop: string,
  cached: string,
): Promise<{ timezone: string; error: string | null }> {
  try {
    const live = await getShopTimezone(admin);
    if (!live) return { timezone: cached, error: null };
    if (live !== cached) {
      await db.shopSettings.update({ where: { shop }, data: { timezone: live } });
    }
    return { timezone: live, error: null };
  } catch {
    return {
      timezone: cached,
      error:
        "Couldn't confirm your shop's timezone from Shopify just now — showing the last known value.",
    };
  }
}
