// Computes what "Shuffle all now" would do, WITHOUT calling
// collectionReorderProducts — powers the confirm modal's counts (products
// moving, sold-out moved down, pins held). Pure read + in-memory algorithm,
// same one the real run uses, so the numbers shown are exactly what happens
// if the merchant confirms.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig } from "@prisma/client";
import db from "../db.server";
import { getCollectionProductsInOrder } from "./collections.server";
import { computeShuffledOrder, type ShuffleProductInput } from "./shuffle-algorithm.server";

export interface ShuffleAllPreview {
  collections: number;
  productsMoving: number;
  soldOutMovedDown: number;
  pinsHeld: number;
  notReady: string[]; // titles that can't run (not manual sort)
  estimatedSeconds: number;
}

/** A rough "how long this will take" estimate for the confirm modal, from
 * this shop's own run history rather than a made-up constant. Shops with no
 * history yet (a fresh install) get a conservative per-collection guess. */
async function estimateSeconds(shop: string, collectionCount: number): Promise<number> {
  if (collectionCount === 0) return 0;
  const avg = await db.shuffleRun.aggregate({
    where: { shop, status: "OK" },
    _avg: { durationMs: true },
  });
  const perCollectionMs = avg._avg.durationMs ?? 1500;
  return Math.max(1, Math.round((perCollectionMs * collectionCount) / 1000));
}

function parseNeverMoveTags(csv: string): Set<string> {
  return new Set(
    csv
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function previewShuffleAll(
  admin: AdminApiContext,
  shop: string,
  configs: CollectionConfig[],
  neverMoveTagsCsv: string,
): Promise<ShuffleAllPreview> {
  const neverMoveTags = parseNeverMoveTags(neverMoveTagsCsv);
  const preview: ShuffleAllPreview = {
    collections: 0,
    productsMoving: 0,
    soldOutMovedDown: 0,
    pinsHeld: 0,
    notReady: [],
    estimatedSeconds: 0,
  };

  for (const config of configs) {
    const { sortOrder, products } = await getCollectionProductsInOrder(admin, config.collectionGid);
    if (sortOrder !== "MANUAL") {
      preview.notReady.push(config.title);
      continue;
    }

    const currentOrder = products.map((p) => p.id);
    const now = Date.now();
    const newArrivalMs = config.newArrivalDays * 86_400_000;
    const productsById = new Map<string, ShuffleProductInput>(
      products.map((p) => [
        p.id,
        {
          id: p.id,
          isSoldOut: p.tracksInventory && p.totalInventory <= 0,
          isNew: now - new Date(p.createdAt).getTime() <= newArrivalMs,
          neverMove: p.tags.some((t) => neverMoveTags.has(t.toLowerCase())),
        },
      ]),
    );
    const turnCounts: Record<string, number> = JSON.parse(config.turnCounts || "{}");
    const result = computeShuffledOrder(currentOrder, productsById, turnCounts, {
      pins: config.pins,
      pushSoldOutToEnd: config.pushSoldOutToEnd,
      boostNewArrivals: config.boostNewArrivals,
      giveEveryoneATurn: config.giveEveryoneATurn,
    });

    preview.collections += 1;
    preview.productsMoving += result.shuffledCount;
    preview.soldOutMovedDown += result.soldOutCount;
    preview.pinsHeld += result.pinnedCount;
  }

  preview.estimatedSeconds = await estimateSeconds(shop, preview.collections);
  return preview;
}
