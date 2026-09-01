import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  getTotalCollectionsCount,
  listAllCollections,
  sortOrderLabel,
} from "../lib/collections.server";
import { authenticate } from "../shopify.server";

// Resource route for the optional "Not shuffled yet" card. Keeping this
// catalogue scan out of app.collections' critical loader removes up to two
// paginated Admin API calls (plus the aggregate count) from every page load.
// A click ends the browser's LCP observation window before this data is
// requested, so rendering the below-the-fold card can't delay that metric.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [tracked, untrackedResult, totalStoreCollections] = await Promise.all([
    db.collectionConfig.findMany({
      where: { shop },
      select: { collectionGid: true },
    }),
    listAllCollections(admin, { limit: 200 }),
    getTotalCollectionsCount(admin).catch(() => null),
  ]);

  const trackedGids = new Set(tracked.map((item) => item.collectionGid));
  const items = untrackedResult.collections
    .filter((collection) => !trackedGids.has(collection.id))
    .map((collection) => ({
      gid: collection.id,
      title: collection.title,
      productsCount: collection.productsCount,
      sortOrder: collection.sortOrder,
      sortOrderLabel: sortOrderLabel(collection.sortOrder),
    }));

  return {
    items,
    hasMore: untrackedResult.hasMore,
    totalStoreCollections,
  };
};
