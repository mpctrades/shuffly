import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listAllCollections } from "../lib/collections.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { planOf } from "../lib/plans.server";

// A resource route (no UI of its own) that the "Add collection" modal
// fetcher.load()s only when it's opened — keeps the main Collections list
// loader from paying the cost of listing every collection in the store on
// every page view.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, tracked, firstTracked, all] = await Promise.all([
    getOrCreateShopSettings(admin, shop),
    db.collectionConfig.findMany({ where: { shop }, select: { collectionGid: true } }),
    db.collectionConfig.findFirst({ where: { shop }, orderBy: { createdAt: "asc" }, select: { title: true } }),
    listAllCollections(admin),
  ]);

  const trackedGids = new Set(tracked.map((t) => t.collectionGid));
  const untracked = all.filter((c) => !trackedGids.has(c.id));
  const addable = untracked.filter((c) => c.sortOrder === "MANUAL");
  const nonManual = untracked.filter((c) => c.sortOrder !== "MANUAL");
  const plan = planOf(settings.plan);

  return {
    addable: addable.map((c) => ({ id: c.id, title: c.title, productsCount: c.productsCount })),
    nonManualCount: nonManual.length,
    plan: { name: plan.name, maxCollections: plan.maxCollections === Infinity ? null : plan.maxCollections },
    trackedCount: tracked.length,
    firstTrackedTitle: firstTracked?.title ?? null,
  };
};
