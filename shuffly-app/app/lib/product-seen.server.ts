// First-seen tracking: when Shuffly first saw each product in each
// collection (Update 2). Shopify doesn't expose when a product was added to a
// collection, so Feature B (new-products trigger) and Feature C (keep new
// arrivals on top) both read this instead. Written by every normal run and
// every new-products poll.
import db from "../db.server";

const PRODUCT_PREFIX = "gid://shopify/Product/";
export const shortId = (gid: string) => gid.replace(PRODUCT_PREFIX, "");
export const productGid = (id: string) => (id.startsWith("gid://") ? id : `${PRODUCT_PREFIX}${id}`);

// ---------------------------------------------------------------------------

export interface SeenInput {
  id: string; // gid
  createdAt: string | Date | null;
}

/**
 * Bring ProductSeen in line with the collection's full current product list.
 * Returns how many products are new to this collection.
 *
 * `baseline` is for the first sync after B or C is turned on: everything
 * present is recorded as already there, not as arrivals.
 */
export async function syncSeenProducts(
  collectionId: string,
  products: SeenInput[],
  now: Date,
  { baseline = false }: { baseline?: boolean } = {},
): Promise<{ added: string[]; removed: number }> {
  const existing = await db.productSeen.findMany({ where: { collectionId }, select: { productId: true } });
  const known = new Set(existing.map((r) => r.productId));
  const present = new Set(products.map((p) => shortId(p.id)));

  const fresh = products.filter((p) => !known.has(shortId(p.id)));
  const gone = [...known].filter((id) => !present.has(id));

  if (fresh.length > 0) {
    // SQLite caps bound variables per statement; 500 rows × 5 columns is safe.
    for (let i = 0; i < fresh.length; i += 500) {
      await db.productSeen.createMany({
        data: fresh.slice(i, i + 500).map((p) => ({
          collectionId,
          productId: shortId(p.id),
          firstSeenAt: now,
          baseline,
          productCreatedAt: p.createdAt ? new Date(p.createdAt) : null,
        })),
      });
    }
  }
  if (gone.length > 0) {
    for (let i = 0; i < gone.length; i += 500) {
      await db.productSeen.deleteMany({ where: { collectionId, productId: { in: gone.slice(i, i + 500) } } });
    }
  }
  return { added: baseline ? [] : fresh.map((p) => p.id), removed: gone.length };
}

/** Start tracking a collection: called when B or C is first turned on (and
 * lazily by the poll/engine if that moment was missed). */
export async function startTracking(collectionId: string, products: SeenInput[], now: Date): Promise<void> {
  await syncSeenProducts(collectionId, products, now, { baseline: true });
  await db.collectionConfig.update({ where: { id: collectionId }, data: { newTrackingSince: now } });
}

