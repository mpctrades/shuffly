import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, useFetchers, useRevalidator, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import {
  hydrateTrackedCollections,
  listAllCollections,
  setCollectionManualSort,
  sortOrderLabel,
  type ShopifyCollectionSummary,
} from "../lib/collections.server";
import { runShuffleForCollection } from "../lib/shuffle-engine.server";
import { previewShuffleAll } from "../lib/shuffle-preview.server";
import { computeNextRun, formatActivityTimestamp, type ScheduleType } from "../lib/schedule.server";
import { planOf } from "../lib/plans.server";
import { closeModal } from "../lib/polaris-modal";
import { CollectionRow, type CollectionRowData } from "../components/CollectionRow";
import {
  CollectionsFilterBar,
  type CollectionStatusFilter,
  type CollectionSortKey,
} from "../components/CollectionsFilterBar";
import { ShuffleAllConfirmModal } from "../components/ShuffleAllConfirmModal";
import { AddCollectionsModal, type AddCollectionsPickerData } from "../components/AddCollectionsModal";
import { SwitchToManualModal, type SwitchToManualTarget } from "../components/SwitchToManualModal";
import { BulkRemoveConfirmModal } from "../components/BulkRemoveConfirmModal";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SPARKLINE_LENGTH = 7;

interface AttentionLine {
  key: string;
  message: string;
  actionLabel: string;
  actionKind: "pause" | "switch";
  id?: string; // pause target — CollectionConfig id
  switchTarget?: SwitchToManualTarget; // switch target
}

interface UntrackedCollectionItem {
  gid: string;
  title: string;
  productsCount: number;
  sortOrder: string;
  sortOrderLabel: string;
}

