// Thin wrappers around the Admin GraphQL calls Shuffly needs. Every
// operation here was validated against the live 2026-07 schema before use
// (see shuffly-app build notes) — in particular collectionReorderProducts is
// asynchronous and returns a Job that must be polled, and it only works on
// collections whose sortOrder is MANUAL.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export interface ShopifyProductSummary {
  id: string; // gid://shopify/Product/...
  title: string;
  createdAt: string;
  totalInventory: number;
  tracksInventory: boolean;
  tags: string[];
}

export interface ShopifyCollectionSummary {
  id: string;
  title: string;
  handle: string;
  sortOrder: string;
  productsCount: number;
}

export async function getShopTimezone(admin: AdminApiContext): Promise<string> {
  const res = await admin.graphql(`#graphql
    query ShopTimezone { shop { ianaTimezone } }`);
  const json = await res.json();
  return json.data?.shop?.ianaTimezone ?? "UTC";
}

/** The shop's own contact email — used as a fallback on the Settings page
 * when the current session isn't tied to a specific staff member's email. */
export async function getShopContactEmail(admin: AdminApiContext): Promise<string | null> {
  const res = await admin.graphql(`#graphql
    query ShopEmail { shop { email } }`);
  const json = await res.json();
  return json.data?.shop?.email ?? null;
}

export async function getTotalCollectionsCount(admin: AdminApiContext): Promise<number> {
  const res = await admin.graphql(`#graphql
    query TotalCollections { collectionsCount { count } }`);
  const json = await res.json();
  return json.data?.collectionsCount?.count ?? 0;
}

