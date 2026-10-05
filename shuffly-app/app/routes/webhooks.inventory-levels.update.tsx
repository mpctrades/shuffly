import type { ActionFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { runInBackground } from "../lib/background.server";
import { reactToSoldOutProduct, shopHasSoldOutReaction } from "../lib/sold-out-reaction.server";
import { isDuplicateDelivery } from "../lib/webhook-dedupe.server";
import { authenticate } from "../shopify.server";

interface InventoryLevelUpdatePayload {
  inventory_item_id?: number;
}

interface InventoryItemProductResponse {
  data?: {
    inventoryItem?: {
      variants?: {
        nodes?: Array<{
          product?: {
            id?: string;
            totalInventory?: number;
          } | null;
        }>;
      };
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

// Inventory quantities live on InventoryLevel, so this is the authoritative
// trigger for automatic sold-out handling. The payload identifies
// an inventory item, not its product; fetch the current product aggregate so
// multi-location and multi-variant products only move after all stock is gone.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload, topic, webhookId } = await authenticate.webhook(request);
  if (!admin) return new Response();

  const inventoryItemId = (payload as InventoryLevelUpdatePayload)
    ?.inventory_item_id;
  if (!inventoryItemId) return new Response();

  // A retried delivery we've already acted on is acknowledged and skipped.
  if (await isDuplicateDelivery(webhookId, shop, topic)) return new Response();

  // Shopify gives us 5 seconds to answer, and the lookups below are several
  // round trips to the Admin API — from our host that can blow the budget.
  // Acknowledge now (the HMAC is already verified) and react afterwards; a
  // missed reaction is corrected by the next scheduled shuffle anyway.
  runInBackground(`inventory_levels/update ${shop} item ${inventoryItemId}`, () =>
    reactToInventoryItem(admin, shop, inventoryItemId),
  );
  return new Response();
};

async function reactToInventoryItem(
  admin: AdminApiContext,
  shop: string,
  inventoryItemId: number,
): Promise<void> {
  // Nothing opted in means nothing this webhook could move — skip the
  // Admin API lookup entirely.
  if (!(await shopHasSoldOutReaction(shop))) return;

  try {
    const response = await admin.graphql(
      `#graphql
      query InventoryItemProduct($id: ID!) {
        inventoryItem(id: $id) {
          # An inventory item belongs to one variant in practice; 10 keeps
          # headroom without paying query cost for 250 that never exist.
          variants(first: 10) {
            nodes {
              product {
                id
                totalInventory
              }
            }
          }
        }
      }`,
      {
        variables: {
          id: `gid://shopify/InventoryItem/${inventoryItemId}`,
        },
      },
    );
    const json = (await response.json()) as InventoryItemProductResponse;
    if (json.errors?.length) {
      throw new Error(
        json.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; "),
      );
    }

    const products = new Map<string, number>();
    for (const node of json.data?.inventoryItem?.variants?.nodes ?? []) {
      const product = node.product;
      if (product?.id && typeof product.totalInventory === "number") {
        products.set(product.id, product.totalInventory);
      }
    }

    for (const [productGid, totalInventory] of products) {
      if (totalInventory <= 0) {
        await reactToSoldOutProduct(admin, shop, productGid);
      }
    }
  } catch (err) {
    console.error(
      `[webhook:inventory_levels/update] failed for ${shop}, inventory item ${inventoryItemId}:`,
      err,
    );
  }
}
