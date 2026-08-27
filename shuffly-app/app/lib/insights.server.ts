// Everything the Insights screen needs: recording a position snapshot every
// time a collection actually runs, and turning that history into "how
// evenly are turns shared, and who's waiting longest" — Insights' real
// question once coverage itself is solved (every tracked collection
// reading 100% made the old coverage-focused page repeat one number seven
// times). Deliberately DB-only — no live Shopify calls, no new scopes —
// every metric here is "what did Shuffly itself observe," not storefront
// traffic. Every aggregate is computed here, server-side; the route loader
// ships only the shaped result, never raw position rows.
import db from "../db.server";

export type InsightsRange = "7d" | "30d" | "install";

export interface SnapshotProduct {
  id: string;
  title: string;
  isSoldOut: boolean;
}

/** "YYYY-MM-DD" in the shop's own timezone — a stable day bucket,
 * independent of what time of day a run happens to fire. */
export function dateKeyInTz(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Called once per collection, every time it actually runs (scheduled or
 * manual) — right after fetching its live order, before reordering. Only
 * writes rows for products within the shop's `pageSize` — every Insights
 * metric only cares whether a product held a page-1 position ("a turn"),
 * never its exact rank further down, so recording the rest would just grow
 * the table for nothing. Position is 1-based. */
export async function recordProductPositions(
  shop: string,
  collectionId: string,
  productsInOrder: SnapshotProduct[],
  timezone: string,
  pageSize: number,
): Promise<void> {
  const now = new Date();
  const dateKey = dateKeyInTz(now, timezone);
  const page1 = productsInOrder.slice(0, pageSize);
  if (page1.length === 0) return;

  await db.productPosition.createMany({
    data: page1.map((p, idx) => ({
      shop,
      collectionId,
      productGid: p.id,
      position: idx + 1,
      availableForSale: !p.isSoldOut,
      dateKey,
      recordedAt: now,
    })),
  });
}

/** Called alongside recordProductPositions, but given the FULL collection
 * order (not just page 1) — ProductPosition only ever holds page-1 rows,
 * so it has no way to know a product exists at all if it's never once had
 * a turn. This keeps a cheap title + "ever had a turn?" cache per product,
 * updated once per run, specifically so "Waiting longest" and the
 * per-collection square grid can name every product without a live
 * Shopify call. */
export async function recordKnownProducts(shop: string, collectionId: string, fullOrder: SnapshotProduct[], pageSize: number): Promise<void> {
  if (fullOrder.length === 0) return;
  const now = new Date();
  const existing = await db.productExposure.findMany({
    where: { shop, collectionId, productGid: { in: fullOrder.map((p) => p.id) } },
    select: { productGid: true, lastSeenPage1At: true },
  });
  const existingByGid = new Map(existing.map((e) => [e.productGid, e]));

  await db.$transaction(
    fullOrder.map((p, idx) =>
      db.productExposure.upsert({
        where: { shop_collectionId_productGid: { shop, collectionId, productGid: p.id } },
        update: {
          productTitle: p.title,
          ...(idx < pageSize ? { lastSeenPage1At: now, ...(existingByGid.get(p.id)?.lastSeenPage1At ? {} : { firstSeenPage1At: now }) } : {}),
        },
        create: {
          shop,
          collectionId,
          productGid: p.id,
          productTitle: p.title,
          firstSeenPage1At: idx < pageSize ? now : null,
          lastSeenPage1At: idx < pageSize ? now : null,
        },
      }),
    ),
  );
}

// A few minutes' cache per shop+range — this page doesn't need to be live
// to the second, and the distribution + per-collection queries below touch
// enough rows that recomputing on every request would be wasteful. Plain
// in-process Map, matching this app's single-container deployment (same
// reasoning as the in-process scheduler) — not meant to survive a restart
// or work across replicas.
const CACHE_TTL_MS = 3 * 60_000;
const cache = new Map<string, { at: number; data: InsightsData }>();

function cacheKey(shop: string, range: InsightsRange, pageSize: number): string {
  return `${shop}:${range}:${pageSize}`;
}

export function invalidateInsightsCache(shop: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${shop}:`)) cache.delete(key);
  }
}

/** A plain value + description; `noData` when fewer than 7 days of history
 * make the number a meaningless artifact rather than a real answer — the
 * UI shows "—" and "Needs about a week of runs" instead. No before/after
 * comparison on this page (that was the old coverage hero's job, and the
 * hero is gone) — just the current measurement. */
export interface InsightsTile {
  value: number;
  noData: boolean;
  detail: string;
}

export interface InsightsWaitingRow {
  productGid: string;
  collectionId: string;
  collectionTitle: string;
  title: string;
  imageUrl: string | null;
  daysAgo: number | null; // null = never had a turn
  label: string; // "11 days" or "Never"
  urgent: boolean; // the worst two get the orange pill; the rest, grey
}

export interface InsightsCollectionTurnSquare {
  productGid: string;
  title: string;
  hadTurn: boolean;
  tooltip: string; // "Product — last seen 4 days ago" / "Product — never seen"
}

export interface InsightsCollectionTurnRow {
  id: string;
  title: string;
  seenCount: number;
  productCount: number;
  // "a turn every 2.8 days" — only set once MOST known products (>=50%)
  // have at least two recorded turns; a single fast outlier shouldn't make
  // the whole collection look like it's on a steady cadence.
  avgGapLabel: string | null;
  soldOut: boolean; // every known product's latest recorded state was unavailable
  lastTurnLabel: string; // "last turn today" / "last turn 3 days ago" / "never" — always has a value, unlike avgGapLabel
  squares: InsightsCollectionTurnSquare[]; // capped at 200
  moreCount: number; // beyond the 200 shown
}

export interface InsightsData {
  hasHistory: boolean;
  daysOfHistory: number;
  totalProducts: number;
  coverageSeenCount: number;
  coveragePct: number;
  rangeLabel: string; // "last 30 days" / "since install" — for the strip's subline
  rangeSentence: string; // "in the last 30 days" / "since you installed Shuffly" — for the strip's explanatory line

  // Strip's "Before Shuffly" / "Now" comparison — coveragePct above is
  // "now"; heroBeforePct is the same page-1-coverage math but measured on
  // the very first day Shuffly ever ran, as a fixed baseline (never moves
  // with the range picker, unlike coveragePct). Only shown when there's an
  // actual earlier day to compare against and the two numbers differ —
  // two identical bars read as a bug, not a result.
  heroBeforePct: number;
  heroShowComparison: boolean;
  heroNote: string; // shown instead of the bars when heroShowComparison is false

  rotationFairness: InsightsTile; // 0-100
  fairnessLabel: string; // "Fairly even sharing" / "Some products get more turns" / "A few products dominate"
  typicalWait: InsightsTile; // days
  longestWait: InsightsTile;
  longestWaitProduct: string | null;
  soldOutResponse: InsightsTile; // seconds

  distributionBars: Array<{ turns: number; belowHalfAvg: boolean }>;
  distributionAvg: number;
  distributionMax: number;
  distributionBucketed: boolean;
  distributionCaption: string;
  distributionAriaLabel: string;

  waitingLongest: InsightsWaitingRow[];
  byCollectionTurns: InsightsCollectionTurnRow[];
}

const EMPTY_TILE: InsightsTile = { value: 0, noData: true, detail: "Needs about a week of runs" };

const EMPTY_INSIGHTS: InsightsData = {
  hasHistory: false,
  daysOfHistory: 0,
  totalProducts: 0,
  coverageSeenCount: 0,
  coveragePct: 0,
  rangeLabel: "",
  rangeSentence: "",
  heroBeforePct: 0,
  heroShowComparison: false,
  heroNote: "",
  rotationFairness: EMPTY_TILE,
  fairnessLabel: "",
  typicalWait: EMPTY_TILE,
  longestWait: EMPTY_TILE,
  longestWaitProduct: null,
  soldOutResponse: EMPTY_TILE,
  distributionBars: [],
  distributionAvg: 0,
  distributionMax: 0,
  distributionBucketed: false,
  distributionCaption: "",
  distributionAriaLabel: "",
  waitingLongest: [],
  byCollectionTurns: [],
};

function resolveWindowStart(range: InsightsRange, installedAt: Date): Date {
  if (range === "7d") return new Date(Date.now() - 7 * 86_400_000);
  if (range === "30d") return new Date(Date.now() - 30 * 86_400_000);
  return installedAt;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Gap (in whole days) between each product's consecutive distinct-day
 * turns, pooled across every product — the median of that pool is
 * "typical wait". Rows are already page-1-only (see
 * recordProductPositions). */
function daysBetweenTurnsFor(rows: Array<{ productGid: string; dateKey: string }>): { value: number; hasData: boolean } {
  const byProduct = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byProduct.has(r.productGid)) byProduct.set(r.productGid, new Set());
    byProduct.get(r.productGid)!.add(r.dateKey);
  }
  const gaps: number[] = [];
  for (const dateKeys of byProduct.values()) {
    const days = Array.from(dateKeys)
      .map((k) => Date.parse(`${k}T00:00:00Z`))
      .sort((a, b) => a - b);
    for (let i = 1; i < days.length; i++) {
      gaps.push(Math.round((days[i] - days[i - 1]) / 86_400_000));
    }
  }
  // An empty gap pool isn't "0 days between turns" — that reads as instant
  // turnover, which is backwards. It means no product has had more than
  // one turn yet, i.e. not enough history to answer at all.
  return { value: median(gaps), hasData: gaps.length > 0 };
}

/** Standard pairwise-mean-difference form of the Gini coefficient — 0 means
 * perfectly even (every product has the same number of turns), 1 means
 * maximally uneven (one product has every turn, the rest have none). O(n²)
 * is fine here: even a large tracked catalogue is a few hundred products,
 * not the kind of scale that needs a sorted-cumulative-sum shortcut. */
function giniCoefficient(values: number[]): number {
  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  if (n === 0 || sum === 0) return 0;
  let sumAbsDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) sumAbsDiff += Math.abs(values[i] - values[j]);
  }
  return sumAbsDiff / (2 * n * sum);
}

function fairnessLabelFor(score: number): string {
  if (score >= 80) return "Fairly even sharing";
  if (score >= 60) return "Some products get more turns";
  return "A few products dominate";
}

export async function computeInsights(shop: string, range: InsightsRange, timezone: string, pageSize: number, installedAt: Date): Promise<InsightsData> {
  const key = cacheKey(shop, range, pageSize);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const data = await computeInsightsUncached(shop, range, timezone, pageSize, installedAt);
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function computeInsightsUncached(
  shop: string,
  range: InsightsRange,
  timezone: string,
  pageSize: number,
  installedAt: Date,
): Promise<InsightsData> {
  const earliest = await db.productPosition.findFirst({ where: { shop }, orderBy: { recordedAt: "asc" } });
  if (!earliest) return EMPTY_INSIGHTS;

  const windowStart = resolveWindowStart(range, installedAt);
  const daysOfHistory = Math.max(0, Math.floor((Date.now() - earliest.recordedAt.getTime()) / 86_400_000));
  const enoughHistory = daysOfHistory >= 7;
  const rangeLabel = range === "install" ? "since install" : `last ${range === "7d" ? "7" : "30"} days`;
  const rangeSentence = range === "install" ? "since you installed Shuffly" : `in the ${rangeLabel}`;
  const todayDateKey = dateKeyInTz(new Date(), timezone);

  const tracked = await db.collectionConfig.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
  const totalProducts = tracked.reduce((sum, c) => sum + c.productCount, 0);
  const trackedIds = tracked.map((c) => c.id);
  if (trackedIds.length === 0 || totalProducts === 0) return { ...EMPTY_INSIGHTS, hasHistory: true, daysOfHistory, rangeLabel, rangeSentence };

  const [inRange, exposures] = await Promise.all([
    // Every row here already satisfies position <= pageSize by construction
    // (see recordProductPositions) — "had a turn" is just "has a row".
    db.productPosition.findMany({
      where: { shop, collectionId: { in: trackedIds }, recordedAt: { gte: windowStart } },
      select: { productGid: true, collectionId: true, dateKey: true, availableForSale: true, recordedAt: true },
      orderBy: { recordedAt: "asc" },
    }),
    // The full known-product roster per tracked collection, page 1 or not
    // — see recordKnownProducts. This is what lets "waiting longest" and
    // the square grid name a product that's never had a turn at all.
    db.productExposure.findMany({ where: { shop, collectionId: { in: trackedIds } } }),
  ]);

  // ---- turns per (product, collection) pair — the one counting
  // convention every metric below shares, so none of them can disagree
  // with each other the way the old coverage hero and rows once did. A
  // product tracked in two collections (this store's "Automated
  // Collection" and its copies, for instance) contributes one entry per
  // collection it's actually in, matching how productCount itself sums. ----
  const turnDaysByPair = new Map<string, Set<string>>(); // `${collectionId}|${productGid}` -> dateKeys
  // Latest-wins since `inRange` is ordered by recordedAt ascending — this
  // is what tells a genuinely sold-out single-product collection ("Gift
  // Card: 1 of 1 · sold out") apart from one that just doesn't have two
  // turns yet to measure a gap between.
  const latestAvailabilityByPair = new Map<string, boolean>();
  for (const r of inRange) {
    const k = `${r.collectionId}|${r.productGid}`;
    if (!turnDaysByPair.has(k)) turnDaysByPair.set(k, new Set());
    turnDaysByPair.get(k)!.add(r.dateKey);
    latestAvailabilityByPair.set(k, r.availableForSale);
  }
  const exposuresByCollection = new Map<string, typeof exposures>();
  for (const e of exposures) {
    if (!exposuresByCollection.has(e.collectionId)) exposuresByCollection.set(e.collectionId, []);
    exposuresByCollection.get(e.collectionId)!.push(e);
  }

  const turnCounts: number[] = []; // one entry per product-collection pair, known and anonymous alike
  let seenPairCount = 0;
  for (const c of tracked) {
    const known = exposuresByCollection.get(c.id) ?? [];
    for (const e of known) {
      const turns = turnDaysByPair.get(`${c.id}|${e.productGid}`)?.size ?? 0;
      turnCounts.push(turns);
      if (turns > 0) seenPairCount++;
    }
    // Products this collection has (by its live product count) that have
    // never once been observed in any run at all — real, just unnamed.
    const unknownCount = Math.max(0, c.productCount - known.length);
    for (let i = 0; i < unknownCount; i++) turnCounts.push(0);
  }

  // ---- coverage ----
  const coverageSeenCount = seenPairCount;
  const coveragePct = totalProducts > 0 ? Math.round((coverageSeenCount / totalProducts) * 100) : 0;

  // ---- strip's "Before Shuffly" baseline — a fixed day-1 snapshot, never
  // moving with the range picker, so it's an honest "where you started"
  // number rather than shifting under the visitor's feet. ----
  const day1Rows = await db.productPosition.findMany({
    where: { shop, collectionId: { in: trackedIds }, dateKey: earliest.dateKey },
    select: { productGid: true, collectionId: true },
  });
  const day1Pairs = new Set(day1Rows.map((r) => `${r.collectionId}|${r.productGid}`));
  const heroBeforePct = totalProducts > 0 ? Math.round((day1Pairs.size / totalProducts) * 100) : 0;
  const heroShowComparison = earliest.dateKey !== todayDateKey && heroBeforePct !== coveragePct;
  const heroNote =
    earliest.dateKey === todayDateKey
      ? "First day of tracking — check back tomorrow to see how this moves."
      : "No change yet — coverage has held steady since day one.";

  // ---- rotation fairness ----
  const gini = giniCoefficient(turnCounts);
  const fairnessScore = Math.round((1 - gini) * 100);
  const rotationFairness: InsightsTile = enoughHistory
    ? { value: fairnessScore, noData: false, detail: fairnessLabelFor(fairnessScore) }
    : { ...EMPTY_TILE };
  const fairnessLabel = enoughHistory ? fairnessLabelFor(fairnessScore) : "";

  // ---- typical wait ----
  const typicalWaitResult = daysBetweenTurnsFor(inRange);
  const typicalWait: InsightsTile =
    enoughHistory && typicalWaitResult.hasData
      ? { value: typicalWaitResult.value, noData: false, detail: "between turns on page 1" }
      : { ...EMPTY_TILE };

  // ---- longest wait ----
  // Deliberately NOT gated on `enoughHistory` like the other three tiles:
  // it's a single "time since last turn" read, not a statistic that needs
  // several turns to be meaningful — real from day one, as soon as any
  // product has a recorded turn to measure "since" from.
  const now = Date.now();
  const withLastSeen = exposures
    .filter((e) => e.lastSeenPage1At)
    .map((e) => ({ ...e, daysAgo: Math.max(0, Math.round((now - e.lastSeenPage1At!.getTime()) / 86_400_000)) }));
  const worstFinite = withLastSeen.length ? withLastSeen.reduce((a, b) => (b.daysAgo > a.daysAgo ? b : a)) : null;
  const longestWait: InsightsTile = worstFinite ? { value: worstFinite.daysAgo, noData: false, detail: "" } : { ...EMPTY_TILE };
  const longestWaitProduct = worstFinite ? worstFinite.productTitle : null;

  // ---- sold-out response ----
  // Median seconds from when our handler starts processing the sold-out
  // reaction to the demotion write completing (ShuffleRun.durationMs on a
  // SOLD_OUT_REACTION run) — the closest thing we can measure without a
  // second, separate "webhook received" timestamp; Shopify's own dispatch
  // delay before we start isn't observable from here.
  const soldOutRuns = await db.shuffleRun.findMany({
    where: { shop, collectionId: { in: trackedIds }, trigger: "SOLD_OUT_REACTION", createdAt: { gte: windowStart } },
    select: { durationMs: true },
  });
  const soldOutSeconds = soldOutRuns.map((r) => r.durationMs / 1000);
  const soldOutResponse: InsightsTile =
    enoughHistory && soldOutSeconds.length > 0
      ? { value: Math.round(median(soldOutSeconds)), noData: false, detail: "to push one to the end" }
      : { ...EMPTY_TILE };

  // ---- distribution: one bar per product, tallest first ----
  const sortedTurns = [...turnCounts].sort((a, b) => b - a);
  const distributionAvg = sortedTurns.length ? sortedTurns.reduce((a, b) => a + b, 0) / sortedTurns.length : 0;
  const distributionMax = sortedTurns[0] ?? 0;
  const BUCKET_THRESHOLD = 120;
  const BUCKET_COUNT = 60;
  const distributionBucketed = sortedTurns.length > BUCKET_THRESHOLD;
  let distributionValues = sortedTurns;
  if (distributionBucketed) {
    const bucketSize = Math.ceil(sortedTurns.length / BUCKET_COUNT);
    const buckets: number[] = [];
    for (let i = 0; i < sortedTurns.length; i += bucketSize) {
      const slice = sortedTurns.slice(i, i + bucketSize);
      buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    distributionValues = buckets;
  }
  const halfAvg = distributionAvg / 2;
  const distributionBars = distributionValues.map((turns) => ({ turns, belowHalfAvg: turns < halfAvg }));

  const darkCount = distributionBars.filter((b) => b.belowHalfAvg).length;
  // Bars are sorted tallest-first, so the dark group occupies the tail —
  // its BOUNDARY value (the first/highest bar within that dark group) is
  // "N or fewer", not the single darkest bar's own count, which would
  // understate how many bars are actually at or below that ceiling.
  const darkBoundaryTurns = darkCount > 0 ? Math.round(distributionBars[distributionBars.length - darkCount].turns) : 0;
  const lowestTurns = distributionBars.length ? Math.round(distributionBars[distributionBars.length - 1].turns) : 0;
  const topTurns = distributionBars.length ? Math.round(distributionBars[0].turns) : 0;
  const distributionCaption =
    darkCount > 0
      ? `Your ${spellSmall(darkCount)} darkest bar${darkCount === 1 ? "" : "s"} ${darkCount === 1 ? "has" : "have"} had ${spellSmall(darkBoundaryTurns)} or fewer turns while the top has had ${spellSmall(topTurns)}.`
      : `Turns are spread evenly — nothing is more than half the average behind the leader.`;
  const distributionAriaLabel = `Turn distribution across ${turnCounts.length} products${distributionBucketed ? `, bucketed into ${distributionValues.length} bars` : ""}: highest ${topTurns} turns, lowest ${lowestTurns} turns, average ${Math.round(distributionAvg * 10) / 10}.`;

  // ---- waiting longest: top 5 by days since last turn, "Never" sorts worst ----
  const SENTINEL = Number.MAX_SAFE_INTEGER;
  const neverEntries = exposures.filter((e) => !e.lastSeenPage1At);
  const waitingCandidates = [
    ...withLastSeen.map((e) => ({ ...e, sortKey: e.daysAgo })),
    ...neverEntries.map((e) => ({ ...e, daysAgo: null as number | null, sortKey: SENTINEL })),
  ].sort((a, b) => b.sortKey - a.sortKey);
  const waitingLongest: InsightsWaitingRow[] = waitingCandidates.slice(0, 5).map((e, idx) => {
    const collectionTitle = tracked.find((c) => c.id === e.collectionId)?.title ?? "";
    return {
      productGid: e.productGid,
      collectionId: e.collectionId,
      collectionTitle,
      title: e.productTitle,
      imageUrl: null, // hydrated with a live thumbnail lookup in the route loader
      daysAgo: e.daysAgo,
      label: e.daysAgo == null ? "Never" : `${e.daysAgo} day${e.daysAgo === 1 ? "" : "s"}`,
      urgent: idx < 2,
    };
  });

  // ---- who's had a turn: per collection, sorted lowest coverage first ----
  const byCollectionTurns: InsightsCollectionTurnRow[] = tracked
    .map((c) => {
      const known = exposuresByCollection.get(c.id) ?? [];
      const seen = known.filter((e) => (turnDaysByPair.get(`${c.id}|${e.productGid}`)?.size ?? 0) > 0).length;
      // A cadence is only worth stating when it describes the collection,
      // not one fast outlier — require most (>=50%) known products to have
      // at least two recorded turns of their own before averaging a gap.
      const productsWithGap = known.filter((e) => (turnDaysByPair.get(`${c.id}|${e.productGid}`)?.size ?? 0) >= 2).length;
      const gap = daysBetweenTurnsFor(
        known.flatMap((e) => Array.from(turnDaysByPair.get(`${c.id}|${e.productGid}`) ?? []).map((dateKey) => ({ productGid: e.productGid, dateKey }))),
      );
      const avgGapLabel = gap.hasData && known.length > 0 && productsWithGap / known.length >= 0.5 ? `a turn every ${Math.round(gap.value * 10) / 10} days` : null;
      // No gap to average yet (a single-product collection can never have
      // one — "between" needs at least two turns). If that lone product's
      // most recent recorded state was unavailable, say so — a real,
      // checked fact, not a guess from row counts.
      const soldOut = known.length > 0 && known.every((e) => latestAvailabilityByPair.get(`${c.id}|${e.productGid}`) === false);
      // "Last turn" always has a value (unlike the cadence above), so it's
      // the fallback the pill can lean on — the most recent page-1 date
      // across every product this collection actually has.
      const lastSeenTimes = known.map((e) => e.lastSeenPage1At?.getTime()).filter((t): t is number => t != null);
      const lastTurnDaysAgo = lastSeenTimes.length ? Math.max(0, Math.round((now - Math.max(...lastSeenTimes)) / 86_400_000)) : null;
      const lastTurnLabel = lastTurnDaysAgo == null ? "never" : lastTurnDaysAgo === 0 ? "last turn today" : `last turn ${lastTurnDaysAgo} day${lastTurnDaysAgo === 1 ? "" : "s"} ago`;
      const squareSource = known.slice(0, 200);
      const squares: InsightsCollectionTurnSquare[] = squareSource.map((e) => {
        const hadTurn = (turnDaysByPair.get(`${c.id}|${e.productGid}`)?.size ?? 0) > 0;
        const daysAgo = e.lastSeenPage1At ? Math.max(0, Math.round((now - e.lastSeenPage1At.getTime()) / 86_400_000)) : null;
        const tooltip = `${e.productTitle} — ${daysAgo == null ? "never seen" : daysAgo === 0 ? "seen today" : `last seen ${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`}`;
        return { productGid: e.productGid, title: e.productTitle, hadTurn, tooltip };
      });
      return {
        id: c.id,
        title: c.title,
        seenCount: seen,
        productCount: c.productCount,
        avgGapLabel,
        soldOut,
        lastTurnLabel,
        squares,
        moreCount: Math.max(0, known.length - squares.length),
      };
    })
    .sort((a, b) => {
      const pctA = a.productCount > 0 ? a.seenCount / a.productCount : 0;
      const pctB = b.productCount > 0 ? b.seenCount / b.productCount : 0;
      return pctA - pctB; // lowest coverage first — the problems belong at the top
    });

  return {
    hasHistory: true,
    daysOfHistory,
    totalProducts,
    coverageSeenCount,
    coveragePct,
    rangeLabel,
    rangeSentence,
    heroBeforePct,
    heroShowComparison,
    heroNote,
    rotationFairness,
    fairnessLabel,
    typicalWait,
    longestWait,
    longestWaitProduct,
    soldOutResponse,
    distributionBars,
    distributionAvg,
    distributionMax,
    distributionBucketed,
    distributionCaption,
    distributionAriaLabel,
    waitingLongest,
    byCollectionTurns,
  };
}

function spellSmall(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  return n >= 0 && n <= 12 ? words[n] : String(n);
}

/** "Put these first tomorrow" — merges the given products into each of
 * their collection's one-time priority-boost list, consumed on that
 * collection's next run (see shuffle-algorithm.server.ts). */
export async function boostProductsForNextRun(shop: string, items: Array<{ productGid: string; collectionId: string }>): Promise<number> {
  if (items.length === 0) return 0;
  const byCollection = new Map<string, Set<string>>();
  for (const item of items) {
    if (!byCollection.has(item.collectionId)) byCollection.set(item.collectionId, new Set());
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
      return db.collectionConfig.update({ where: { id: c.id }, data: { priorityBoostIds: JSON.stringify(merged) } });
    }),
  );

  return items.length;
}