// ============================== loader ==============================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const now = new Date();

  const settings = await getOrCreateShopSettings(admin, shop);

  const [tracked, allShopCollections] = await Promise.all([
    db.collectionConfig.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
    // One full-catalogue fetch (batched, paginated internally, not one call
    // per collection) covers store-wide totals, every tracked collection's
    // live sort order/product count, AND every untracked collection's name/
    // sort order for the "Not shuffled yet" card below.
    listAllCollections(admin).catch((err) => {
      console.error("[app.collections] listAllCollections failed:", err);
      return null;
    }),
  ]);

  const hydrationFailed = allShopCollections == null;
  const liveByGid = new Map<string, ShopifyCollectionSummary>((allShopCollections ?? []).map((c) => [c.id, c]));
  const trackedIds = tracked.map((t) => t.id);

  const [latestRuns, recentRuns, lastScheduledRun] = await Promise.all([
    trackedIds.length
      ? db.shuffleRun.findMany({
          where: { shop, collectionId: { in: trackedIds } },
          orderBy: { createdAt: "desc" },
          distinct: ["collectionId"],
        })
      : Promise.resolve([]),
    // Over-fetch a generous recent window (not one query per collection)
    // and slice the last 7 per collection in memory below — SQLite/Prisma
    // has no single-query "top N per group".
    trackedIds.length
      ? db.shuffleRun.findMany({
          where: { shop, collectionId: { in: trackedIds } },
          orderBy: { createdAt: "desc" },
          take: Math.max(50, trackedIds.length * 20),
        })
      : Promise.resolve([]),
    trackedIds.length
      ? db.shuffleRun.findFirst({
          where: { shop, collectionId: { in: trackedIds }, trigger: "SCHEDULED" },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve(null),
  ]);
  const latestRunByCollectionId = new Map(latestRuns.map((r) => [r.collectionId, r]));

  const recentRunsByCollectionId = new Map<string, typeof recentRuns>();
  for (const run of recentRuns) {
    const list = recentRunsByCollectionId.get(run.collectionId) ?? [];
    if (list.length < SPARKLINE_LENGTH) list.push(run);
    recentRunsByCollectionId.set(run.collectionId, list);
  }

  // "Last night": every run sharing the most recent SCHEDULED sweep's
  // batchId — one shared id per shop-wide cron tick (see cron.server.ts) —
  // summed into one figure, with a critical override if any of them failed.
  let lastBatch: {
    totalMoved: number;
    anyFailed: boolean;
    failedTitles: string[];
    at: Date;
  } | null = null;
  if (lastScheduledRun?.batchId) {
    const batchRuns = await db.shuffleRun.findMany({
      where: { shop, batchId: lastScheduledRun.batchId },
    });
    const titleById = new Map(tracked.map((t) => [t.id, t.title]));
    lastBatch = {
      totalMoved: batchRuns.reduce((sum, r) => sum + r.movedCount, 0),
      anyFailed: batchRuns.some((r) => r.status === "FAILED"),
      failedTitles: batchRuns.filter((r) => r.status === "FAILED").map((r) => titleById.get(r.collectionId) ?? "A collection"),
      at: lastScheduledRun.createdAt,
    };
  }

  const fullRows = tracked.map((c) => {
    const live = liveByGid.get(c.collectionGid);
    const needsAttention = !hydrationFailed && live != null && live.sortOrder !== "MANUAL";
    const liveCount = live?.productsCount ?? c.productCount;
    // Best-effort, not a live full-catalogue check: "every product sold
    // out" is inferred from the last shuffle run's sold-out count matching
    // the live product count — cheap, and right unless inventory changed
    // since that run.
    const allSoldOut = c.lastSoldOutCount != null && c.lastSoldOutCount > 0 && liveCount > 0 && c.lastSoldOutCount >= liveCount;
    return { config: c, live, needsAttention, allSoldOut };
  });

  const trackedGidSet = new Set(tracked.map((t) => t.collectionGid));

  // ---- status row ----
  const runningCount = tracked.filter((t) => t.status === "RUNNING").length;
  const pausedCount = tracked.length - runningCount;
  const soonestNextRunMs = tracked
    .filter((t) => t.status === "RUNNING" && t.nextRunAt)
    .map((t) => t.nextRunAt!.getTime())
    .sort((a, b) => a - b)[0];
  const totalProductsInRotation = fullRows.reduce((sum, r) => sum + (r.live?.productsCount ?? r.config.productCount), 0);
  const productsActuallyMoving = fullRows.reduce((sum, r) => sum + (latestRunByCollectionId.get(r.config.id)?.movedCount ?? 0), 0);

  // ---- inline attention strip (max 3 shown, "and N more" — capped client-side) ----
  const attentionLines: AttentionLine[] = [
    ...fullRows
      .filter((r) => r.allSoldOut && r.config.status === "RUNNING")
      .map((r) => ({
        key: `soldout-${r.config.id}`,
        message: `${r.config.title} has nothing in stock to shuffle.`,
        actionLabel: "Pause it",
        actionKind: "pause" as const,
        id: r.config.id,
      })),
    ...fullRows
      .filter((r) => r.needsAttention && r.live)
      .map((r) => ({
        key: `sort-${r.config.id}`,
        message: `${r.config.title} can't be shuffled — it uses Shopify's ${sortOrderLabel(r.live!.sortOrder)} sort.`,
        actionLabel: "Switch to Manual",
        actionKind: "switch" as const,
        switchTarget: {
          id: r.config.id,
          gid: r.config.collectionGid,
          title: r.config.title,
          sortOrderLabel: sortOrderLabel(r.live!.sortOrder),
        },
      })),
  ];

  // ---- rows (all tracked — filtering/sorting/paging happens client-side) ----
  const allGids = tracked.map((t) => t.collectionGid);
  const previewByGid = new Map<string, CollectionRowData["preview"]>();
  if (!hydrationFailed && allGids.length) {
    try {
      const hydrated = await hydrateTrackedCollections(admin, allGids);
      for (const [gid, h] of hydrated) previewByGid.set(gid, h.preview);
    } catch (err) {
      console.error("[app.collections] thumbnail hydration failed:", err);
    }
  }

  // A settings badge only carries information if it distinguishes a
  // collection from the others — "Sold-out last" on every single tracked
  // collection says nothing about any one of them. Uniform-across-all-
  // tracked settings are suppressed everywhere instead of shown on every
  // row (with 0 or 1 tracked collections this is vacuously true for all
  // four, which is the right call: nothing to distinguish means nothing
  // to badge).
  const uniform = <T,>(get: (c: (typeof tracked)[number]) => T): boolean =>
    tracked.every((c) => get(c) === get(tracked[0]));
  const pushSoldOutVaries = tracked.length > 0 && !uniform((c) => c.pushSoldOutToEnd);
  const boostNewArrivalsVaries = tracked.length > 0 && !uniform((c) => c.boostNewArrivals);
  const pinsVaries = tracked.length > 0 && !uniform((c) => c.pins);
  const giveEveryoneATurnVaries = tracked.length > 0 && !uniform((c) => c.giveEveryoneATurn);

  const rows: CollectionRowData[] = fullRows.map((r) => {
    const c = r.config;
    const live = r.live;
    const liveCount = live?.productsCount ?? c.productCount;

    const factsParts: string[] = [`${liveCount} product${liveCount === 1 ? "" : "s"}`];
    if (c.lastSoldOutCount != null && c.lastSoldOutCount > 0) factsParts.push(`${c.lastSoldOutCount} sold out`);

    const settingsBadges: string[] = [];
    if (c.pushSoldOutToEnd && pushSoldOutVaries) settingsBadges.push("Sold-out last");
    if (c.boostNewArrivals && boostNewArrivalsVaries) settingsBadges.push("New arrivals first");
    if (c.pins > 0 && pinsVaries) settingsBadges.push(`${c.pins} pin${c.pins === 1 ? "" : "s"}`);
    if (c.giveEveryoneATurn && giveEveryoneATurnVaries) settingsBadges.push("Fair rotation");

    const scheduleLine = c.status === "PAUSED" ? "Paused" : scheduleLabel(c.scheduleType, c.scheduleTime, c.scheduleWeekday);
    const scheduleSubLine =
      c.status === "PAUSED" ? "Resume to schedule" : c.nextRunAt ? "" : "Shuffles only when you press Shuffle";

    const latestRun = latestRunByCollectionId.get(c.id);
    const lastRun = latestRun
      ? {
          moved: latestRun.movedCount,
          whenLabel: lastRunLabel(latestRun.createdAt, settings.timezone, now),
          failed: latestRun.status === "FAILED",
          at: latestRun.createdAt,
        }
      : null;

    const recent = recentRunsByCollectionId.get(c.id) ?? []; // newest-first, up to 7
    const chronological = [...recent].reverse(); // oldest-first for left-to-right bars
    const padCount = Math.max(0, SPARKLINE_LENGTH - chronological.length);
    const sparkline: CollectionRowData["sparkline"] = [
      ...Array.from({ length: padCount }, () => null),
      ...chronological.map((run) => ({ moved: run.movedCount })),
    ];

    return {
      id: c.id,
      collectionGid: c.collectionGid,
      title: live?.title ?? c.title,
      status: c.status as "RUNNING" | "PAUSED",
      needsAttention: r.needsAttention,
      allSoldOut: r.allSoldOut,
      factsLine: factsParts.join(" · "),
      settingsBadges,
      preview: previewByGid.get(c.collectionGid) ?? [],
      scheduleLine,
      scheduleSubLine,
      nextRunAt: c.status === "RUNNING" ? c.nextRunAt : null,
      lastRun,
      sparkline,
    };
  });

  // ---- "Not shuffled yet" card: every untracked collection ----
  const untrackedCollections: UntrackedCollectionItem[] = hydrationFailed
    ? []
    : (allShopCollections ?? [])
        .filter((c) => !trackedGidSet.has(c.id))
        .map((c) => ({
          gid: c.id,
          title: c.title,
          productsCount: c.productsCount,
          sortOrder: c.sortOrder,
          sortOrderLabel: sortOrderLabel(c.sortOrder),
        }));

  const plan = planOf(settings.plan);

  return {
    rows,
    trackedTotal: tracked.length,
    totalStoreCollections: hydrationFailed ? null : (allShopCollections?.length ?? null),
    hydrationFailed,
    attentionLines,
    untrackedCollections,
    runningCount,
    pausedCount,
    nextRunAtMs: soonestNextRunMs ?? null,
    nextRunLabel: soonestNextRunMs ? dayRelativeClockLabel(new Date(soonestNextRunMs), settings.timezone, now) : null,
    totalProductsInRotation,
    productsActuallyMoving,
    lastBatch,
    planName: plan.name,
    planLimit: plan.maxCollections === Infinity ? null : plan.maxCollections,
  };
};

function scheduleLabel(type: string, time: string, weekday: number | null): string {
  switch (type) {
    case "DAILY":
      return `Daily at ${time}`;
    case "TWICE_DAILY":
      return "Twice daily";
    case "WEEKLY":
      return `Weekly, ${WEEKDAYS[weekday ?? 1]}`;
    default:
      return "Manual only";
  }
}

/** "today at 06:00" / "tomorrow at 06:00" / "26/08 at 06:00" — same
 * day-diff-via-UTC-midnight technique as schedule.server.ts's
 * activityDayAndTime, just for a FUTURE instant instead of a past one, so
 * it stays local to this route rather than growing that module's surface
 * for a single caller. */
function dayRelativeClockLabel(target: Date, timezone: string, now: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const partsOf = (d: Date) =>
    dtf.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const t = partsOf(target);
  const n = partsOf(now);
  const time = `${t.hour}:${t.minute}`;
  const dayDiff = Math.round(
    (Date.UTC(Number(t.year), Number(t.month) - 1, Number(t.day)) - Date.UTC(Number(n.year), Number(n.month) - 1, Number(n.day))) /
      86_400_000,
  );
  const dayLabel = dayDiff === 0 ? "today" : dayDiff === 1 ? "tomorrow" : `${t.month}/${t.day}`;
  return `${dayLabel} at ${time}`;
}

/** formatActivityTimestamp's "Today 06:01" / "Yesterday 14:22", lower-cased
 * to match this row's own copy style ("today 06:01"). */
function lastRunLabel(createdAt: Date, timezone: string, now: Date): string {
  return formatActivityTimestamp(createdAt, timezone, now)
    .replace(/^Today/, "today")
    .replace(/^Yesterday/, "yesterday");
}

// ============================== action ==============================

const DEFAULT_ADD_PRESET = { pins: 0, pushSoldOutToEnd: true, boostNewArrivals: false, giveEveryoneATurn: false };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("_action");
  const settings = await getOrCreateShopSettings(admin, shop);

  if (actionType === "add-collections") {
    const plan = planOf(settings.plan);
    const existingCount = await db.collectionConfig.count({ where: { shop } });
    const ids = formData.getAll("collectionGid").map(String);
    const startWith = String(formData.get("startWith") ?? "sold-out-only");
    const room = plan.maxCollections === Infinity ? ids.length : Math.max(0, plan.maxCollections - existingCount);
    const toAdd = ids.slice(0, room);

    let preset: typeof DEFAULT_ADD_PRESET;
    if (startWith === "same") {
      const first = await db.collectionConfig.findFirst({ where: { shop }, orderBy: { createdAt: "asc" } });
      preset = first
        ? {
            pins: first.pins,
            pushSoldOutToEnd: first.pushSoldOutToEnd,
            boostNewArrivals: first.boostNewArrivals,
            giveEveryoneATurn: first.giveEveryoneATurn,
          }
        : { pins: 0, pushSoldOutToEnd: true, boostNewArrivals: true, giveEveryoneATurn: true };
    } else if (startWith === "nothing") {
      preset = { pins: 0, pushSoldOutToEnd: false, boostNewArrivals: false, giveEveryoneATurn: false };
    } else {
      preset = DEFAULT_ADD_PRESET;
    }

    for (const gid of toAdd) {
      const title = String(formData.get(`collectionTitle:${gid}`) ?? "Collection");
      const nextRunAt = computeNextRun(new Date(), settings.timezone, "DAILY", settings.defaultRunTime, null);
      await db.collectionConfig.upsert({
        where: { shop_collectionGid: { shop, collectionGid: gid } },
        update: {},
        create: { shop, collectionGid: gid, title, scheduleTime: settings.defaultRunTime, nextRunAt, ...preset },
      });
    }
    return data({ ok: true, added: toAdd.length, skipped: ids.length - toAdd.length });
  }

  if (actionType === "add-untracked") {
    const plan = planOf(settings.plan);
    const existingCount = await db.collectionConfig.count({ where: { shop } });
    if (plan.maxCollections !== Infinity && existingCount >= plan.maxCollections) {
      return data({ ok: false, error: "You've reached your plan's collection limit." }, { status: 400 });
    }
    const gid = String(formData.get("gid"));
    const title = String(formData.get("title") ?? "Collection");
    const nextRunAt = computeNextRun(new Date(), settings.timezone, "DAILY", settings.defaultRunTime, null);
    await db.collectionConfig.upsert({
      where: { shop_collectionGid: { shop, collectionGid: gid } },
      update: {},
      create: { shop, collectionGid: gid, title, scheduleTime: settings.defaultRunTime, nextRunAt, ...DEFAULT_ADD_PRESET },
    });
    return data({ ok: true });
  }

  if (actionType === "switch-and-add") {
    const plan = planOf(settings.plan);
    const existingCount = await db.collectionConfig.count({ where: { shop } });
    if (plan.maxCollections !== Infinity && existingCount >= plan.maxCollections) {
      return data({ ok: false, error: "You've reached your plan's collection limit." }, { status: 400 });
    }
    const gid = String(formData.get("gid"));
    const title = String(formData.get("title") ?? "Collection");
    const switched = await setCollectionManualSort(admin, gid);
    if (!switched.ok) return data({ ok: false, error: switched.error ?? "Couldn't switch that collection." }, { status: 400 });
    const nextRunAt = computeNextRun(new Date(), settings.timezone, "DAILY", settings.defaultRunTime, null);
    await db.collectionConfig.upsert({
      where: { shop_collectionGid: { shop, collectionGid: gid } },
      update: {},
      create: { shop, collectionGid: gid, title, scheduleTime: settings.defaultRunTime, nextRunAt, ...DEFAULT_ADD_PRESET },
    });
    return data({ ok: true });
  }

  if (actionType === "add-all-untracked") {
    const gids = formData.getAll("gid").map(String);
    const titles = formData.getAll("title").map(String);
    const sortOrders = formData.getAll("sortOrder").map(String);
    const plan = planOf(settings.plan);
    const existingCount = await db.collectionConfig.count({ where: { shop } });
    const room = plan.maxCollections === Infinity ? gids.length : Math.max(0, plan.maxCollections - existingCount);
    let added = 0;
    for (let i = 0; i < gids.length && added < room; i++) {
      const gid = gids[i];
      if (sortOrders[i] !== "MANUAL") {
        const switched = await setCollectionManualSort(admin, gid);
        if (!switched.ok) continue;
      }
      const nextRunAt = computeNextRun(new Date(), settings.timezone, "DAILY", settings.defaultRunTime, null);
      await db.collectionConfig.upsert({
        where: { shop_collectionGid: { shop, collectionGid: gid } },
        update: {},
        create: { shop, collectionGid: gid, title: titles[i] ?? "Collection", scheduleTime: settings.defaultRunTime, nextRunAt, ...DEFAULT_ADD_PRESET },
      });
      added++;
    }
    return data({ ok: true, added, skipped: gids.length - added });
  }

  if (actionType === "switch-to-manual") {
    const id = String(formData.get("id"));
    const gid = String(formData.get("gid"));
    const keepOrder = formData.get("keepOrder") !== "false";
    const config = await db.collectionConfig.findFirst({ where: { id, shop } });
    if (!config) return data({ ok: false, error: "That collection couldn't be found." }, { status: 404 });

    const result = await setCollectionManualSort(admin, gid);
    if (!result.ok) return data(result);

    await db.collectionConfig.update({
      where: { id },
      data: { status: "RUNNING", previousSortOrder: result.previousSortOrder },
    });

    if (!keepOrder) {
      await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL", undefined, settings.pageSize);
    }
    return data({ ok: true });
  }

  if (actionType === "pause" || actionType === "resume") {
    const id = String(formData.get("id"));
    const config = await db.collectionConfig.findFirst({ where: { id, shop } });
    if (!config) return data({ ok: false }, { status: 404 });
    const nextStatus = actionType === "pause" ? "PAUSED" : "RUNNING";
    const nextRunAt =
      nextStatus === "RUNNING"
        ? computeNextRun(new Date(), settings.timezone, config.scheduleType as ScheduleType, config.scheduleTime, config.scheduleWeekday)
        : null;
    await db.$transaction([
      db.collectionConfig.update({ where: { id }, data: { status: nextStatus, nextRunAt } }),
      db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger: nextStatus === "PAUSED" ? "PAUSED" : "RESUMED",
          status: "OK",
          message: nextStatus === "PAUSED" ? `${config.title} paused` : `${config.title} resumed`,
        },
      }),
    ]);
    return data({ ok: true });
  }

  if (actionType === "pause-all") {
    const running = await db.collectionConfig.findMany({ where: { shop, status: "RUNNING" } });
    await db.$transaction([
      db.collectionConfig.updateMany({ where: { shop, status: "RUNNING" }, data: { status: "PAUSED", nextRunAt: null } }),
      ...running.map((c) =>
        db.shuffleRun.create({
          data: { shop, collectionId: c.id, trigger: "PAUSED", status: "OK", message: `${c.title} paused` },
        }),
      ),
    ]);
    return data({ ok: true });
  }

  if (actionType === "bulk-pause" || actionType === "bulk-resume") {
    const ids = formData.getAll("id").map(String);
    const nextStatus = actionType === "bulk-pause" ? "PAUSED" : "RUNNING";
    const configs = await db.collectionConfig.findMany({ where: { id: { in: ids }, shop } });
    await db.$transaction(
      configs.flatMap((c) => {
        const nextRunAt =
          nextStatus === "RUNNING"
            ? computeNextRun(new Date(), settings.timezone, c.scheduleType as ScheduleType, c.scheduleTime, c.scheduleWeekday)
            : null;
        return [
          db.collectionConfig.update({ where: { id: c.id }, data: { status: nextStatus, nextRunAt } }),
          db.shuffleRun.create({
            data: {
              shop,
              collectionId: c.id,
              trigger: nextStatus === "PAUSED" ? "PAUSED" : "RESUMED",
              status: "OK",
              message: `${c.title} ${nextStatus === "PAUSED" ? "paused" : "resumed"}`,
            },
          }),
        ];
      }),
    );
    return data({ ok: true });
  }

  if (actionType === "bulk-shuffle") {
    const ids = formData.getAll("id").map(String);
    const configs = await db.collectionConfig.findMany({ where: { id: { in: ids }, shop, status: "RUNNING" } });
    let moved = 0;
    for (const config of configs) {
      const result = await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL", undefined, settings.pageSize);
      if (result.ok) moved += result.movedCount;
    }
    return data({ ok: true, collections: configs.length, moved });
  }

  if (actionType === "bulk-remove") {
    const ids = formData.getAll("id").map(String);
    await db.collectionConfig.deleteMany({ where: { id: { in: ids }, shop } });
    return data({ ok: true });
  }

  if (actionType === "remove") {
    const id = String(formData.get("id"));
    await db.collectionConfig.deleteMany({ where: { id, shop } });
    return data({ ok: true });
  }

  if (actionType === "shuffle-one") {
    const id = String(formData.get("id"));
    const config = await db.collectionConfig.findFirst({ where: { id, shop } });
    if (!config) return data({ ok: false }, { status: 404 });
    const result = await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL", undefined, settings.pageSize);
    return data(result);
  }

  if (actionType === "shuffle-remaining") {
    const onPageIds = formData.getAll("onPageId").map(String);
    const remaining = await db.collectionConfig.findMany({ where: { shop, status: "RUNNING", id: { notIn: onPageIds } } });
    let moved = 0;
    for (const config of remaining) {
      const result = await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL", undefined, settings.pageSize);
      if (result.ok) moved += result.movedCount;
    }
    return data({ ok: true, collections: remaining.length, moved });
  }

  if (actionType === "preview-shuffle-all") {
    const running = await db.collectionConfig.findMany({ where: { shop, status: "RUNNING" } });
    const preview = await previewShuffleAll(admin, shop, running, settings.neverMoveTags);
    return data(preview);
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
};

