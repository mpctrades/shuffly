// Collections paused because their sort was changed away from Manual
// (sortOrderIssueAt set) resume on their own once it's Manual again —
// whether the merchant used Shuffly's one-click switch (handled in that
// action) or changed it back in Shopify admin (handled here, every 15
// minutes by the maintenance job). One batched `nodes` read per 250
// collections per shop; no reads at all when nothing is paused.
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { fetchSortOrders } from "./collections.server";
import { nextRunFor } from "./schedule-core";
import { resolveSchedule } from "./schedule-resolve";

export async function resumeSortPausedCollections(now: Date = new Date()): Promise<number> {
  const paused = await db.collectionConfig.findMany({
    where: { status: "RUNNING", sortOrderIssueAt: { not: null } },
  });
  if (paused.length === 0) return 0;

  const byShop = new Map<string, typeof paused>();
  for (const c of paused) byShop.set(c.shop, [...(byShop.get(c.shop) ?? []), c]);

  let resumed = 0;
  for (const [shop, configs] of byShop) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const settings = await db.shopSettings.findUnique({ where: { shop } });
      if (!settings) continue;
      const live = await fetchSortOrders(admin, configs.map((c) => c.collectionGid));
      for (const c of configs) {
        if (live.get(c.collectionGid)?.sortOrder !== "MANUAL") continue;
        await db.$transaction([
          db.collectionConfig.update({
            where: { id: c.id },
            data: { sortOrderIssueAt: null, nextRunAt: nextRunFor(now, settings.timezone, resolveSchedule(c, settings)) },
          }),
          db.shuffleRun.create({
            data: {
              shop,
              collectionId: c.id,
              trigger: "RESUMED",
              status: "OK",
              messageCode: "RESUMED_SORT",
              message: "Resumed — sort order is Manual again",
            },
          }),
        ]);
        resumed++;
      }
    } catch (err) {
      console.error(`[sort-pause] ${shop} re-check failed:`, err);
    }
  }
  return resumed;
}
