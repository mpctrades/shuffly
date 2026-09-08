import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listAllCollections, sortOrderLabel } from "../lib/collections.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { planOf } from "../lib/plans.server";

// A resource route (no UI of its own) that the "Add collection" modal
// fetcher.load()s only when it's opened (and again on every search keystroke,
// via ?q=) — keeps the main Collections list loader from paying the cost of
// listing every collection in the store on every page view. The list itself
// is capped (see listAllCollections) so a store with hundreds of collections
// doesn't render them all at once — `hasMore` tells the modal to prompt for
// a narrower search instead of silently showing a truncated list.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const q = new URL(request.url).searchParams.get("q") ?? "";

  const [settings, tracked, firstTracked, { collections: all, hasMore }] = await Promise.all([
    getOrCreateShopSettings(admin, shop),
    db.collectionConfig.findMany({ where: { shop }, select: { collectionGid: true } }),
    db.collectionConfig.findFirst({ where: { shop }, orderBy: { createdAt: "asc" }, select: { title: true } }),
    listAllCollections(admin, { search: q, limit: 100 }),
  ]);

  const trackedGids = new Set(tracked.map((t) => t.collectionGid));
  // Every untracked collection is addable, automated ones included. Shuffly
  // switches a non-Manual collection to Manual sort itself (with the
  // merchant's confirmation) as part of adding it, so there's nothing to
  // hide or grey out here — filtering these out was the dead end that sent
  // merchants to Shopify admin.
  const addable = all.filter((c) => !trackedGids.has(c.id));
  const plan = planOf(settings.plan);

  return {
    addable: addable.map((c) => ({
      id: c.id,
      title: c.title,
      productsCount: c.productsCount,
      sortOrder: c.sortOrder,
      sortOrderLabel: sortOrderLabel(c.sortOrder),
      needsManual: c.sortOrder !== "MANUAL",
    })),
    hasMore,
    query: q,
    plan: { name: plan.name, maxCollections: plan.maxCollections === Infinity ? null : plan.maxCollections },
    trackedCount: tracked.length,
    firstTrackedTitle: firstTracked?.title ?? null,
  };
};
