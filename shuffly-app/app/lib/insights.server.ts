// Everything the Insights screen needs: recording a position snapshot every
// time a collection actually runs, and turning that history into the page's
// numbers. Deliberately DB-only — no live Shopify calls, no new scopes —
// since every metric here is "what did Shuffly itself observe," not
// storefront traffic.
import type { Prisma } from "@prisma/client";
import db from "../db.server";

export const PAGE1_SIZE = 24; // Shopify's default collection page size; we
// have no way to read a theme's actual products-per-page without extra
// scopes, so this is the fixed fallback the spec calls for.
export const TOP20_SIZE = 20;

export type InsightsRange = "30d" | "90d" | "install";

export interface SnapshotProduct {
  id: string;
  title: string;
  isSoldOut: boolean;
}

/** "YYYY-MM-DD" in the shop's own timezone — a stable day bucket for the
 * position-snapshot history, independent of what time a run happens to fire. */
export function dateKeyInTz(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Called once per collection, every time it actually runs (scheduled or
 * manual) — right after fetching its live order, before reordering. Only
 * touches rows for products in the top `PAGE1_SIZE` positions (cheap even for
 * large collections); a product outside that range gets a row created only
 * the first time we ever see it at all, so "still never seen" can tell a
 * genuinely-untracked product apart from one whose history already exists. */
export async function recordPositionSnapshot(
  shop: string,
  collectionId: string,
  productsInOrder: SnapshotProduct[],
  timezone: string,
): Promise<void> {
  const now = new Date();
  const dateKey = dateKeyInTz(now, timezone);
  const page1 = productsInOrder.slice(0, PAGE1_SIZE);
  const top20 = productsInOrder.slice(0, TOP20_SIZE);
  const soldOutTop20Count = top20.filter((p) => p.isSoldOut).length;

  const existing = await db.productExposure.findMany({
    where: {
      shop,
      collectionId,
      productGid: { in: productsInOrder.map((p) => p.id) },
    },
    select: {
      productGid: true,
      firstSeenPage1At: true,
      firstSeenTop20At: true,
    },
  });
  const existingByGid = new Map(existing.map((e) => [e.productGid, e]));

  const writes: Prisma.PrismaPromise<unknown>[] = [
    db.positionSnapshot.upsert({
      where: { shop_collectionId_dateKey: { shop, collectionId, dateKey } },
      update: { soldOutTop20Count, capturedAt: now },
      create: {
        shop,
        collectionId,
        dateKey,
        soldOutTop20Count,
        capturedAt: now,
      },
    }),
  ];

  page1.forEach((p, idx) => {
    const prior = existingByGid.get(p.id);
    const isTop20 = idx < TOP20_SIZE;
    writes.push(
      db.productExposure.upsert({
        where: {
          shop_collectionId_productGid: {
            shop,
            collectionId,
            productGid: p.id,
          },
        },
        update: {
          productTitle: p.title,
          lastSeenPage1At: now,
          ...(prior?.firstSeenPage1At ? {} : { firstSeenPage1At: now }),
          ...(isTop20 && !prior?.firstSeenTop20At
            ? { firstSeenTop20At: now }
            : {}),
        },
        create: {
          shop,
          collectionId,
          productGid: p.id,
          productTitle: p.title,
          firstSeenPage1At: now,
          lastSeenPage1At: now,
          firstSeenTop20At: isTop20 ? now : null,
        },
      }),
    );
  });

  const page1Set = new Set(page1.map((p) => p.id));
  for (const p of productsInOrder) {
    if (page1Set.has(p.id) || existingByGid.has(p.id)) continue;
    // Known to exist, never once on page 1 — a bare row so "still never
    // seen" can list it without needing a live product fetch.
    writes.push(
      db.productExposure.create({
        data: { shop, collectionId, productGid: p.id, productTitle: p.title },
      }),
    );
  }

  await db.$transaction(writes);
}

function resolveWindowStart(range: InsightsRange, installedAt: Date): Date {
  if (range === "30d") return new Date(Date.now() - 30 * 86_400_000);
  if (range === "90d") return new Date(Date.now() - 90 * 86_400_000);
  return installedAt;
}

export interface InsightsByCollectionRow {
  id: string;
  title: string;
  pct: number;
  suffix: string | null;
  color: "orange" | "dark";
  scheduleType: string;
  scheduleTime: string;
  scheduleWeekday: number | null;
  status: string;
  productCount: number;
  seenCount: number;
  neverSeenCount: number;
}

export interface InsightsNeverSeenRow {
  productGid: string;
  collectionId: string;
  title: string;
  label: string;
}

export interface InsightsData {
  hasHistory: boolean;
  daysOfHistory: number;
  page1Pct: number;
  page1BaselinePct: number;
  page1DeltaPts: number;
  soldOutTop20Mean: number;
  soldOutTop20Baseline: number | null;
  firstTop20Count: number;
  byCollection: InsightsByCollectionRow[];
  neverSeen: InsightsNeverSeenRow[];
  suggestion: { collectionId: string; title: string } | null;
}

const EMPTY_INSIGHTS: InsightsData = {
  hasHistory: false,
  daysOfHistory: 0,
  page1Pct: 0,
  page1BaselinePct: 0,
  page1DeltaPts: 0,
  soldOutTop20Mean: 0,
  soldOutTop20Baseline: null,
  firstTop20Count: 0,
  byCollection: [],
  neverSeen: [],
  suggestion: null,
};

export async function computeInsights(
  shop: string,
  range: InsightsRange,
  installedAt: Date,
): Promise<InsightsData> {
  const anySnapshot = await db.positionSnapshot.findFirst({ where: { shop } });
  if (!anySnapshot) return EMPTY_INSIGHTS;

  const windowStart = resolveWindowStart(range, installedAt);
  const [tracked, exposures] = await Promise.all([
    db.collectionConfig.findMany({
      where: { shop },
      orderBy: { createdAt: "asc" },
    }),
    db.productExposure.findMany({ where: { shop } }),
  ]);
  const totalProducts = tracked.reduce((sum, c) => sum + c.productCount, 0);

  // ---- "Products seen on page 1" ----
  const seenInWindowCount = exposures.filter(
    (e) => e.lastSeenPage1At && e.lastSeenPage1At >= windowStart,
  ).length;
  const page1Pct =
    totalProducts > 0
      ? Math.round((seenInWindowCount / totalProducts) * 100)
      : 0;
  // Baseline: without any shuffling, only each collection's own first
  // PAGE1_SIZE products would ever be seen — a real ceiling, not a guess.
  const baselineSeenCount = tracked.reduce(
    (sum, c) => sum + Math.min(PAGE1_SIZE, c.productCount),
    0,
  );
  const page1BaselinePct =
    totalProducts > 0
      ? Math.round((baselineSeenCount / totalProducts) * 100)
      : 0;

  // ---- "Sold-out sitting near the top" ----
  const snapshotsInWindow = await db.positionSnapshot.findMany({
    where: { shop, capturedAt: { gte: windowStart } },
  });
  const byDay = new Map<string, number>();
  for (const s of snapshotsInWindow)
    byDay.set(s.dateKey, (byDay.get(s.dateKey) ?? 0) + s.soldOutTop20Count);
  const dayValues = [...byDay.values()];
  const soldOutTop20Mean = dayValues.length
    ? Math.round(dayValues.reduce((a, b) => a + b, 0) / dayValues.length)
    : 0;

  const earliest = await db.positionSnapshot.findFirst({
    where: { shop },
    orderBy: { capturedAt: "asc" },
  });
  let soldOutTop20Baseline: number | null = null;
  if (earliest) {
    const sameDay = await db.positionSnapshot.findMany({
      where: { shop, dateKey: earliest.dateKey },
    });
    soldOutTop20Baseline = sameDay.reduce(
      (sum, s) => sum + s.soldOutTop20Count,
      0,
    );
  }
  // How many days Shuffly has actually been running shuffles for this shop —
  // distinct from `installedAt`, since a shop can install and wait a while
  // before its first collection ever runs. Drives the "still early" banner.
  const daysOfHistory = earliest
    ? Math.max(
        0,
        Math.floor((Date.now() - earliest.capturedAt.getTime()) / 86_400_000),
      )
    : 0;

  // ---- "Products reaching the top 20 for the first time" ----
  const firstTop20Count = exposures.filter(
    (e) => e.firstSeenTop20At && e.firstSeenTop20At >= windowStart,
  ).length;

  // ---- By collection ----
  const byCollection: InsightsByCollectionRow[] = tracked
    .map((c) => {
      const seen = exposures.filter(
        (e) =>
          e.collectionId === c.id &&
          e.lastSeenPage1At &&
          e.lastSeenPage1At >= windowStart,
      ).length;
      const pct =
        c.productCount > 0 ? Math.round((seen / c.productCount) * 100) : 0;
      let suffix: string | null = null;
      if (c.status === "PAUSED") suffix = "paused";
      else if (c.scheduleType === "MANUAL") suffix = "not shuffled";
      else if (c.scheduleType === "WEEKLY") suffix = "weekly only";
      const color: "orange" | "dark" =
        c.status === "RUNNING" &&
        (c.scheduleType === "DAILY" || c.scheduleType === "TWICE_DAILY")
          ? "orange"
          : "dark";
      return {
        id: c.id,
        title: c.title,
        pct,
        suffix,
        color,
        scheduleType: c.scheduleType,
        scheduleTime: c.scheduleTime,
        scheduleWeekday: c.scheduleWeekday,
        status: c.status,
        productCount: c.productCount,
        seenCount: seen,
        neverSeenCount: Math.max(0, c.productCount - seen),
      };
    })
    .sort((a, b) => b.pct - a.pct);

  // One real, computed suggestion — the lowest-exposure collection that's
  // held back specifically by its own weekly schedule (not paused, not
  // broken — an improvement genuinely one setting away).
  const weeklyRunning = byCollection.filter(
    (c) => c.scheduleType === "WEEKLY" && c.status === "RUNNING",
  );
  const suggestion =
    weeklyRunning.length > 0
      ? (() => {
          const worst = [...weeklyRunning].sort((a, b) => a.pct - b.pct)[0];
          return { collectionId: worst.id, title: worst.title };
        })()
      : null;

  // ---- Still never seen ----
  const now = Date.now();
  const neverSeen: InsightsNeverSeenRow[] = exposures
    .filter((e) => !e.lastSeenPage1At || e.lastSeenPage1At < windowStart)
    .sort(
      (a, b) =>
        (a.lastSeenPage1At?.getTime() ?? -1) -
        (b.lastSeenPage1At?.getTime() ?? -1),
    )
    .slice(0, 10)
    .map((e) => {
      const days = e.lastSeenPage1At
        ? Math.max(
            1,
            Math.round((now - e.lastSeenPage1At.getTime()) / 86_400_000),
          )
        : null;
      return {
        productGid: e.productGid,
        collectionId: e.collectionId,
        title: e.productTitle,
        label:
          days == null
            ? "never on page 1"
            : `last seen ${days} day${days === 1 ? "" : "s"} ago`,
      };
    });

  return {
    hasHistory: true,
    daysOfHistory,
    page1Pct,
    page1BaselinePct,
    page1DeltaPts: page1Pct - page1BaselinePct,
    soldOutTop20Mean,
    soldOutTop20Baseline,
    firstTop20Count,
    byCollection,
    neverSeen,
    suggestion,
  };
}

/** "Put these first tomorrow" — merges the given products into each of their
 * collection's one-time priority-boost list, consumed on that collection's
 * next run (see shuffle-algorithm.server.ts). */
export async function boostProductsForNextRun(
  shop: string,
  items: Array<{ productGid: string; collectionId: string }>,
): Promise<number> {
  if (items.length === 0) return 0;
  const byCollection = new Map<string, Set<string>>();
  for (const item of items) {
    if (!byCollection.has(item.collectionId))
      byCollection.set(item.collectionId, new Set());
    byCollection.get(item.collectionId)!.add(item.productGid);
  }

  const configs = await db.collectionConfig.findMany({
    where: { shop, id: { in: [...byCollection.keys()] } },
    select: { id: true, priorityBoostIds: true },
  });

  await db.$transaction(
    configs.map((c) => {
      const existingIds: string[] = JSON.parse(c.priorityBoostIds || "[]");
      const toAdd = byCollection.get(c.id) ?? new Set<string>();
      const merged = Array.from(new Set([...existingIds, ...toAdd]));
      return db.collectionConfig.update({
        where: { id: c.id },
        data: { priorityBoostIds: JSON.stringify(merged) },
      });
    }),
  );

  return items.length;
}
