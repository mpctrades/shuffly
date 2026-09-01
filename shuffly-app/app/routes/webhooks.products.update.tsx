import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { reactToSoldOutProduct } from "../lib/sold-out-reaction.server";

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

  try {
    await reactToSoldOutProduct(admin, shop, productGid);
  } catch (err) {
    console.error(`[webhook:products/update] failed for ${shop}, product ${productGid}:`, err);
    return new Response(null, { status: 500 });
  }

  return new Response();
};
