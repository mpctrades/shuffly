import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import {
  getCollectionGidsContainingProduct,
  reorderCollectionProducts,
} from "./collections.server";

/**
 * Move a sold-out product to the end of every running, opted-in collection.
 *
 * Both product and inventory-level webhooks call this helper. Keeping the
 * Shopify write and activity logging in one place prevents the two webhook
 * payload shapes from drifting into subtly different behavior.
 */
export async function reactToSoldOutProduct(
  admin: AdminApiContext,
  shop: string,
  productGid: string,
): Promise<void> {
  const memberGids = new Set(
    await getCollectionGidsContainingProduct(admin, productGid),
  );
  if (memberGids.size === 0) return;

  const candidates = await db.collectionConfig.findMany({
    where: {
      shop,
      status: "RUNNING",
      pushSoldOutToEnd: true,
      collectionGid: { in: Array.from(memberGids) },
    },
  });

  for (const config of candidates) {
    let lastKnownOrder: string[] | null = null;
    try {
      lastKnownOrder = config.lastKnownOrder ? JSON.parse(config.lastKnownOrder) : null;
    } catch {
      lastKnownOrder = null;
    }

    // products/update and inventory_levels/update both call this for the
    // same underlying inventory change, and can arrive close together. If
    // this product is already the last thing we wrote to Shopify for this
    // collection, a previous call (from either webhook) already handled it —
    // reacting again would be a duplicate write and a duplicate Activity
    // row for nothing that actually changed. This doesn't close the window
    // between two truly concurrent calls (there's no claim/lock), just the
    // sequential-arrival case the two webhooks actually produce.
    if (lastKnownOrder && lastKnownOrder.length > 0 && lastKnownOrder[lastKnownOrder.length - 1] === productGid) {
      continue;
    }

    const started = Date.now();
    const result = await reorderCollectionProducts(admin, config.collectionGid, [
      { id: productGid, newPosition: "999999" },
    ]);
    // Keep lastKnownOrder's own invariant ("exactly what we last wrote to
    // Shopify") true after this targeted move too — otherwise the next full
    // shuffle's drift check would mistake this for an external hand-drag.
    const nextKnownOrder =
      result.ok && lastKnownOrder ? [...lastKnownOrder.filter((id) => id !== productGid), productGid] : null;

    await db.$transaction([
      db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger: "SOLD_OUT_REACTION",
          status: result.ok ? "OK" : "FAILED",
          movedCount: result.ok ? 1 : 0,
          pinnedCount: 0,
          soldOutCount: result.ok ? 1 : 0,
          durationMs: Date.now() - started,
          message: result.ok
            ? "1 product sold out — moved to the end"
            : result.error ?? "Failed to react to sell-out",
        },
      }),
      ...(nextKnownOrder
        ? [
            db.collectionConfig.update({
              where: { id: config.id },
              data: { lastKnownOrder: JSON.stringify(nextKnownOrder) },
            }),
          ]
        : []),
    ]);
  }
}
