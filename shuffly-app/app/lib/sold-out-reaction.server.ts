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
    const started = Date.now();
    const result = await reorderCollectionProducts(admin, config.collectionGid, [
      { id: productGid, newPosition: "999999" },
    ]);
    await db.shuffleRun.create({
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
    });
  }
}
