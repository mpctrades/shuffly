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

export interface ListCollectionsOptions {
  /** Free-text title search, passed through to Shopify's own collection
   * search syntax — lets the "Add collections" picker narrow a large
   * catalogue instead of listing every collection in the store. */
  search?: string;
  /** Hard cap on how many collections this ever returns. Without one, a
   * store with hundreds/thousands of collections turns this into an
   * unbounded fetch (and, downstream, an unbounded render) — see
   * `hasMore` for when the cap was hit. */
  limit?: number;
}

/**
 * Paginates Shopify's collections connection up to `limit` (default 100),
 * optionally filtered by title. Returns `hasMore: true` when the store has
 * more matching collections than `limit` — callers should surface that
 * ("refine your search") rather than silently truncating without saying so.
 */
export async function listAllCollections(
  admin: AdminApiContext,
  { search, limit = 100 }: ListCollectionsOptions = {},
): Promise<{ collections: ShopifyCollectionSummary[]; hasMore: boolean }> {
  const out: ShopifyCollectionSummary[] = [];
  let after: string | null = null;
  let hasMore = false;
  const query = search?.trim() ? `title:*${search.trim().replace(/["*\\]/g, "")}*` : undefined;
  for (;;) {
    const remaining = limit - out.length;
    if (remaining <= 0) break;
    const res: Response = await admin.graphql(
      `#graphql
      query ShopCollections($first: Int!, $after: String, $query: String) {
        collections(first: $first, after: $after, sortKey: TITLE, query: $query) {
          edges {
            cursor
            node { id title handle sortOrder productsCount { count } }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { variables: { first: Math.min(100, remaining), after, query } },
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
    const pageHasNext = Boolean(json.data?.collections?.pageInfo?.hasNextPage);
    if (pageHasNext && out.length >= limit) {
      hasMore = true;
      break;
    }
    if (pageHasNext && edges.length) {
      after = edges[edges.length - 1].cursor;
    } else {
      break;
    }
  }
  return { collections: out, hasMore };
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

/**
 * Cheap version of getCollectionProductsInOrder for pages that only ever
 * render a fixed-size preview (the collection Workspace's "Order" card,
 * currently 16 tiles) — one request for `previewSize` products plus
 * Shopify's own aggregate `productsCount`, instead of paginating the whole
 * collection just to report `products.length`. Keeps the loader from
 * blocking first paint on a collection with thousands of products; the real
 * shuffle (runShuffleForCollection) fetches its own full, ordered list
 * independently of this.
 */
export async function getCollectionPreviewAndCount(
  admin: AdminApiContext,
  collectionGid: string,
  previewSize = 16,
): Promise<{ sortOrder: string; totalCount: number; preview: ShopifyProductSummary[] }> {
  const res = await admin.graphql(
    `#graphql
    query CollectionPreview($id: ID!, $first: Int!) {
      collection(id: $id) {
        id
        sortOrder
        productsCount { count }
        products(first: $first, sortKey: COLLECTION_DEFAULT) {
          nodes { id title createdAt totalInventory tracksInventory tags }
        }
      }
    }`,
    { variables: { id: collectionGid, first: previewSize } },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
  const json: any = await res.json();
  const collection = json.data?.collection;
  if (!collection) return { sortOrder: "MANUAL", totalCount: 0, preview: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw GraphQL JSON, no generated types for this ad-hoc query
  const nodes: any[] = collection.products?.nodes ?? [];
  return {
    sortOrder: collection.sortOrder,
    totalCount: collection.productsCount?.count ?? nodes.length,
    preview: nodes.map((n) => ({
      id: n.id,
      title: n.title,
      createdAt: n.createdAt,
      totalInventory: n.totalInventory,
      tracksInventory: n.tracksInventory,
      tags: n.tags ?? [],
    })),
  };
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

/** One batched lookup for a small, bounded set of product ids — the
 * Insights "Still never seen" list (capped at 10) needs a thumbnail per
 * row, and that's the only place in the app that needs a product image by
 * id rather than by collection. */
export async function fetchProductThumbnails(
  admin: AdminApiContext,
  productGids: string[],
): Promise<Map<string, { title: string; imageUrl: string | null }>> {
  const out = new Map<string, { title: string; imageUrl: string | null }>();
  if (productGids.length === 0) return out;
  const res = await admin.graphql(
    `#graphql
    query ProductThumbnails($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          featuredMedia { preview { image { url } } }
        }
      }
    }`,
    { variables: { ids: productGids } },
  );
  const json = await res.json();
  for (const node of json.data?.nodes ?? []) {
    if (node?.id) out.set(node.id, { title: node.title, imageUrl: node.featuredMedia?.preview?.image?.url ?? null });
  }
  return out;
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

/** Shopify's documented cap for a single collectionReorderProducts call. A
 * bigger reorder has to go out as several calls, and because moves are
 * applied *sequentially* each chunk has to wait for the previous job to
 * finish — otherwise the later chunks' newPosition values are computed
 * against an order that's still shifting underneath them. */
const MAX_MOVES_PER_CALL = 250;

/** Two overlapping reorder jobs on one collection make Shopify answer
 * TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS ("Products are currently being
 * reordered. Please try again later."), so every reorder for a given
 * collection queues behind the one before it. Keyed by collection gid, so
 * different collections still run concurrently — which is what the cron
 * sweep and "Shuffle all now" actually do.
 *
 * In-process only: it covers the single always-on container this app
 * deploys as (see scheduler.server.ts). The retry in sendMovesWithRetry is
 * the backstop for anything this map can't see — another replica, or a
 * merchant dragging products in Shopify admin at the same moment. */
const reorderChains = new Map<string, Promise<unknown>>();

function serializePerCollection<T>(collectionGid: string, task: () => Promise<T>): Promise<T> {
  const previous = reorderChains.get(collectionGid) ?? Promise.resolve();
  // Run `task` whether the previous reorder resolved *or* rejected — one
  // thrown error must not wedge this collection's queue forever.
  const result = previous.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  reorderChains.set(collectionGid, settled);
  void settled.then(() => {
    // Only drop the entry if nothing else queued behind us meanwhile.
    if (reorderChains.get(collectionGid) === settled) reorderChains.delete(collectionGid);
  });
  return result;
}

/** Backoff for TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS. Three tries over ~11s:
 * long enough to outlast a reorder job started a moment earlier, short
 * enough that a cron sweep of many collections doesn't stall on one. */
const REORDER_RETRY_DELAYS_MS = [1_000, 3_000, 7_000];

export interface ReorderResult {
  ok: boolean;
  error?: string;
  /** Shopify's own CollectionReorderProductsUserErrorCode, when it gave one —
   * so callers can tell "currently being reordered" apart from "this
   * collection isn't manually sorted". */
  code?: string;
}

export async function reorderCollectionProducts(
  admin: AdminApiContext,
  collectionGid: string,
  moves: Array<{ id: string; newPosition: string }>,
): Promise<ReorderResult> {
  if (moves.length === 0) return { ok: true };

  return serializePerCollection(collectionGid, async () => {
    for (let offset = 0; offset < moves.length; offset += MAX_MOVES_PER_CALL) {
      const chunk = moves.slice(offset, offset + MAX_MOVES_PER_CALL);
      const isLastChunk = offset + MAX_MOVES_PER_CALL >= moves.length;
      const result = await sendMovesWithRetry(admin, collectionGid, chunk, !isLastChunk);
      if (!result.ok) return result;
    }
    return { ok: true };
  });
}

async function sendMovesWithRetry(
  admin: AdminApiContext,
  collectionGid: string,
  moves: Array<{ id: string; newPosition: string }>,
  mustWaitForJob: boolean,
): Promise<ReorderResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await sendMoves(admin, collectionGid, moves, mustWaitForJob);
    if (result.ok || result.code !== "TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS") return result;
    const delay = REORDER_RETRY_DELAYS_MS[attempt];
    if (delay == null) return result;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function sendMoves(
  admin: AdminApiContext,
  collectionGid: string,
  moves: Array<{ id: string; newPosition: string }>,
  mustWaitForJob: boolean,
): Promise<ReorderResult> {
  const res = await admin.graphql(
    `#graphql
    mutation ReorderCollectionProducts($id: ID!, $moves: [MoveInput!]!) {
      collectionReorderProducts(id: $id, moves: $moves) {
        job { id done }
        userErrors { field message code }
      }
    }`,
    { variables: { id: collectionGid, moves } },
  );
  const json = await res.json();
  const payload = json.data?.collectionReorderProducts;
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    return {
      ok: false,
      error: errors.map((e: { message: string }) => e.message).join("; "),
      code: errors[0]?.code ?? undefined,
    };
  }

  const jobId = payload?.job?.id as string | undefined;
  if (jobId && payload?.job?.done !== true) {
    // An intermediate chunk MUST land before the next one is computed, so
    // give it longer and treat a timeout as a real failure. For the final
    // chunk a timeout isn't one: the job is asynchronous by design and
    // Shopify finishes it on its own — which is exactly why the UI says
    // "changes can take a few minutes to appear on your store".
    const done = await pollJob(admin, jobId, mustWaitForJob ? 60_000 : 15_000);
    if (!done && mustWaitForJob) {
      return {
        ok: false,
        error: "Shopify is still applying an earlier part of this reorder. Try again in a few minutes.",
        code: "JOB_TIMEOUT",
      };
    }
  }
  return { ok: true };
}

/** Resolves true once Shopify reports the job done, false if `maxWaitMs`
 * elapsed first (the job usually still completes — it just outlived our
 * willingness to hold a request open for it). */
async function pollJob(admin: AdminApiContext, jobId: string, maxWaitMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await admin.graphql(
      `#graphql
      query PollJob($id: ID!) { job(id: $id) { id done } }`,
      { variables: { id: jobId } },
    );
    const json = await res.json();
    if (json.data?.job?.done) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Adding any collection: capturing what it looked like first, restoring it
// afterwards, and doing a batch of them without hammering Shopify.
// ---------------------------------------------------------------------------

/** Product ids are stored without the "gid://shopify/Product/" prefix — a
 * quarter of the bytes on a large collection, and the prefix is a constant. */
const PRODUCT_GID_PREFIX = "gid://shopify/Product/";

export function packProductIds(gids: string[]): string {
  return JSON.stringify(gids.map((gid) => gid.replace(PRODUCT_GID_PREFIX, "")));
}

export function unpackProductIds(packed: string | null): string[] {
  if (!packed) return [];
  try {
    const ids: unknown = JSON.parse(packed);
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => `${PRODUCT_GID_PREFIX}${id}`);
  } catch {
    return [];
  }
}

/**
 * The order a collection had at the moment it was added to Shuffly.
 *
 * Deliberately separate from ShuffleRun.previousOrder: that one is a per-run
 * snapshot which pruneExpiredUndoSnapshots deletes after the plan's retention
 * window (one day on Free), so it can't back a "put it back how it was before
 * Shuffly" promise months later. This is captured once and never pruned.
 *
 * Returns null when the order can't be read — the caller stores nothing
 * rather than a partial list, and the remove dialog then says it has no
 * snapshot instead of offering a restore it can't perform.
 */
export async function captureOriginalOrder(
  admin: AdminApiContext,
  collectionGid: string,
): Promise<{ packed: string; count: number } | null> {
  try {
    const { products } = await getCollectionProductsInOrder(admin, collectionGid);
    if (products.length === 0) return null;
    return { packed: packProductIds(products.map((p) => p.id)), count: products.length };
  } catch (err) {
    console.error(`[collections] couldn't snapshot ${collectionGid} before switching:`, err);
    return null;
  }
}