// ============================== component ==============================

const PAGE_SIZE = 25;

export default function Collections() {
  const {
    rows,
    trackedTotal,
    totalStoreCollections,
    hydrationFailed,
    attentionLines,
    untrackedCollections,
    runningCount,
    nextRunAtMs,
    nextRunLabel,
    totalProductsInRotation,
    productsActuallyMoving,
    lastBatch,
    planName,
    planLimit,
  } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const allFetchers = useFetchers();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const addModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const shuffleAllModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const switchModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const bulkRemoveModalRef = useRef<any>(null);

  const picker = useFetcher<AddCollectionsPickerData>({ key: "collections-picker" });
  const previewFetcher = useFetcher({ key: "shuffle-all-preview" });
  const remainingFetcher = useFetcher({ key: "shuffle-remaining" });
  const switchFetcher = useFetcher<{ ok: boolean; error?: string }>({ key: "switch-to-manual" });
  const addFetcher = useFetcher<{ ok: boolean; added?: number; skipped?: number }>({ key: "add-collections" });
  const bulkFetcher = useFetcher<{ ok: boolean; moved?: number; collections?: number }>({ key: "bulk-action" });

  // ---- client-side search / filter / sort / page (spec: no server round-trip) ----
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<CollectionStatusFilter>("all");
  const [sort, setSort] = useState<CollectionSortKey>("next-run");
  const [page, setPage] = useState(1);

  const isRowAttention = (r: CollectionRowData) => r.needsAttention || (r.allSoldOut && r.status === "RUNNING");

  const statusCounts = useMemo(
    () => ({
      all: rows.length,
      running: rows.filter((r) => r.status === "RUNNING").length,
      paused: rows.filter((r) => r.status === "PAUSED").length,
      attention: rows.filter(isRowAttention).length,
    }),
    [rows],
  );

  const filteredSortedRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const searched = needle ? rows.filter((r) => r.title.toLowerCase().includes(needle)) : rows;
    const filtered = searched.filter((r) => {
      if (status === "running") return r.status === "RUNNING";
      if (status === "paused") return r.status === "PAUSED";
      if (status === "attention") return isRowAttention(r);
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      switch (sort) {
        case "products": {
          const av = Number(a.factsLine.match(/^(\d+)/)?.[1] ?? 0);
          const bv = Number(b.factsLine.match(/^(\d+)/)?.[1] ?? 0);
          return bv - av;
        }
        case "last-run": {
          const av = a.lastRun ? new Date(a.lastRun.at).getTime() : 0;
          const bv = b.lastRun ? new Date(b.lastRun.at).getTime() : 0;
          return bv - av;
        }
        case "name":
          return a.title.localeCompare(b.title);
        default: // next-run
          return (a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity) - (b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity);
      }
    });
    return sorted;
  }, [rows, q, status, sort]);

  const totalPages = Math.max(1, Math.ceil(filteredSortedRows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = filteredSortedRows.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [q, status, sort]);

  const [shuffleRunId, setShuffleRunId] = useState<number | null>(null);
  const [pendingRowIds, setPendingRowIds] = useState<Set<string>>(new Set());
  const [switchTarget, setSwitchTarget] = useState<SwitchToManualTarget | null>(null);
  const [awaitingAddModal, setAwaitingAddModal] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const shuffleWasActive = useRef(false);

  useEffect(() => {
    setSelected(new Set());
  }, [q, status, sort, clampedPage]);

  function openAddModal() {
    setAwaitingAddModal(true);
    picker.load("/app/collections/picker");
  }

  useEffect(() => {
    if (!awaitingAddModal || picker.state !== "idle" || !picker.data) return;
    setAwaitingAddModal(false);
    const { addable, nonManualCount } = picker.data;
    if (addable.length > 0) {
      addModalRef.current?.showOverlay();
    } else if (nonManualCount > 0) {
      shopify.toast.show(
        `${nonManualCount} collection${nonManualCount === 1 ? "" : "s"} use${nonManualCount === 1 ? "s" : ""} a different sort order. Switch ${nonManualCount === 1 ? "it" : "them"} to Manual sort first.`,
      );
    } else {
      shopify.toast.show("Every collection is already being shuffled.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only when the picker fetch this click triggered settles
  }, [awaitingAddModal, picker.state, picker.data]);

  function submitAddCollections(formData: FormData) {
    addFetcher.submit(formData, { method: "post" });
  }

  useEffect(() => {
    if (addFetcher.state === "idle" && addFetcher.data) {
      closeModal(addModalRef.current);
      if (addFetcher.data.ok) {
        const { added = 0, skipped = 0 } = addFetcher.data;
        shopify.toast.show(
          skipped > 0
            ? `${added} collection${added === 1 ? "" : "s"} added — ${skipped} skipped (plan limit)`
            : `${added} collection${added === 1 ? "" : "s"} added`,
        );
      } else {
        shopify.toast.show("Couldn't add that just now", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [addFetcher.state, addFetcher.data]);

  function openShuffleAllModal() {
    previewFetcher.submit({ _action: "preview-shuffle-all" }, { method: "post" });
    shuffleAllModalRef.current?.showOverlay();
  }

  function confirmShuffleAll() {
    closeModal(shuffleAllModalRef.current);
    if (trackedTotal === 0) return; // nothing tracked at all — the button wouldn't be visible anyway
    const runningOnPage = pageRows.filter((r) => r.status === "RUNNING" && !r.needsAttention);
    setPendingRowIds(new Set(runningOnPage.map((r) => r.id)));
    shuffleWasActive.current = true;
    setShuffleRunId((n) => (n ?? 0) + 1);
    remainingFetcher.submit(formDataOf({ _action: "shuffle-remaining", onPageId: pageRows.map((r) => r.id) }), { method: "post" });
  }

  function handleRowSettled(id: string) {
    setPendingRowIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  useEffect(() => {
    if (!shuffleWasActive.current) return;
    if (pendingRowIds.size === 0 && remainingFetcher.state === "idle") {
      shuffleWasActive.current = false;
      shopify.toast.show("Shuffle complete");
    }
  }, [pendingRowIds, remainingFetcher.state, shopify]);

  function openSwitchModal(target: SwitchToManualTarget) {
    setSwitchTarget(target);
    switchModalRef.current?.showOverlay();
  }

  function confirmSwitch(keepOrder: boolean) {
    if (!switchTarget) return;
    switchFetcher.submit(
      { _action: "switch-to-manual", id: switchTarget.id, gid: switchTarget.gid, keepOrder: String(keepOrder) },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (switchFetcher.state === "idle" && switchFetcher.data) {
      closeModal(switchModalRef.current);
      if (switchFetcher.data.ok) {
        shopify.toast.show(`${switchTarget?.title ?? "Collection"} switched to Manual sort`);
      } else {
        shopify.toast.show(switchFetcher.data.error ?? "Couldn't switch that collection", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [switchFetcher.state, switchFetcher.data]);

  function toggleSelect(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Which bulk action was last submitted — captured at submit time rather
  // than read off the fetcher, since react-router clears `formData` back to
  // undefined the moment the fetcher returns to "idle" (the exact moment
  // the settle effect below needs to know what just ran).
  const [lastBulkAction, setLastBulkAction] = useState<string | null>(null);

  function runBulk(actionName: "bulk-pause" | "bulk-resume" | "bulk-shuffle" | "bulk-remove") {
    setLastBulkAction(actionName);
    bulkFetcher.submit(formDataOf({ _action: actionName, id: Array.from(selected) }), { method: "post" });
  }

  function confirmBulkRemove() {
    closeModal(bulkRemoveModalRef.current);
    runBulk("bulk-remove");
  }

  useEffect(() => {
    if (bulkFetcher.state === "idle" && bulkFetcher.data?.ok) {
      setSelected(new Set());
      if (bulkFetcher.data.moved != null) {
        shopify.toast.show(
          `Shuffled ${bulkFetcher.data.collections ?? 0} collection${(bulkFetcher.data.collections ?? 0) === 1 ? "" : "s"} — ${bulkFetcher.data.moved} moved`,
        );
      } else if (lastBulkAction === "bulk-pause") {
        shopify.toast.show("Paused");
      } else if (lastBulkAction === "bulk-resume") {
        shopify.toast.show("Resumed");
      } else if (lastBulkAction === "bulk-remove") {
        shopify.toast.show("Removed from Shuffly");
      } else {
        shopify.toast.show("Done");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [bulkFetcher.state, bulkFetcher.data]);

  const hasAnythingTracked = trackedTotal > 0;
  const bulkBusy = bulkFetcher.state !== "idle";
  const pendingBulkAction = bulkBusy ? lastBulkAction : null;
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectionHasRunning = selectedRows.some((r) => r.status === "RUNNING");
  const selectionHasPaused = selectedRows.some((r) => r.status === "PAUSED");

  // Real-time poll: only while something is actually in flight — a fetcher
  // submitting/loading, or a RUNNING collection whose nextRunAt has already
  // passed (the in-process scheduler ticks once a minute, so there's a real
  // gap between "countdown hit zero" and "the row actually updated"). Never
  // otherwise — a page with nothing due sits completely idle, no requests.
  const anyActionFetcherBusy = allFetchers.some(
    (f) => f.state !== "idle" && typeof f.key === "string" && (f.key.startsWith("shuffle-") || f.key.startsWith("row-action-") || f.key === "bulk-action"),
  );
  const anyOverdueRunning = rows.some((r) => r.status === "RUNNING" && r.nextRunAt && new Date(r.nextRunAt).getTime() <= Date.now());
  const shouldPoll = anyActionFetcherBusy || anyOverdueRunning;
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(id);
  }, [shouldPoll, revalidator]);

  // Polaris relocates slot="primary-action"/"secondary-actions" children
  // into Shopify Admin's native title bar and mutates their own `style`
  // attribute as part of that (to hide them from the page's own flow) the
  // moment they connect — before React's hydration pass runs. React then
  // sees a `style` in the real DOM it never rendered itself and treats the
  // whole page as mismatched, discarding and rebuilding everything
  // client-side. suppressHydrationWarning tells React "trust what's
  // already there" for exactly that one, expected, third-party mutation,
  // instead of tearing down and re-mounting this route — which is what was
  // leaving ref-driven modals opened against a DOM node that had already
  // been discarded and replaced by the time the reader clicked it.
  // Not in the generated prop types (it's a React-only prop, not a real
  // attribute on these elements), so it's applied via a spread.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- suppressHydrationWarning is a React-only prop, absent from the generated custom-element prop types
  const noHydrationWarning = { suppressHydrationWarning: true } as any;

  const untrackedFetcher = useFetcher<{ ok: boolean; added?: number; skipped?: number }>({ key: "add-all-untracked" });
  function addAllUntracked() {
    untrackedFetcher.submit(
      formDataOf({
        _action: "add-all-untracked",
        gid: untrackedCollections.map((u) => u.gid),
        title: untrackedCollections.map((u) => u.title),
        sortOrder: untrackedCollections.map((u) => u.sortOrder),
      }),
      { method: "post" },
    );
  }
  useEffect(() => {
    if (untrackedFetcher.state === "idle" && untrackedFetcher.data?.ok) {
      shopify.toast.show(`${untrackedFetcher.data.added ?? 0} collection${(untrackedFetcher.data.added ?? 0) === 1 ? "" : "s"} added`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [untrackedFetcher.state, untrackedFetcher.data]);

  return (
    <s-page heading="Collections" {...noHydrationWarning}>
      <s-button slot="secondary-actions" onClick={openAddModal} {...noHydrationWarning}>
        Add collection
      </s-button>
      <s-button
        slot="secondary-actions"
        command="--toggle"
        commandFor="collections-overflow-menu"
        accessibilityLabel="More actions"
        {...noHydrationWarning}
      >
        ···
      </s-button>
      <s-menu id="collections-overflow-menu" accessibilityLabel="More actions">
        <s-button onClick={() => shopify.toast.show("Export isn't available yet")}>Export</s-button>
        <PauseAllButton />
      </s-menu>

      {hasAnythingTracked && (
        <s-button slot="primary-action" variant="primary" onClick={openShuffleAllModal} {...noHydrationWarning}>
          Shuffle all now
        </s-button>
      )}

      {hasAnythingTracked && !hydrationFailed && (
        <StatusRow
          runningCount={runningCount}
          nextRunLabel={nextRunLabel}
          nextRunAtMs={nextRunAtMs}
          lastBatch={lastBatch}
          totalProductsInRotation={totalProductsInRotation}
          productsActuallyMoving={productsActuallyMoving}
          trackedTotal={trackedTotal}
          totalStoreCollections={totalStoreCollections}
        />
      )}

      {hydrationFailed ? (
        <AttentionBanner
          tone="warning"
          heading="Couldn't load live data from Shopify"
          action={
            <s-button onClick={() => revalidator.revalidate()} {...(revalidator.state !== "idle" ? { loading: true } : {})}>
              Retry
            </s-button>
          }
        >
          Counts, thumbnails, and the &quot;needs attention&quot; check need a live connection — everything below
          still reflects what Shuffly is tracking, just without that extra detail for now.
        </AttentionBanner>
      ) : (
        <AttentionStrip
          lines={attentionLines}
          onSwitch={openSwitchModal}
          pauseFetcherKeyPrefix="row-action-"
        />
      )}

      <s-section padding="none">
        {hasAnythingTracked && trackedTotal > 5 && (
          <CollectionsFilterBar
            q={q}
            status={status}
            sort={sort}
            counts={statusCounts}
            onQChange={setQ}
            onStatusChange={setStatus}
            onSortChange={setSort}
          />
        )}

        {selected.size > 0 && (
          <div className="shuffly-bulk-bar">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <s-text type="strong">{selected.size} selected</s-text>
              <button type="button" className="shuffly-bulk-clear" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
                <XGlyph />
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" className="shuffly-bulk-btn shuffly-bulk-btn--primary" onClick={() => runBulk("bulk-shuffle")} disabled={bulkBusy}>
                {pendingBulkAction === "bulk-shuffle" ? "Shuffling…" : "Shuffle now"}
              </button>

              {selectionHasRunning && (
                <button type="button" className="shuffly-bulk-btn shuffly-bulk-btn--secondary" onClick={() => runBulk("bulk-pause")} disabled={bulkBusy}>
                  {pendingBulkAction === "bulk-pause" ? "Pausing…" : "Pause"}
                </button>
              )}
              {selectionHasPaused && (
                <button type="button" className="shuffly-bulk-btn shuffly-bulk-btn--secondary" onClick={() => runBulk("bulk-resume")} disabled={bulkBusy}>
                  {pendingBulkAction === "bulk-resume" ? "Resuming…" : "Resume"}
                </button>
              )}

              <span className="shuffly-bulk-divider" aria-hidden="true" />

              <button type="button" className="shuffly-bulk-btn shuffly-bulk-btn--critical" onClick={() => bulkRemoveModalRef.current?.showOverlay()} disabled={bulkBusy}>
                {pendingBulkAction === "bulk-remove" ? "Removing…" : "Remove from Shuffly"}
              </button>
            </div>
          </div>
        )}

        {pageRows.length === 0 && trackedTotal === 0 ? (
          <EmptyCollectionsState onAdd={openAddModal} />
        ) : pageRows.length === 0 ? (
          <s-box padding="large-500">
            <s-stack direction="block" gap="small" alignItems="center">
              <s-text color="subdued">No collections match this filter.</s-text>
            </s-stack>
          </s-box>
        ) : (
          <>
            <div className="shuffly-collections-grid-container">
              <CollectionsHeaderRow />
              {pageRows.map((r, i) => (
                <div key={r.id}>
                  <CollectionRow
                    collection={r}
                    shuffleRunId={pendingRowIds.has(r.id) ? shuffleRunId : null}
                    onShuffleSettled={handleRowSettled}
                    selected={selected.has(r.id)}
                    onToggleSelect={toggleSelect}
                  />
                  {i < pageRows.length - 1 && <s-divider />}
                </div>
              ))}
            </div>
            <s-divider />
            <div style={{ padding: "12px 16px" }}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text color="subdued">
                  {trackedTotal} of {totalStoreCollections ?? "?"} collections · {totalProductsInRotation} products in rotation
                  {" · "}Bars show the last 7 runs
                </s-text>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  {totalPages > 1 && (
                    <>
                      <s-button variant="tertiary" disabled={clampedPage <= 1 || undefined} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                        Previous
                      </s-button>
                      <s-button variant="tertiary" disabled={clampedPage >= totalPages || undefined} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                        Next
                      </s-button>
                    </>
                  )}
                  <s-button variant="tertiary" onClick={openAddModal}>
                    Add more
                  </s-button>
                </s-stack>
              </s-stack>
            </div>
          </>
        )}
      </s-section>

      {untrackedCollections.length > 0 && (
        <NotShuffledYetCard items={untrackedCollections} onAddAll={addAllUntracked} addingAll={untrackedFetcher.state !== "idle"} />
      )}

      {planLimit != null && (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <s-text color="subdued">
            {planName} plan · {trackedTotal} of {planLimit} collections used.{" "}
          </s-text>
          <Link to="/app/plan" className="shuffly-quiet-link" style={{ textDecoration: "underline" }}>
            See plans
          </Link>
        </div>
      )}

      <AddCollectionsModal ref={addModalRef} picker={picker} onSubmit={submitAddCollections} onCancel={() => closeModal(addModalRef.current)} />

      <ShuffleAllConfirmModal ref={shuffleAllModalRef} onConfirm={confirmShuffleAll} onCancel={() => closeModal(shuffleAllModalRef.current)} />

      <SwitchToManualModal
        ref={switchModalRef}
        target={switchTarget}
        busy={switchFetcher.state !== "idle"}
        onConfirm={confirmSwitch}
        onCancel={() => closeModal(switchModalRef.current)}
      />

      <BulkRemoveConfirmModal
        ref={bulkRemoveModalRef}
        titles={selectedRows.map((r) => r.title)}
        busy={bulkFetcher.state !== "idle"}
        onConfirm={confirmBulkRemove}
        onCancel={() => closeModal(bulkRemoveModalRef.current)}
      />

      <style>{`
        .shuffly-status-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin: 20px 0;
        }
        .shuffly-status-card {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 16px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 12px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-status-chip {
          flex: none;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .shuffly-status-label { font-size: 12px; color: var(--p-color-text-secondary, #6b6b6b); }
        .shuffly-status-value { font-size: 15px; font-weight: 700; color: var(--p-color-text, #131110); margin-top: 1px; }
        .shuffly-status-detail { font-size: 12px; color: var(--p-color-text-secondary, #6b6b6b); margin-top: 2px; }
        @container shuffly-status (max-width: 640px) {
          .shuffly-status-row { grid-template-columns: 1fr; }
        }
        /* Amber, not brand orange — "attention" is a semantic tone, and
           orange is reserved for exactly four things per spec (the Add-all
           button, the next-run chip, the sparkline bars, the selected-row
           accent). --p-color-*-caution is Polaris's real amber role; the
           hex fallback is a genuine gold/amber, deliberately a different
           hue from #FF4B1F so it never reads as "the brand color" here. */
        .shuffly-attention-strip {
          border: 1px solid var(--p-color-border-caution, #946200);
          background: var(--p-color-bg-fill-caution-secondary, #FFF4D6);
          border-radius: 10px;
          overflow: hidden;
          margin-bottom: 20px;
        }
        .shuffly-attention-line {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 16px;
          font-size: 13px;
        }
        .shuffly-attention-line + .shuffly-attention-line {
          border-top: 1px solid var(--p-color-border-caution, #946200);
        }
        .shuffly-attention-dot {
          flex: none;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--p-color-icon-caution, #946200);
        }
        .shuffly-attention-message { flex: 1 1 0%; min-width: 0; color: var(--p-color-text, #131110); }
        .shuffly-attention-message strong { font-weight: 600; }
        .shuffly-attention-action {
          flex: none;
          border: none;
          outline: none;
          background: transparent;
          padding: 0;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          color: var(--p-color-text-caution, #946200);
          text-decoration: underline;
          cursor: pointer;
        }
        .shuffly-attention-action:disabled { opacity: 0.6; cursor: default; }
        .shuffly-attention-more { padding: 8px 16px; font-size: 12px; color: var(--p-color-text-secondary, #6b6b6b); }
        /* The one grid template — shared verbatim by the header and every
           data row via the same .shuffly-row class, so there is exactly
           one definition, not two that could drift apart. All 6 cells
           (checkbox, collection, preview, schedule, last run, actions) are
           DIRECT children of this grid — no wrapper div in between, which
           is what was collapsing every cell into column 1 last time. */
        .shuffly-collections-grid-container {
          container-type: inline-size;
          container-name: shuffly-collections;
        }
        .shuffly-row {
          box-sizing: border-box;
          width: 100%;
          display: grid;
          grid-template-columns: 36px minmax(200px, 1fr) 110px 140px 120px 230px;
          align-items: center;
          column-gap: 16px;
          padding: 12px 16px;
          position: relative;
          min-height: 64px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-row:hover { background: var(--p-color-bg-surface-secondary, #f6f6f7); }
        .shuffly-row--header {
          min-height: 0;
          padding-top: 10px;
          padding-bottom: 10px;
          background: var(--p-color-bg-surface, #ffffff);
          border-bottom: 1px solid var(--p-color-border, #e3e3e3);
        }
        .shuffly-row--header:hover { background: var(--p-color-bg-surface, #ffffff); }
        .shuffly-row--header > * {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        /* The stretched link that makes the whole row open the collection
           — see CollectionRow.tsx for why this replaced s-clickable. Sits
           at the base stacking level (z-index 0); the checkbox and actions
           are lifted above it (z-index 1) so they keep receiving their own
           clicks, and everywhere else a click falls through to this link
           since nothing else there handles clicks. */
        .shuffly-row-link-overlay {
          position: absolute;
          inset: 0;
          z-index: 0;
        }
        .shuffly-row-select, .shuffly-row-actions { position: relative; z-index: 1; }
        .shuffly-row:has(> .shuffly-row-link-overlay:focus-visible),
        .shuffly-row:has(> .shuffly-row-actions :focus-visible) {
          outline: 2px solid var(--p-color-border-focus, #005bd3);
          outline-offset: -2px;
        }
        /* Amber, not brand orange — same "attention, not the brand" reasoning
           as the strip above. */
        .shuffly-row--sold-out {
          box-shadow: inset 3px 0 0 0 var(--p-color-border-caution, #946200);
        }
        /* The selected-row accent bar is one of the four sanctioned uses of
           brand orange — background tint stays the neutral info-blue
           Polaris already uses for "selected", only the bar itself is
           brand orange. */
        .shuffly-row--selected,
        .shuffly-row--selected:hover {
          background: var(--p-color-bg-fill-info-secondary, #EAF2FF);
          box-shadow: inset 3px 0 0 0 var(--p-color-bg-fill-warning, #FF4B1F);
        }
        .shuffly-row-select { display: flex; align-items: center; justify-content: center; }
        .shuffly-row-select s-checkbox { transform: scale(0.65); }
        .shuffly-row-text, .shuffly-thumbs, .shuffly-row-schedule, .shuffly-row-lastrun {
          min-width: 0;
        }
        .shuffly-row-title, .shuffly-row-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .shuffly-thumbs { display: flex; align-items: center; gap: 4px; }
        .shuffly-row-schedule, .shuffly-row-lastrun { text-align: left; }
        .shuffly-row-mobile-label { display: none; }
        .shuffly-sparkline { display: flex; align-items: flex-end; gap: 2px; height: 16px; margin-top: 4px; }
        .shuffly-sparkline-bar { width: 4px; border-radius: 1px; background: var(--p-color-bg-fill-warning, #FF4B1F); }
        .shuffly-sparkline-bar--empty { background: var(--p-color-bg-surface-tertiary, #e3e3e3); min-height: 3px; }
        .shuffly-row-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 4px;
          padding-right: 8px;
        }
        .shuffly-row-quick-buttons { display: flex; align-items: center; gap: 4px; }
        @container shuffly-collections (max-width: 820px) {
          .shuffly-row--header { display: none; }
          .shuffly-row:not(.shuffly-row--header) {
            grid-template-columns: 28px 1fr 1fr auto;
            grid-template-areas:
              "checkbox name     name    actions"
              "checkbox schedule lastrun actions";
            row-gap: 4px;
            min-height: 0;
          }
          .shuffly-row-select { grid-area: checkbox; align-self: start; }
          .shuffly-row-text { grid-area: name; }
          .shuffly-thumbs { display: none; }
          .shuffly-row-schedule { grid-area: schedule; text-align: left; }
          .shuffly-row-lastrun { grid-area: lastrun; text-align: left; }
          .shuffly-row-actions { grid-area: actions; align-self: start; }
          .shuffly-row-mobile-label {
            display: block;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: var(--p-color-text-secondary, #6b6b6b);
            margin-bottom: 2px;
          }
          .shuffly-row-quick-buttons { display: none; }
        }
        .shuffly-row-action-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 28px;
          padding: 0 10px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 6px;
          background: var(--p-color-bg-surface, #ffffff);
          color: var(--p-color-text, #131110);
          font: inherit;
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          cursor: pointer;
          outline: none;
          box-shadow: none;
        }
        .shuffly-row-action-btn:hover:not(:disabled) { background: var(--p-color-bg-surface-secondary, #f6f6f7); }
        .shuffly-row-action-btn:disabled { opacity: 0.5; cursor: default; }
        .shuffly-row-action-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 1px;
        }
        /* Green (success), not brand orange — resuming is a positive/
           "turned back on" action, the same semantic as the bulk bar's
           "Shuffle now"; orange stays reserved for the four spots above. */
        .shuffly-row-action-btn--primary {
          border-color: transparent;
          background: var(--p-color-bg-fill-success, #008060);
          color: #ffffff;
        }
        .shuffly-row-action-btn--primary:hover:not(:disabled) {
          background: var(--p-color-bg-fill-success-hover, #006e52);
        }
        .shuffly-bulk-bar {
          position: sticky;
          top: 0;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 36px;
          padding: 10px 16px;
          background: var(--p-color-bg-fill-success-secondary, #E3F5EE);
          border-bottom: 1px solid var(--p-color-border, #e3e3e3);
        }
        .shuffly-bulk-clear {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border: none;
          outline: none;
          border-radius: 50%;
          padding: 0;
          background: transparent;
          color: var(--p-color-icon-secondary, #6b6b6b);
          cursor: pointer;
        }
        .shuffly-bulk-clear:hover { background: var(--p-color-bg-surface-tertiary, #e3e3e3); }
        .shuffly-bulk-clear:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 1px;
        }
        .shuffly-bulk-divider {
          width: 1px;
          height: 20px;
          margin: 0 16px;
          flex: none;
          background: var(--p-color-border, #e3e3e3);
        }
        .shuffly-bulk-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 30px;
          padding: 0 12px;
          border-radius: 7px;
          font: inherit;
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          cursor: pointer;
          outline: none;
          box-shadow: none;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .shuffly-bulk-btn:disabled { cursor: default; opacity: 0.55; }
        .shuffly-bulk-btn--primary {
          border: none;
          background: var(--p-color-bg-fill-success, #008060);
          color: #ffffff;
        }
        .shuffly-bulk-btn--primary:hover:not(:disabled) { background: var(--p-color-bg-fill-success-hover, #006e52); }
        .shuffly-bulk-btn--primary:active:not(:disabled) { background: var(--p-color-bg-fill-success-active, #005940); }
        .shuffly-bulk-btn--secondary {
          border: 1px solid var(--p-color-border, #e3e3e3);
          background: var(--p-color-bg-surface, #ffffff);
          color: var(--p-color-text, #131110);
        }
        .shuffly-bulk-btn--secondary:hover:not(:disabled) { background: var(--p-color-bg-surface-secondary, #f6f6f7); }
        .shuffly-bulk-btn--critical {
          border: 1px solid var(--p-color-border, #e3e3e3);
          background: var(--p-color-bg-surface, #ffffff);
          color: var(--p-color-text-critical, #D82C0D);
        }
        .shuffly-bulk-btn--critical:hover:not(:disabled) {
          border-color: var(--p-color-border-critical, #D82C0D);
          background: var(--p-color-bg-fill-critical-secondary, #fee9e8);
        }
        .shuffly-bulk-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
        .shuffly-collections-filters {
          display: inline-flex;
          flex-wrap: wrap;
          padding: 3px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 999px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-collections-filter-btn {
          border: none;
          outline: none;
          box-shadow: none;
          border-radius: 999px;
          padding: 7px 14px;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          color: var(--p-color-text-secondary, #6b6b6b);
          background: transparent;
          cursor: pointer;
          transition: background-color 120ms ease, color 120ms ease;
        }
        .shuffly-collections-filter-btn--active {
          background: var(--p-color-bg-fill-inverse, #131110);
          color: #ffffff;
        }
        .shuffly-collections-filter-btn:not(.shuffly-collections-filter-btn--active):hover {
          background: var(--p-color-bg-surface-secondary, #f1f1f1);
        }
        .shuffly-collections-filter-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
        .shuffly-quiet-link {
          border: none;
          outline: none;
          padding: 0;
          background: transparent;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          color: var(--p-color-text-link, #1F5199);
          text-decoration: underline;
          cursor: pointer;
        }
        .shuffly-quiet-link:hover { color: var(--p-color-text-link-hover, #1a4680); }
        .shuffly-quiet-link:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
        .shuffly-untracked-card {
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 12px;
          background: var(--p-color-bg-surface, #ffffff);
          overflow: hidden;
        }
        .shuffly-untracked-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
          border-bottom: 1px solid var(--p-color-border, #e3e3e3);
        }
        .shuffly-untracked-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
        }
        .shuffly-untracked-row + .shuffly-untracked-row { border-top: 1px solid var(--p-color-border, #e3e3e3); }
        .shuffly-untracked-thumbs { display: flex; align-items: center; gap: 4px; flex: none; }
        .shuffly-untracked-thumb {
          width: 26px;
          height: 26px;
          border-radius: 6px;
          background: var(--p-color-bg-fill-secondary, #e3dbd3);
          flex: none;
        }
        .shuffly-add-all-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 30px;
          padding: 0 14px;
          border: none;
          outline: none;
          border-radius: 7px;
          background: var(--p-color-bg-fill-warning, #FF4B1F);
          color: #ffffff;
          font: inherit;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .shuffly-add-all-btn:hover:not(:disabled) { background: var(--p-color-bg-fill-warning-hover, #d93c15); }
        .shuffly-add-all-btn:disabled { opacity: 0.6; cursor: default; }
        .shuffly-add-all-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
      `}</style>
    </s-page>
  );
}

/** Build a real FormData instance for fetcher.submit() instead of handing
 * it a plain object — react-router converts a plain-object submit target
 * via `new URLSearchParams(obj)`, and URLSearchParams stringifies an array
 * value with `String(array)`, which comma-joins it into ONE field instead
 * of appending one field per element. That silently breaks any action
 * relying on `formData.getAll(key)` for a multi-value field (bulk actions,
 * "shuffle all except these ids", "add all these collections") — it
 * worked with exactly one item, broke with two or more. Passing a real
 * FormData bypasses that conversion entirely. */
function formDataOf(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const v of value) fd.append(key, v);
    } else {
      fd.set(key, value);
    }
  }
  return fd;
}

function PauseAllButton() {
  const fetcher = useFetcher();
  return (
    <s-button onClick={() => fetcher.submit({ _action: "pause-all" }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
      Pause all
    </s-button>
  );
}

// ---- status row ----

function ClockGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke={color} strokeWidth="1.4" />
      <path d="M8 4.8V8L10.2 9.4" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckCircleGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke={color} strokeWidth="1.4" />
      <path d="M5.3 8.2L7.2 10L10.7 6.2" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertCircleGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke={color} strokeWidth="1.4" />
      <path d="M8 5V8.6" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="10.8" r="0.9" fill={color} />
    </svg>
  );
}

function GridGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke={color} strokeWidth="1.4" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke={color} strokeWidth="1.4" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke={color} strokeWidth="1.4" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

/** Three equal cards, one bordered container, 1px dividers — the "how is
 * my shop actually doing right now" summary. Only the next-run chip uses
 * brand orange; the other two use real semantic tones (green for a clean
 * run, red if last night's run had a failure) — orange is never used for
 * a warning or an error, per spec. */
function StatusRow({
  runningCount,
  nextRunLabel,
  nextRunAtMs,
  lastBatch,
  totalProductsInRotation,
  productsActuallyMoving,
  trackedTotal,
  totalStoreCollections,
}: {
  runningCount: number;
  nextRunLabel: string | null;
  nextRunAtMs: number | null;
  lastBatch: { totalMoved: number; anyFailed: boolean; failedTitles: string[]; at: Date } | null;
  totalProductsInRotation: number;
  productsActuallyMoving: number;
  trackedTotal: number;
  totalStoreCollections: number | null;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!nextRunAtMs || runningCount === 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nextRunAtMs, runningCount]);

  const countdown = runningCount === 0 || !nextRunAtMs ? "Only when you press Shuffle" : formatCountdown(nextRunAtMs - nowMs);

  const lastNightCritical = lastBatch?.anyFailed ?? false;
  const lastNightValue = lastBatch
    ? lastNightCritical
      ? `${lastBatch.failedTitles.length} collection${lastBatch.failedTitles.length === 1 ? "" : "s"} failed`
      : `${lastBatch.totalMoved} products moved`
    : "Not run yet";
  const lastNightDetail = lastBatch
    ? lastNightCritical
      ? `Failed: ${lastBatch.failedTitles.slice(0, 2).join(", ")}${lastBatch.failedTitles.length > 2 ? "…" : ""}`
      : `${formatClock(lastBatch.at)} · nothing failed`
    : "The first scheduled run will show up here";

  const rotationTone = TONE_TOKENS.info;

  return (
    <div className="shuffly-status-row" style={{ containerType: "inline-size", containerName: "shuffly-status" }}>
      <div className="shuffly-status-card">
        <div className="shuffly-status-chip" style={{ background: TONE_TOKENS.warning.tint }}>
          <ClockGlyph color={TONE_TOKENS.warning.accent} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="shuffly-status-label">Next run</div>
          <div className="shuffly-status-value">{countdown}</div>
          <div className="shuffly-status-detail">
            {nextRunLabel ?? "—"} · {runningCount} collection{runningCount === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      <div className="shuffly-status-card">
        <div className="shuffly-status-chip" style={{ background: lastNightCritical ? TONE_TOKENS.critical.tint : TONE_TOKENS.success.tint }}>
          {lastNightCritical ? (
            <AlertCircleGlyph color={TONE_TOKENS.critical.accent} />
          ) : (
            <CheckCircleGlyph color={TONE_TOKENS.success.accent} />
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="shuffly-status-label">Last night</div>
          <div className="shuffly-status-value" style={lastNightCritical ? { color: TONE_TOKENS.critical.accent } : undefined}>
            {lastNightValue}
          </div>
          <div className="shuffly-status-detail">{lastNightDetail}</div>
        </div>
      </div>
      <div className="shuffly-status-card">
        <div className="shuffly-status-chip" style={{ background: rotationTone.tint }}>
          <GridGlyph color={rotationTone.accent} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="shuffly-status-label">In rotation</div>
          <div className="shuffly-status-value">
            {productsActuallyMoving} of {totalProductsInRotation} products
          </div>
          <div className="shuffly-status-detail">
            across {trackedTotal} of your {totalStoreCollections ?? "?"} collections
          </div>
        </div>
      </div>
    </div>
  );
}

const TONE_TOKENS: Record<"warning" | "success" | "critical" | "info", { accent: string; tint: string }> = {
  warning: { accent: "var(--p-color-icon-warning, #FF4B1F)", tint: "var(--p-color-bg-fill-warning-secondary, #FFF1E4)" },
  success: { accent: "var(--p-color-icon-success, #008060)", tint: "var(--p-color-bg-fill-success-secondary, #E3F5EE)" },
  critical: { accent: "var(--p-color-icon-critical, #D82C0D)", tint: "var(--p-color-bg-fill-critical-secondary, #FEE9E8)" },
  info: { accent: "var(--p-color-icon-info, #1F5199)", tint: "var(--p-color-bg-fill-info-secondary, #EAF2FF)" },
};

function formatCountdown(ms: number): string {
  if (ms <= 0) return "any moment";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function formatClock(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

// ---- inline attention strip ----

const ATTENTION_DISPLAY_MAX = 3;

function AttentionStrip({
  lines,
  onSwitch,
  pauseFetcherKeyPrefix,
}: {
  lines: AttentionLine[];
  onSwitch: (target: SwitchToManualTarget) => void;
  pauseFetcherKeyPrefix: string;
}) {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, ATTENTION_DISPLAY_MAX);
  const overflow = lines.length - shown.length;
  return (
    <div className="shuffly-attention-strip">
      {shown.map((line) => (
        <AttentionLineRow key={line.key} line={line} onSwitch={onSwitch} pauseFetcherKeyPrefix={pauseFetcherKeyPrefix} />
      ))}
      {overflow > 0 && <div className="shuffly-attention-more">and {overflow} more</div>}
    </div>
  );
}

function AttentionLineRow({
  line,
  onSwitch,
  pauseFetcherKeyPrefix,
}: {
  line: AttentionLine;
  onSwitch: (target: SwitchToManualTarget) => void;
  pauseFetcherKeyPrefix: string;
}) {
  const pauseFetcher = useFetcher({ key: `${pauseFetcherKeyPrefix}attn-${line.id ?? line.key}` });
  const busy = pauseFetcher.state !== "idle";

  function onAction() {
    if (line.actionKind === "pause" && line.id) {
      pauseFetcher.submit({ _action: "pause", id: line.id }, { method: "post" });
    } else if (line.actionKind === "switch" && line.switchTarget) {
      onSwitch(line.switchTarget);
    }
  }

  return (
    <div className="shuffly-attention-line">
      <span className="shuffly-attention-dot" aria-hidden="true" />
      <span className="shuffly-attention-message">{line.message}</span>
      <button type="button" className="shuffly-attention-action" onClick={onAction} disabled={busy}>
        {busy ? "Pausing…" : line.actionLabel}
      </button>
    </div>
  );
}

// "warning" here means real caution/amber, not brand orange — orange is
// reserved for exactly four spots elsewhere on this page (see the CSS
// block's comment above .shuffly-attention-strip).
const ATTENTION_BANNER_TOKENS: Record<"warning" | "info", { accent: string; tint: string; border: string }> = {
  warning: {
    accent: "var(--p-color-icon-caution, #946200)",
    tint: "var(--p-color-bg-fill-caution-secondary, #FFF4D6)",
    border: "var(--p-color-border-caution, #946200)",
  },
  info: {
    accent: "var(--p-color-icon-info, #1F5199)",
    tint: "var(--p-color-bg-fill-info-secondary, #EAF2FF)",
    border: "var(--p-color-border-info, #1F5199)",
  },
};

/** A softer stand-in for raw `s-banner` — that component renders as a
 * solid, fully-saturated block of tone color. Used only for the
 * hydration-failure state now — every per-collection issue goes through
 * AttentionStrip's compact line format instead. */
function AttentionBanner({
  tone,
  heading,
  children,
  action,
}: {
  tone: "warning" | "info";
  heading: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const tokens = ATTENTION_BANNER_TOKENS[tone];
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        background: tokens.tint,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <div
        aria-hidden="true"
        style={{ flex: "none", width: 8, height: 8, marginTop: 6, borderRadius: "50%", background: tokens.accent }}
      />
      <div style={{ flex: "1 1 0%", minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--p-color-text, #131110)" }}>{heading}</div>
        <div style={{ marginTop: 4, fontSize: 13, color: "var(--p-color-text-secondary, #6b6b6b)" }}>{children}</div>
        {action && <div style={{ marginTop: 10 }}>{action}</div>}
      </div>
    </div>
  );
}

/** Column headings above the row list — same column classes/widths as a
 * data row, so it lines up by construction rather than by guessing pixel
 * values twice. The checkbox and actions columns get no text label, just
 * their reserved width. */
function CollectionsHeaderRow() {
  return (
    <div className="shuffly-row shuffly-row--header">
      <div className="shuffly-row-select" />
      <div className="shuffly-row-text">Collection</div>
      <div className="shuffly-thumbs">Preview</div>
      <div className="shuffly-row-schedule">Schedule</div>
      <div className="shuffly-row-lastrun">Last run</div>
      <div className="shuffly-row-actions" />
    </div>
  );
}

function EmptyCollectionsState({ onAdd }: { onAdd: () => void }) {
  return (
    <s-box padding="large-500">
      <s-stack direction="block" gap="small" alignItems="center">
        <s-icon type="collection" color="subdued" />
        <s-heading>No collections yet</s-heading>
        <s-text color="subdued">Add your first collection and Shuffly will keep it fresh automatically.</s-text>
        <div style={{ marginTop: 4 }}>
          <s-button variant="primary" onClick={onAdd}>
            Add collection
          </s-button>
        </div>
      </s-stack>
    </s-box>
  );
}

function XGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ---- "Not shuffled yet" card ----

function NotShuffledYetCard({
  items,
  onAddAll,
  addingAll,
}: {
  items: UntrackedCollectionItem[];
  onAddAll: () => void;
  addingAll: boolean;
}) {
  return (
    <div className="shuffly-untracked-card">
      <div className="shuffly-untracked-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <s-text type="strong">Not shuffled yet</s-text>
          <s-badge tone="neutral">{items.length} collection{items.length === 1 ? "" : "s"}</s-badge>
        </div>
        <button type="button" className="shuffly-add-all-btn" onClick={onAddAll} disabled={addingAll}>
          {addingAll ? "Adding…" : `Add all ${items.length}`}
        </button>
      </div>
      {items.map((item) => (
        <UntrackedRow key={item.gid} item={item} />
      ))}
    </div>
  );
}

function UntrackedRow({ item }: { item: UntrackedCollectionItem }) {
  const needsManual = item.sortOrder !== "MANUAL";
  const addFetcher = useFetcher<{ ok: boolean; error?: string }>({ key: `row-action-untracked-${item.gid}` });
  const shopify = useAppBridge();
  const busy = addFetcher.state !== "idle";

  function onClick() {
    addFetcher.submit(
      { _action: needsManual ? "switch-and-add" : "add-untracked", gid: item.gid, title: item.title },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (addFetcher.state === "idle" && addFetcher.data) {
      if (addFetcher.data.ok) {
        shopify.toast.show(`${item.title} added`);
      } else {
        shopify.toast.show(addFetcher.data.error ?? "Couldn't add that collection", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [addFetcher.state, addFetcher.data]);

  return (
    <div className="shuffly-untracked-row">
      <div className="shuffly-untracked-thumbs" aria-hidden="true">
        <div className="shuffly-untracked-thumb" />
        <div className="shuffly-untracked-thumb" />
        <div className="shuffly-untracked-thumb" />
      </div>
      <div style={{ flex: "1 1 0%", minWidth: 0 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <s-text type="strong">{item.title}</s-text>
        </div>
        <div style={{ fontSize: 12 }}>
          <s-text color="subdued">
            {item.productsCount} product{item.productsCount === 1 ? "" : "s"} ·{" "}
            {needsManual ? `uses Shopify's "${item.sortOrderLabel}" sort` : "ready to add"}
          </s-text>
        </div>
      </div>
      {needsManual && (
        <span style={{ flex: "none" }}>
          <s-badge tone="neutral">Needs Manual sort</s-badge>
        </span>
      )}
      <button type="button" className="shuffly-row-action-btn" onClick={onClick} disabled={busy} style={{ flex: "none" }}>
        {busy ? "Adding…" : needsManual ? "Switch & add" : "Add"}
      </button>
    </div>
  );
}