export async function listAllCollections(
  admin: AdminApiContext,
): Promise<ShopifyCollectionSummary[]> {
  const out: ShopifyCollectionSummary[] = [];
  let after: string | null = null;
  for (;;) {
    const res: Response = await admin.graphql(
      `#graphql
      query ShopCollections($first: Int!, $after: String) {
        collections(first: $first, after: $after, sortKey: TITLE) {
          edges {
            cursor
            node { id title handle sortOrder productsCount { count } }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { variables: { first: 100, after } },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
    const json: any = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
    const edges: any[] = json.data?.collections?.edges ?? [];
    for (const edge of edges) {
      out.push({
        id: edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        sortOrder: edge.node.sortOrder,
        productsCount: edge.node.productsCount?.count ?? 0,
      });
    }
    if (json.data?.collections?.pageInfo?.hasNextPage && edges.length) {
      after = edges[edges.length - 1].cursor;
    } else {
      break;
    }
  }
  return out;
}

export interface ProductPreviewTile {
  id: string;
  title: string;
  initial: string;
  imageUrl: string | null;
  soldOut: boolean;
}

export interface HydratedCollection extends ShopifyCollectionSummary {
  preview: ProductPreviewTile[];
}

/**
 * One batched round trip that hydrates a whole page of tracked collections:
 * title, sortOrder, productsCount, and their first N products (for the
 * thumbnail row) — used by the Collections list so it never issues an N+1
 * fan-out of per-collection requests.
 *
 * `Product.featuredImage` is deprecated, so thumbnails go through
 * `featuredMedia { preview { image } }` instead.
 */
export async function hydrateTrackedCollections(
  admin: AdminApiContext,
  ids: string[],
  thumbCount = 5,
): Promise<Map<string, HydratedCollection>> {
  const out = new Map<string, HydratedCollection>();
  if (ids.length === 0) return out;
  const res = await admin.graphql(
    `#graphql
    query HydrateTrackedCollections($ids: [ID!]!, $thumbs: Int!) {
      nodes(ids: $ids) {
        ... on Collection {
          id
          title
          handle
          sortOrder
          productsCount { count }
          products(first: $thumbs, sortKey: COLLECTION_DEFAULT) {
            nodes {
              id
              title
              totalInventory
              tracksInventory
              featuredMedia {
                preview {
                  image { url(transform: {maxWidth: 60, maxHeight: 60, crop: CENTER}) }
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { ids, thumbs: thumbCount } },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
  const json: any = await res.json();
  for (const node of json.data?.nodes ?? []) {
    if (!node?.id) continue;
    const previewNodes = node.products?.nodes ?? [];
    out.set(node.id, {
      id: node.id,
      title: node.title,
      handle: node.handle,
      sortOrder: node.sortOrder,
      productsCount: node.productsCount?.count ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
      preview: previewNodes.map((n: any) => ({
        id: n.id,
        title: n.title,
        initial: (n.title ?? "?").trim().charAt(0).toUpperCase() || "?",
        imageUrl: n.featuredMedia?.preview?.image?.url ?? null,
        soldOut: n.tracksInventory && n.totalInventory <= 0,
      })),
    });
  }
  return out;
}

const SORT_ORDER_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  BEST_SELLING: "Best selling",
  ALPHA_ASC: "Alphabetically, A-Z",
  ALPHA_DESC: "Alphabetically, Z-A",
  PRICE_ASC: "Price, low to high",
  PRICE_DESC: "Price, high to low",
  CREATED: "Date created, old to new",
  CREATED_DESC: "Date created, new to old",
  ID_DESC: "Product ID",
  RELEVANCE: "Relevance",
};

/** Human label for a Shopify `CollectionSortOrder` value, for copy like
 * "It uses Shopify's Best selling sort." */
export function sortOrderLabel(sortOrder: string): string {
  return SORT_ORDER_LABELS[sortOrder] ?? sortOrder;
}

/**
 * Cheap id+title+sortOrder lookup, batched and chunked (Shopify's `nodes`
 * query caps out around 250 ids per call) — used to check every tracked
 * collection for "isn't on manual sort" regardless of which page of the
 * Collections list is currently showing, without re-fetching the full
 * thumbnail/count payload for collections `hydrateTrackedCollections`
 * already covered.
 */
export async function fetchSortOrders(
  admin: AdminApiContext,
  ids: string[],
): Promise<Map<string, { title: string; sortOrder: string }>> {
  const out = new Map<string, { title: string; sortOrder: string }>();
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    if (chunk.length === 0) continue;
    const res = await admin.graphql(
      `#graphql
      query SortOrders($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Collection { id title sortOrder }
        }
      }`,
      { variables: { ids: chunk } },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
    const json: any = await res.json();
    for (const node of json.data?.nodes ?? []) {
      if (node?.id) out.set(node.id, { title: node.title, sortOrder: node.sortOrder });
    }
  }
  return out;
}

export async function getCollectionProductsInOrder(
  admin: AdminApiContext,
  collectionGid: string,
  limit = 2000,
): Promise<{ sortOrder: string; products: ShopifyProductSummary[] }> {
  const products: ShopifyProductSummary[] = [];
  let after: string | null = null;
  let sortOrder = "MANUAL";
  for (;;) {
    const res: Response = await admin.graphql(
      `#graphql
      query CollectionProducts($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          id
          sortOrder
          products(first: $first, after: $after, sortKey: COLLECTION_DEFAULT) {
            edges {
              cursor
              node { id title createdAt totalInventory tracksInventory tags }
            }
            pageInfo { hasNextPage }
          }
        }
      }`,
      { variables: { id: collectionGid, first: 100, after } },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
    const json: any = await res.json();
    const collection = json.data?.collection;
    if (!collection) break;
    sortOrder = collection.sortOrder;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
    const edges: any[] = collection.products.edges ?? [];
    for (const edge of edges) {
      products.push({
        id: edge.node.id,
        title: edge.node.title,
        createdAt: edge.node.createdAt,
        totalInventory: edge.node.totalInventory,
        tracksInventory: edge.node.tracksInventory,
        tags: edge.node.tags ?? [],
      });
    }
    if (collection.products.pageInfo?.hasNextPage && edges.length && products.length < limit) {
      after = edges[edges.length - 1].cursor;
    } else {
      break;
    }
  }
  return { sortOrder, products };
}

/** Which collections (by gid) contain a given product — used by the
 * products/update webhook to know which tracked collections to react in. */
export async function getCollectionGidsContainingProduct(
  admin: AdminApiContext,
  productGid: string,
): Promise<string[]> {
  const res = await admin.graphql(
    `#graphql
    query ProductCollections($id: ID!) {
      product(id: $id) {
        id
        collections(first: 100) { nodes { id } }
      }
    }`,
    { variables: { id: productGid } },
  );
  const json = await res.json();
  const nodes = json.data?.product?.collections?.nodes ?? [];
  return nodes.map((n: { id: string }) => n.id);
}

/**
 * Switches a collection to manual sort. Shopify seeds the manual order from
 * whatever the collection was displaying under its previous sort a moment
 * ago, so nothing visibly jumps for the merchant — we just need to
 * remember what that previous sort *was*, for display/audit purposes.
 */
export async function setCollectionManualSort(
  admin: AdminApiContext,
  collectionGid: string,
): Promise<{ ok: boolean; error?: string; previousSortOrder?: string }> {
  const currentRes = await admin.graphql(
    `#graphql
    query CurrentSortOrder($id: ID!) { collection(id: $id) { id sortOrder } }`,
    { variables: { id: collectionGid } },
  );
  const currentJson = await currentRes.json();
  const previousSortOrder: string | undefined = currentJson.data?.collection?.sortOrder;

  const res = await admin.graphql(
    `#graphql
    mutation SetManualSort($id: ID!) {
      collectionUpdate(collection: {id: $id, sortOrder: MANUAL}) {
        collection { id sortOrder }
        userErrors { field message }
      }
    }`,
    { variables: { id: collectionGid } },
  );
  const json = await res.json();
  const errors = json.data?.collectionUpdate?.userErrors ?? [];
  if (errors.length) return { ok: false, error: errors.map((e: { message: string }) => e.message).join("; ") };
  return { ok: true, previousSortOrder };
}

/**
 * Diff `currentOrder` -> `targetOrder` into the minimal list of
 * { id, newPosition } moves that collectionReorderProducts expects,
 * simulating the exact "remove then reinsert, applied sequentially"
 * semantics Shopify documents for this mutation.
 */
export function diffToMoves(
  currentOrder: string[],
  targetOrder: string[],
): Array<{ id: string; newPosition: string }> {
  const moves: Array<{ id: string; newPosition: string }> = [];
  const working = currentOrder.slice();
  for (let i = 0; i < targetOrder.length; i++) {
    if (working[i] === targetOrder[i]) continue;
    const j = working.indexOf(targetOrder[i], i);
    if (j === -1) continue; // shouldn't happen if both arrays hold the same ids
    const [item] = working.splice(j, 1);
    working.splice(i, 0, item);
    moves.push({ id: item, newPosition: String(i) });
  }
  return moves;
}

export async function reorderCollectionProducts(
  admin: AdminApiContext,
  collectionGid: string,
  moves: Array<{ id: string; newPosition: string }>,
): Promise<{ ok: boolean; error?: string }> {
  if (moves.length === 0) return { ok: true };
  const res = await admin.graphql(
    `#graphql
    mutation ReorderCollectionProducts($id: ID!, $moves: [MoveInput!]!) {
      collectionReorderProducts(id: $id, moves: $moves) {
        job { id done }
        userErrors { field message }
      }
    }`,
    { variables: { id: collectionGid, moves } },
  );
  const json = await res.json();
  const payload = json.data?.collectionReorderProducts;
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    return { ok: false, error: errors.map((e: { message: string }) => e.message).join("; ") };
  }
  const jobId = payload?.job?.id as string | undefined;
  if (jobId && payload?.job?.done === false) {
    await pollJob(admin, jobId);
  }
  return { ok: true };
}

async function pollJob(admin: AdminApiContext, jobId: string, maxWaitMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await admin.graphql(
      `#graphql
      query PollJob($id: ID!) { job(id: $id) { id done } }`,
      { variables: { id: jobId } },
    );
    const json = await res.json();
    if (json.data?.job?.done) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}