/** Put a collection's sortOrder back to what it was before Shuffly switched
 * it. Restoring an automatic sort makes product positions irrelevant —
 * Shopify recomputes the order — which is why the remove flow offers the sort
 * restore and the product-order restore as one choice, not two. */
export async function restoreCollectionSort(
  admin: AdminApiContext,
  collectionGid: string,
  sortOrder: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await admin.graphql(
    `#graphql
    mutation RestoreCollectionSort($id: ID!, $sortOrder: CollectionSortOrder!) {
      collectionUpdate(collection: {id: $id, sortOrder: $sortOrder}) {
        collection { id sortOrder }
        userErrors { field message }
      }
    }`,
    { variables: { id: collectionGid, sortOrder } },
  );
  const json = await res.json();
  const errors = json.data?.collectionUpdate?.userErrors ?? [];
  if (errors.length) return { ok: false, error: errors.map((e: { message: string }) => e.message).join("; ") };
  return { ok: true };
}

/**
 * Run `task` over `items` with at most `limit` in flight, preserving result
 * order. Adding twenty collections shouldn't fire twenty concurrent mutations
 * at Shopify's rate limiter, and it shouldn't crawl through them one at a
 * time either. Hand-rolled because p-map is only an npm override in this
 * repo, not a dependency — not worth adding one for ten lines.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
