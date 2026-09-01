import type { ActionFunctionArgs } from "react-router";

import { reactToSoldOutProduct } from "../lib/sold-out-reaction.server";
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
  const { shop, admin, payload } = await authenticate.webhook(request);
  if (!admin) return new Response();

  const inventoryItemId = (payload as InventoryLevelUpdatePayload)
    ?.inventory_item_id;
  if (!inventoryItemId) return new Response();

  try {
    const response = await admin.graphql(
      `#graphql
      query InventoryItemProduct($id: ID!) {
        inventoryItem(id: $id) {
          variants(first: 250) {
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
    return new Response(null, { status: 500 });
  }

  return new Response();
};
