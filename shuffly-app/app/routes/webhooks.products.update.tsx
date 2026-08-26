import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getCollectionGidsContainingProduct, reorderCollectionProducts } from "../lib/collections.server";

interface ProductUpdateVariant {
  inventory_management: string | null;
  inventory_quantity: number;
}

// Powers the "sold out within a minute" reaction advertised on the
// Workspace/Activity screens. We don't wait for the next scheduled shuffle —
// as soon as Shopify tells us a tracked product just ran out, we push it to
// the end of every running collection that has "sold-out to the end" on.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  if (!admin) return new Response();

  const productGid: string | undefined = payload?.admin_graphql_api_id;
  const variants = (payload?.variants ?? []) as ProductUpdateVariant[];
  if (!productGid || variants.length === 0) return new Response();

  const tracksInventory = variants.some((v) => v.inventory_management === "shopify");
  if (!tracksInventory) return new Response();

  const totalInventory = variants.reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0);
  const isSoldOut = totalInventory <= 0;
  if (!isSoldOut) {
    // A restock: no immediate repositioning (that needs a real shuffle to
    // decide where it lands) — it simply rejoins the pool on the next run.
    return new Response();
  }

  const memberGids = new Set(await getCollectionGidsContainingProduct(admin, productGid));
  if (memberGids.size === 0) return new Response();

  const candidates = await db.collectionConfig.findMany({
    where: { shop, status: "RUNNING", pushSoldOutToEnd: true, collectionGid: { in: Array.from(memberGids) } },
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
        message: result.ok ? "1 product sold out — moved to the end" : result.error ?? "Failed to react to sell-out",
      },
    });
  }

  return new Response();
};
