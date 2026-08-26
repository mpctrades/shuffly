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
