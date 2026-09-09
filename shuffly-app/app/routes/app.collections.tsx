import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, useFetchers, useNavigation, useRevalidator, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import {
  captureOriginalOrder,
  hydrateTrackedCollections,
  mapWithLimit,
  setCollectionManualSort,
  sortOrderLabel,
} from "../lib/collections.server";
import { restoreOnRemove, runShuffleForCollection } from "../lib/shuffle-engine.server";
import { previewShuffleAll } from "../lib/shuffle-preview.server";
import {
  formatActivityTimestamp,
  nextRunFor,
  normalizeHhMm,
  slotsFarEnoughApart,
  type ScheduleType,
  type SlotSchedule,
} from "../lib/schedule.server";
import { cadenceLabel, isScheduleAllowed, isTopPlan, planOf, pruneExpiredUndoSnapshots, timeSlots } from "../lib/plans.server";
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
import { ScheduleModal, type ScheduleTarget } from "../components/ScheduleModal";
import { noMoveReasonLabel } from "../lib/run-reason";
import {
  inheritScheduleFields,
  isOverridden,
  overrideWriteFields,
  resolveSchedule,
  shopDefaultSchedule,
} from "../lib/schedule-resolve";
import { BulkRemoveConfirmModal } from "../components/BulkRemoveConfirmModal";
import { PlanBar } from "../components/PlanBar";
import { AddAllUntrackedModal } from "../components/AddAllUntrackedModal";
import { SwitchSortConfirmModal, type SortSwitchTarget } from "../components/SwitchSortConfirmModal";

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

interface UntrackedCollectionsData {
  items: UntrackedCollectionItem[];
  hasMore: boolean;
  totalStoreCollections: number | null;
}

// ============================== loader ==============================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const now = new Date();

  const [settings, tracked] = await Promise.all([
    getOrCreateShopSettings(admin, shop),
    db.collectionConfig.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
  ]);
  await pruneExpiredUndoSnapshots(shop, planOf(settings.plan).id);
  const trackedIds = tracked.map((t) => t.id);
  const trackedGidsForHydration = tracked.map((t) => t.collectionGid);

  // Keep the first paint bounded to data that is actually visible in the
  // tracked-collections workspace. The full catalogue scan and aggregate
  // count used by the optional "Not shuffled yet" card live in a resource
  // route and run only after the merchant asks to see that card.
  const [hydratedTracked, latestRuns, recentRuns, lastScheduledRun] = await Promise.all([
    // Every tracked collection's live sort order/product count/thumbnails,
    // fetched by exact id — bounded by how many collections are tracked,
    // never by how many exist in the store (unlike a full-catalogue scan).
    trackedGidsForHydration.length
      ? hydrateTrackedCollections(admin, trackedGidsForHydration).catch((err) => {
          console.error("[app.collections] hydrateTrackedCollections failed:", err);
          return null;
        })
      : Promise.resolve(new Map()),
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

  const hydrationFailed = hydratedTracked == null;
  const liveByGid = hydratedTracked ?? new Map();
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
    // Live sortOrder is the primary signal. sortOrderIssueAt is the fallback
    // for exactly the window the live read can't cover: hydration failed, or
    // a run discovered the problem seconds ago and the merchant hasn't
    // reloaded since.
    const liveNotManual = !hydrationFailed && live != null && live.sortOrder !== "MANUAL";
    const needsAttention = liveNotManual || ((hydrationFailed || live == null) && c.sortOrderIssueAt != null);
    const liveCount = live?.productsCount ?? c.productCount;
    // Best-effort, not a live full-catalogue check: "every product sold
    // out" is inferred from the last shuffle run's sold-out count matching
    // the live product count — cheap, and right unless inventory changed
    // since that run.
    const allSoldOut = c.lastSoldOutCount != null && c.lastSoldOutCount > 0 && liveCount > 0 && c.lastSoldOutCount >= liveCount;
    return { config: c, live, needsAttention, allSoldOut };
  });

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
          mode: "tracked" as const,
          id: r.config.id,
          gid: r.config.collectionGid,
          title: r.config.title,
          sortOrderLabel: sortOrderLabel(r.live!.sortOrder),
        },
      })),
  ];

  // ---- rows (all tracked — filtering/sorting/paging happens client-side) ----
  // Thumbnails come from the same hydratedTracked fetch used for
  // sortOrder/productsCount above — no second round trip needed.
  const previewByGid = new Map<string, CollectionRowData["preview"]>();
  for (const [gid, h] of liveByGid) previewByGid.set(gid, h.preview);

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

    // Resolved, never read raw: a collection with null columns runs on the
    // shop default, and the cell has to say what it actually does.
    const effective = resolveSchedule(c, settings);
    const scheduleLine =
      c.status === "PAUSED"
        ? "Paused"
        : scheduleLabel(effective.scheduleType, effective.scheduleTime, effective.scheduleWeekday, effective.scheduleTime2 ?? null);
    const scheduleSubLine =
      c.status === "PAUSED" ? "Resume to schedule" : c.nextRunAt ? "" : "Shuffles only when you press Shuffle";

    const latestRun = latestRunByCollectionId.get(c.id);
    const lastRun = latestRun
      ? {
          moved: latestRun.movedCount,
          whenLabel: lastRunLabel(latestRun.createdAt, settings.timezone, now),
          failed: latestRun.status === "FAILED",
          at: latestRun.createdAt,
          // Null for runs recorded before noMoveReason existed, and for any
          // run that actually moved something — the row falls back to the
          // bare count in both cases rather than inventing a reason.
          noMoveReason: latestRun.movedCount === 0 ? noMoveReasonLabel(latestRun.noMoveReason) : null,
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
      // What Shopify actually has this collection sorted by, only when that
      // isn't Manual — the row names it so the merchant knows what changed.
      wrongSortLabel: r.needsAttention ? (live ? sortOrderLabel(live.sortOrder) : null) : null,
      allSoldOut: r.allSoldOut,
      factsLine: factsParts.join(" · "),
      settingsBadges,
      preview: previewByGid.get(c.collectionGid) ?? [],
      scheduleLine,
      scheduleSubLine,
      nextRunAt: c.status === "RUNNING" ? c.nextRunAt : null,
      // Drives the "Custom" marker, and tells the modal whether to preselect
      // "Use shop default".
      scheduleIsCustom: isOverridden(c),
      // The effective values the modal opens on — already resolved, so a
      // collection that inherits opens showing the default it inherits.
      schedule: {
        scheduleType: effective.scheduleType,
        scheduleTime: effective.scheduleTime,
        scheduleTime2: effective.scheduleTime2 ?? null,
        scheduleWeekday: effective.scheduleWeekday ?? null,
      },
      lastRun,
      sparkline,
      // Whether removing this one has anything to put back — drives the bulk
      // remove dialog's copy so it can't claim "nothing changes" while
      // silently restoring sorts.
      restorableSort: c.previousSortOrder ? sortOrderLabel(c.previousSortOrder) : null,
      hasOrderSnapshot: Boolean(c.originalOrder) && !c.previousSortOrder,
    };
  });

  const plan = planOf(settings.plan);

  return {
    rows,
    trackedTotal: tracked.length,
    hydrationFailed,
    attentionLines,
    runningCount,
    pausedCount,
    nextRunAtMs: soonestNextRunMs ?? null,
    nextRunLabel: soonestNextRunMs ? dayRelativeClockLabel(new Date(soonestNextRunMs), settings.timezone, now) : null,
    totalProductsInRotation,
    productsActuallyMoving,
    lastBatch,
    // When on, the add dialog is skipped entirely and the switch happens
    // straight away — revocable on the Settings page.
    autoSwitchToManual: settings.autoSwitchToManual,
    timezone: settings.timezone,
    // The live shop default every inheriting row follows. Sent as one object
    // so the modal, the Settings link copy and the "Use shop default" reset
    // all read the same values.
    shopDefault: shopDefaultSchedule(settings),
    // Gated on the entitlement helper, never on `plan === "PRO"` — the plan
    // matrix is allowed to change without every caller having to.
    scheduleSlots: timeSlots(settings.plan),
    planName: plan.name,
    planLimit: plan.maxCollections === Infinity ? null : plan.maxCollections,
    // The plan card's data. ShopSettings.plan is already a local cache of
    // whatever billing.check() last reported (see billing.server.ts) and
    // this loader already reads it for the collection cap — so the card
    // adds no query here and no Billing API call on any dashboard render.
    // The bar and the stat card below it both read plan facts from this one
    // value, so the two can never show different plans on one screen.
    planId: plan.id,
    planSummary: cadenceLabel(settings.plan),
    canUpgrade: !isTopPlan(settings.plan),
    undoRetentionDays: plan.undoRetentionDays,
  };
};

function scheduleLabel(
  type: string,
  time: string,
  weekday: number | null,
  time2: string | null,
): string {
  switch (type) {
    case "DAILY":
      return `Daily at ${time}`;
    case "TWICE_DAILY":
      // Both merchant-picked times, in chronological order — "Twice daily"
      // alone left the merchant with no way to see when the second run is.
      return `Twice daily at ${[time, time2].filter(Boolean).sort().join(" and ")}`;
    case "WEEKLY":
      return `Weekly, ${WEEKDAYS[weekday ?? 1]} at ${time}`;
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
  // Every "add a collection" path starts the collection INHERITING the shop
  // default rather than copying it. Writing a copy here would mean the shop
  // default only ever governed collections that existed when it was set, and
  // every collection added afterwards would quietly carry a frozen snapshot
  // of it. Newly added collections start RUNNING, hence the default status.
  const defaultScheduleFields = () => inheritScheduleFields(new Date(), settings.timezone, settings);

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

    // Consent: either the merchant just ticked "switch automatically from now
    // on" in the dialog, or they'd ticked it previously. Either way it is
    // recorded before anything is mutated, and it stays revocable on the
    // Settings page.
    if (formData.get("rememberAutoSwitch") === "true" && !settings.autoSwitchToManual) {
      await db.shopSettings.update({ where: { shop }, data: { autoSwitchToManual: true } });
    }

    interface AddOutcome {
      gid: string;
      title: string;
      ok: boolean;
      switchedFrom: string | null;
      error?: string;
    }

    // Four at a time: fast enough for a twenty-collection batch, gentle
    // enough not to trip Shopify's rate limiter. Each collection is
    // independent, so one failure never fails the batch.
    const outcomes = await mapWithLimit<string, AddOutcome>(toAdd, 4, async (gid) => {
      const title = String(formData.get(`collectionTitle:${gid}`) ?? "Collection");
      const submittedSort = String(formData.get(`collectionSort:${gid}`) ?? "MANUAL");
      const needsSwitch = submittedSort !== "MANUAL";

      // Snapshot BEFORE touching anything — this is what makes the switch
      // reversible, and it's captured for already-Manual collections too,
      // since a hand-curated order is exactly what a merchant wants back.
      const snapshot = await captureOriginalOrder(admin, gid);

      let previousSortOrder: string | undefined;
      if (needsSwitch) {
        const result = await setCollectionManualSort(admin, gid);
        if (!result.ok) {
          return { gid, title, ok: false, switchedFrom: null, error: result.error };
        }
        previousSortOrder = result.previousSortOrder;
      }

      await db.collectionConfig.upsert({
        where: { shop_collectionGid: { shop, collectionGid: gid } },
        update: {},
        create: {
          shop,
          collectionGid: gid,
          title,
          previousSortOrder,
          originalOrder: snapshot?.packed ?? null,
          originalOrderAt: snapshot ? new Date() : null,
          ...defaultScheduleFields(),
          ...preset,
          pins: plan.canPin ? preset.pins : 0,
        },
      });

      return { gid, title, ok: true, switchedFrom: previousSortOrder ?? null };
    });

    // One Activity row per sort change: which collection, from what, to what,
    // and when. "Who" isn't available — this app uses offline tokens only, so
    // there is no staff identity attached to the request.
    const switchedOutcomes = outcomes.filter((o) => o.ok && o.switchedFrom);
    if (switchedOutcomes.length > 0) {
      const configs = await db.collectionConfig.findMany({
        where: { shop, collectionGid: { in: switchedOutcomes.map((o) => o.gid) } },
        select: { id: true, collectionGid: true },
      });
      const idByGid = new Map(configs.map((c) => [c.collectionGid, c.id]));
      await db.$transaction(
        switchedOutcomes
          .filter((o) => idByGid.has(o.gid))
          .map((o) =>
            db.shuffleRun.create({
              data: {
                shop,
                collectionId: idByGid.get(o.gid)!,
                trigger: "SORT_CHANGED",
                status: "OK",
                message: `${sortOrderLabel(o.switchedFrom!)} → Manual`,
              },
            }),
          ),
      );
    }

    const added = outcomes.filter((o) => o.ok).length;
    const switched = switchedOutcomes.length;
    const failures = outcomes.filter((o) => !o.ok);

    return data({
      ok: failures.length === 0,
      added,
      switched,
      skipped: ids.length - toAdd.length,
      // Named, with their gids, so the modal can offer a retry for exactly
      // the ones that failed rather than making the merchant start over.
      failed: failures.map((f) => ({ gid: f.gid, title: f.title, error: f.error ?? "Unknown error" })),
      error:
        failures.length > 0
          ? `Couldn't switch ${failures.map((f) => f.title).join(", ")}. ${added} other collection${added === 1 ? "" : "s"} added.`
          : undefined,
    });
  }

  if (actionType === "add-untracked") {
    const plan = planOf(settings.plan);
    const existingCount = await db.collectionConfig.count({ where: { shop } });
    if (plan.maxCollections !== Infinity && existingCount >= plan.maxCollections) {
      return data({ ok: false, error: "You've reached your plan's collection limit." }, { status: 400 });
    }
    const gid = String(formData.get("gid"));
    const title = String(formData.get("title") ?? "Collection");
    await db.collectionConfig.upsert({
      where: { shop_collectionGid: { shop, collectionGid: gid } },
      update: {},
      create: { shop, collectionGid: gid, title, ...defaultScheduleFields(), ...DEFAULT_ADD_PRESET },
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
    const config = await db.collectionConfig.upsert({
      where: { shop_collectionGid: { shop, collectionGid: gid } },
      update: {},
      create: {
        shop,
        collectionGid: gid,
        title,
        previousSortOrder: switched.previousSortOrder,
        ...defaultScheduleFields(),
        ...DEFAULT_ADD_PRESET,
      },
    });
    // "Switch it, add it, and shuffle it now" in one click, when the
    // merchant chose not to keep the current order in the confirmation.
    if (formData.get("keepOrder") === "false") {
      await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL", undefined, settings.pageSize);
    }
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
    let switchedCount = 0;
    for (let i = 0; i < gids.length && added < room; i++) {
      const gid = gids[i];
      let previousSortOrder: string | undefined;
      if (sortOrders[i] !== "MANUAL") {
        const result = await setCollectionManualSort(admin, gid);
        if (!result.ok) continue;
        previousSortOrder = result.previousSortOrder;
        switchedCount++;
      }
      await db.collectionConfig.upsert({
        where: { shop_collectionGid: { shop, collectionGid: gid } },
        update: {},
        create: {
          shop,
          collectionGid: gid,
          title: titles[i] ?? "Collection",
          previousSortOrder,
          ...defaultScheduleFields(),
          ...DEFAULT_ADD_PRESET,
        },
      });
      added++;
    }
    return data({ ok: true, added, switched: switchedCount, skipped: gids.length - added });
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
      // The sort is Manual again, so whatever health problem was recorded
      // against this collection is resolved — clear it here rather than
      // waiting for the next successful run to do it.
      data: { status: "RUNNING", previousSortOrder: result.previousSortOrder, sortOrderIssueAt: null },
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
        ? nextRunFor(new Date(), settings.timezone, resolveSchedule(config, settings))
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

  // One writer for all three collection entry points (cell, row menu, bulk).
  // `scheduleMode=default` clears the override so the rows go back to
  // inheriting; anything else writes explicit values. Either way the sweep
  // re-reads on its next pass, so the change takes effect immediately with
  // nothing left queued at the old time.
  if (actionType === "set-schedule") {
    const ids = formData.getAll("id").map(String);
    const toDefault = String(formData.get("scheduleMode") ?? "") === "default";
    const configs = await db.collectionConfig.findMany({ where: { id: { in: ids }, shop } });
    if (configs.length === 0) return data({ ok: false, error: "Nothing to update." }, { status: 400 });

    let override: ReturnType<typeof overrideWriteFields>;
    if (toDefault) {
      override = overrideWriteFields(null);
    } else {
      const scheduleType = String(formData.get("scheduleType") ?? "WEEKLY") as ScheduleType;
      // The cadence is a plan entitlement and is checked here, not only in
      // the UI. Without this a hand-rolled POST could set DAILY on Free —
      // and TWICE_DAILY too, since the slot guard below only fires when a
      // second time comes with it.
      if (!isScheduleAllowed(settings.plan, scheduleType)) {
        return data(
          { ok: false, error: `Your ${planOf(settings.plan).name} plan doesn't include that schedule.` },
          { status: 400 },
        );
      }
      const scheduleTime = normalizeHhMm(String(formData.get("scheduleTime") ?? "06:00"));
      const rawTime2 = formData.get("scheduleTime2");
      const scheduleTime2 =
        scheduleType === "TWICE_DAILY" && rawTime2 != null && rawTime2 !== ""
          ? normalizeHhMm(String(rawTime2))
          : null;
      // The second slot is a plan entitlement, checked here and not only in
      // the UI — a hand-rolled POST must not be able to buy it for free.
      if (scheduleTime2 != null && timeSlots(settings.plan) < 2) {
        return data({ ok: false, error: "Two shuffles a day is a Pro feature." }, { status: 400 });
      }
      if (scheduleTime2 != null && !slotsFarEnoughApart(scheduleTime, scheduleTime2)) {
        return data({ ok: false, error: "Keep the two shuffle times at least an hour apart." }, { status: 400 });
      }
      const rawWeekday = formData.get("scheduleWeekday");
      override = overrideWriteFields({
        scheduleType,
        scheduleTime,
        scheduleTime2,
        scheduleWeekday: rawWeekday != null && rawWeekday !== "" ? Number(rawWeekday) : null,
      });
    }

    const writes = configs.flatMap((c) => {
      const before = resolveSchedule(c, settings);
      const after = resolveSchedule({ ...c, ...override }, settings);
      const changed = scheduleSummary(before) !== scheduleSummary(after) || isOverridden(c) !== (override.scheduleType != null);
      const nextRunAt = c.status === "RUNNING" ? nextRunFor(new Date(), settings.timezone, after) : null;
      return [
        db.collectionConfig.update({
          where: { id: c.id },
          data: {
            ...override,
            nextRunAt,
            // Stamped only on a real move, so the sweep can still tell "the
            // worker was down" from "the merchant moved this into the past".
            ...(changed ? { scheduleUpdatedAt: new Date() } : {}),
          },
        }),
        ...(changed
          ? [
              db.shuffleRun.create({
                data: {
                  shop,
                  collectionId: c.id,
                  trigger: "SCHEDULE_CHANGED",
                  status: "OK",
                  message: `Schedule changed to ${scheduleSummary(after)}${override.scheduleType == null ? " (shop default)" : ""} — was ${scheduleSummary(before)}`,
                },
              }),
            ]
          : []),
      ];
    });
    await db.$transaction(writes);
    return data({ ok: true, count: configs.length, toDefault });
  }

  // The shop-wide default. Nothing is copied onto collection rows — every
  // collection with a null override follows these values live — so the only
  // extra work is repairing the advisory countdown on those rows.
  if (actionType === "set-shop-default") {
    const scheduleType = String(formData.get("scheduleType") ?? "WEEKLY") as ScheduleType;
    // The cadence is a plan entitlement and is checked here, not only in
    // the UI. Without this a hand-rolled POST could set DAILY on Free —
    // and TWICE_DAILY too, since the slot guard below only fires when a
    // second time comes with it.
    if (!isScheduleAllowed(settings.plan, scheduleType)) {
      return data(
        { ok: false, error: `Your ${planOf(settings.plan).name} plan doesn't include that schedule.` },
        { status: 400 },
      );
    }
    const scheduleTime = normalizeHhMm(String(formData.get("scheduleTime") ?? "06:00"));
    const rawTime2 = formData.get("scheduleTime2");
    const scheduleTime2 =
      scheduleType === "TWICE_DAILY" && rawTime2 != null && rawTime2 !== ""
        ? normalizeHhMm(String(rawTime2))
        : null;
    if (scheduleTime2 != null && timeSlots(settings.plan) < 2) {
      return data({ ok: false, error: "Two shuffles a day is a Pro feature." }, { status: 400 });
    }
    if (scheduleTime2 != null && !slotsFarEnoughApart(scheduleTime, scheduleTime2)) {
      return data({ ok: false, error: "Keep the two shuffle times at least an hour apart." }, { status: 400 });
    }
    const rawWeekday = formData.get("scheduleWeekday");
    const scheduleWeekday = rawWeekday != null && rawWeekday !== "" ? Number(rawWeekday) : null;

    const updated = await db.shopSettings.update({
      where: { shop },
      data: {
        defaultScheduleType: scheduleType,
        defaultScheduleTime: scheduleTime,
        defaultScheduleTime2: scheduleTime2,
        defaultScheduleWeekday: scheduleType === "WEEKLY" ? scheduleWeekday : null,
      },
    });

    // Everything inheriting just moved. nextRunAt is only an advisory cache
    // (the sweep recomputes it anyway), but leaving it stale would show the
    // merchant the old countdown until the next sweep touched each row.
    const inheriting = await db.collectionConfig.findMany({ where: { shop, scheduleType: null } });
    const nextDefault = shopDefaultSchedule(updated);
    await db.$transaction(
      inheriting.map((c) =>
        db.collectionConfig.update({
          where: { id: c.id },
          data: {
            scheduleUpdatedAt: new Date(),
            nextRunAt: c.status === "RUNNING" ? nextRunFor(new Date(), updated.timezone, nextDefault) : null,
          },
        }),
      ),
    );
    return data({ ok: true, moved: inheriting.length });
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
            ? nextRunFor(new Date(), settings.timezone, resolveSchedule(c, settings))
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
    const restore = formData.get("restore") !== "false";
    const configs = await db.collectionConfig.findMany({ where: { id: { in: ids }, shop } });

    let restoredCount = 0;
    if (restore) {
      // Four at a time, same as the add path, and one failure never blocks
      // the rest — a collection we can't restore is still removed, and the
      // Activity row says what happened to it.
      const results = await mapWithLimit(configs, 4, async (config) => ({
        config,
        result: await restoreOnRemove(admin, config),
      }));
      restoredCount = results.filter((r) => r.result.restoredSort || r.result.restoredOrder).length;
      await db.$transaction(
        results.map(({ config, result }) =>
          db.shuffleRun.create({
            data: {
              shop,
              collectionId: config.id,
              trigger: "SORT_RESTORED",
              status: result.error ? "FAILED" : "OK",
              message: result.error
                ? `Removed, but couldn't restore: ${result.error}`
                : result.restoredSort
                  ? `Removed — sort put back to ${sortOrderLabel(result.restoredSort)}`
                  : result.restoredOrder
                    ? "Removed — original product order put back"
                    : "Removed — order left exactly as it is",
            },
          }),
        ),
      );
    }

    await db.collectionConfig.deleteMany({ where: { id: { in: ids }, shop } });
    return data({ ok: true, restored: restoredCount });
  }

  if (actionType === "remove") {
    const id = String(formData.get("id"));
    const restore = formData.get("restore") !== "false";
    const config = await db.collectionConfig.findFirst({ where: { id, shop } });
    if (!config) return data({ ok: false }, { status: 404 });

    const result = restore
      ? await restoreOnRemove(admin, config)
      : { restoredSort: null, restoredOrder: false, error: undefined as string | undefined };
    await db.shuffleRun.create({
      data: {
        shop,
        collectionId: config.id,
        trigger: "SORT_RESTORED",
        status: result.error ? "FAILED" : "OK",
        message: result.error
          ? `Removed, but couldn't restore: ${result.error}`
          : result.restoredSort
            ? `Removed — sort put back to ${sortOrderLabel(result.restoredSort)}`
            : result.restoredOrder
              ? "Removed — original product order put back"
              : "Removed — order left exactly as it is",
      },
    });
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

/** One-line summary of an effective schedule, for the Activity message that
 * records old -> new. Built on the same label helper the table cell uses, so
 * the log and the row can't describe the same schedule differently. */
function scheduleSummary(s: SlotSchedule): string {
  return scheduleLabel(s.scheduleType, s.scheduleTime, s.scheduleWeekday, s.scheduleTime2 ?? null);
}

const PAGE_SIZE = 25;

export default function Collections() {
  const {
    rows,
    trackedTotal,
    hydrationFailed,
    attentionLines,
    runningCount,
    nextRunAtMs,
    nextRunLabel,
    totalProductsInRotation,
    productsActuallyMoving,
    lastBatch,
    planName,
    planLimit,
    planId,
    timezone,
    shopDefault,
    scheduleSlots,
    planSummary,
    canUpgrade,
    undoRetentionDays,
  } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading" && navigation.location?.pathname === "/app/collections";
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
  const untrackedDataFetcher = useFetcher<UntrackedCollectionsData>({ key: "untracked-collections" });
  const previewFetcher = useFetcher({ key: "shuffle-all-preview" });
  const remainingFetcher = useFetcher({ key: "shuffle-remaining" });
  const switchFetcher = useFetcher<{ ok: boolean; error?: string }>({ key: "switch-to-manual" });
  const addFetcher = useFetcher<{
    ok: boolean;
    added?: number;
    switched?: number;
    skipped?: number;
    failed?: Array<{ gid: string; title: string; error: string }>;
    error?: string;
  }>({ key: "add-collections" });
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
      // Attention beats every sort key. The row that needs a decision is the
      // one the merchant must not have to hunt for — and without this it can
      // land on page 2 entirely.
      const attention = Number(isRowAttention(b)) - Number(isRowAttention(a));
      if (attention !== 0) return attention;
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
  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay are imperative methods not on the typed public props
  const scheduleModalRef = useRef<any>(null);
  const scheduleFetcher = useFetcher<{ ok?: boolean; error?: string; count?: number; toDefault?: boolean }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay are imperative methods not on the typed public props
  const addAllModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay are imperative methods not on the typed public props
  const sortConfirmModalRef = useRef<any>(null);
  // The picker's submission, parked while the batch confirmation is open.
  const [pendingAdd, setPendingAdd] = useState<{ formData: FormData; targets: SortSwitchTarget[] } | null>(null);
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

  function searchAddModal(query: string) {
    picker.load(`/app/collections/picker?q=${encodeURIComponent(query)}`);
  }

  useEffect(() => {
    if (!awaitingAddModal || picker.state !== "idle" || !picker.data) return;
    setAwaitingAddModal(false);
    const { addable } = picker.data;
    if (addable.length > 0) {
      // Automated collections are in `addable` now too, so an empty list
      // genuinely means there is nothing left to add — no "switch them
      // first" branch to send the merchant away any more.
      addModalRef.current?.showOverlay();
    } else {
      shopify.toast.show("Every collection is already being shuffled.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only when the picker fetch this click triggered settles
  }, [awaitingAddModal, picker.state, picker.data]);

  function submitAddCollections(formData: FormData) {
    // Which of the selected collections actually need a sort change. Ones
    // already on Manual are skipped silently and never appear in the dialog.
    const selectedGids = new Set(formData.getAll("collectionGid").map(String));
    const targets: SortSwitchTarget[] = (picker.data?.addable ?? [])
      .filter((c) => selectedGids.has(c.id) && c.needsManual)
      .map((c) => ({ gid: c.id, title: c.title, sortOrderLabel: c.sortOrderLabel }));

    // Nothing to switch, or standing consent already recorded: straight
    // through, no dialog, no extra step.
    if (targets.length === 0 || picker.data?.autoSwitchToManual) {
      addFetcher.submit(formData, { method: "post" });
      return;
    }

    closeModal(addModalRef.current);
    setPendingAdd({ formData, targets });
    sortConfirmModalRef.current?.showOverlay();
  }

  function confirmSortSwitch(rememberChoice: boolean) {
    if (!pendingAdd) return;
    const formData = pendingAdd.formData;
    // Consent travels with the submission that acts on it, so the preference
    // is never written without a switch actually happening.
    if (rememberChoice) formData.set("rememberAutoSwitch", "true");
    closeModal(sortConfirmModalRef.current);
    setPendingAdd(null);
    addFetcher.submit(formData, { method: "post" });
  }

  function cancelSortSwitch() {
    closeModal(sortConfirmModalRef.current);
    setPendingAdd(null);
  }

  useEffect(() => {
    if (addFetcher.state === "idle" && addFetcher.data) {
      if (addFetcher.data.ok) closeModal(addModalRef.current);
      const { added = 0, switched = 0, skipped = 0, error } = addFetcher.data;
      if (addFetcher.data.ok) {
        const parts = [`${added} collection${added === 1 ? "" : "s"} added`];
        // Say so when we changed a merchant's sort order, even under standing
        // consent — especially then, since no dialog appeared.
        if (switched > 0) parts.push("sort changed to Manual");
        if (skipped > 0) parts.push(`${skipped} skipped (plan limit)`);
        shopify.toast.show(`${parts.join(". ")}.`);
      } else {
        // Partial success: the ones that worked are already added and
        // enabled. Only the failures are named, and the picker stays open so
        // they can be retried without starting over.
        shopify.toast.show(error ?? "Couldn't add that just now", { isError: true });
        if ((addFetcher.data.failed?.length ?? 0) > 0) openAddModal();
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

  // Every entry point funnels through this one opener, so the cell, the menu
  // item and the bulk button can't drift into three slightly different
  // pickers.
  function openScheduleModal(target: ScheduleTarget) {
    setScheduleTarget(target);
    scheduleModalRef.current?.showOverlay();
  }

  function openScheduleForRow(r: CollectionRowData) {
    openScheduleModal({
      mode: "collection",
      id: r.id,
      title: r.title,
      schedule: r.schedule as SlotSchedule,
      isCustom: r.scheduleIsCustom,
    });
  }

  function confirmSchedule(schedule: SlotSchedule | null) {
    if (!scheduleTarget) return;
    const ids =
      scheduleTarget.mode === "collection"
        ? [scheduleTarget.id]
        : scheduleTarget.mode === "bulk"
          ? Array.from(selected)
          : [];
    closeModal(scheduleModalRef.current);
    const fields: Record<string, string | string[]> =
      schedule == null
        ? { scheduleMode: "default" }
        : {
            scheduleMode: "custom",
            scheduleType: schedule.scheduleType,
            scheduleTime: schedule.scheduleTime,
            scheduleTime2: schedule.scheduleTime2 ?? "",
            scheduleWeekday: schedule.scheduleWeekday == null ? "" : String(schedule.scheduleWeekday),
          };
    if (scheduleTarget.mode === "shop-default") {
      scheduleFetcher.submit(formDataOf({ _action: "set-shop-default", ...fields }), { method: "post" });
    } else {
      scheduleFetcher.submit(formDataOf({ _action: "set-schedule", id: ids, ...fields }), { method: "post" });
    }
    setScheduleTarget(null);
  }

  useEffect(() => {
    if (scheduleFetcher.state !== "idle" || !scheduleFetcher.data) return;
    if (scheduleFetcher.data.ok) {
      setSelected(new Set());
      const n = scheduleFetcher.data.count ?? 0;
      shopify.toast.show(
        scheduleFetcher.data.toDefault
          ? `${n} collection${n === 1 ? "" : "s"} now follow the shop default`
          : n > 0
            ? `Schedule updated for ${n} collection${n === 1 ? "" : "s"}`
            : "Default schedule updated",
      );
    } else {
      shopify.toast.show(scheduleFetcher.data.error ?? "Couldn't save that schedule", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [scheduleFetcher.state, scheduleFetcher.data]);

  function openSwitchModal(target: SwitchToManualTarget) {
    setSwitchTarget(target);
    switchModalRef.current?.showOverlay();
  }

  function confirmSwitch(keepOrder: boolean) {
    if (!switchTarget) return;
    // An untracked collection gets switched AND added in the one submit —
    // that's the "one click, done" flow. A tracked one only needs the switch.
    if (switchTarget.mode === "untracked") {
      switchFetcher.submit(
        {
          _action: "switch-and-add",
          gid: switchTarget.gid,
          title: switchTarget.title,
          keepOrder: String(keepOrder),
        },
        { method: "post" },
      );
      return;
    }
    switchFetcher.submit(
      { _action: "switch-to-manual", id: switchTarget.id, gid: switchTarget.gid, keepOrder: String(keepOrder) },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (switchFetcher.state === "idle" && switchFetcher.data) {
      closeModal(switchModalRef.current);
      if (switchFetcher.data.ok) {
        const title = switchTarget?.title ?? "Collection";
        shopify.toast.show(
          switchTarget?.mode === "untracked"
            ? `${title} switched to Manual sort and added`
            : `${title} switched to Manual sort`,
        );
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

  function runBulk(
    actionName: "bulk-pause" | "bulk-resume" | "bulk-shuffle" | "bulk-remove",
    extra: Record<string, string> = {},
  ) {
    setLastBulkAction(actionName);
    bulkFetcher.submit(
      formDataOf({ _action: actionName, id: Array.from(selected), ...extra }),
      { method: "post" },
    );
  }

  function confirmBulkRemove(restore: boolean) {
    closeModal(bulkRemoveModalRef.current);
    // The choice travels with the submission. The action reads
    // `restore !== "false"`, so sending it explicitly is what stops a bulk
    // removal from restoring sorts without the merchant having said so.
    runBulk("bulk-remove", { restore: String(restore) });
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

  const untrackedCollections = untrackedDataFetcher.data?.items ?? [];
  const untrackedMore = untrackedDataFetcher.data?.hasMore ?? false;
  const totalStoreCollections = untrackedDataFetcher.data?.totalStoreCollections ?? null;
  const untrackedFetcher = useFetcher<{ ok: boolean; added?: number; switched?: number; skipped?: number }>({ key: "add-all-untracked" });
  function addAllUntracked() {
    // Always confirm: this is the one path that could switch several
    // collections' sort at once, and it used to do it without asking.
    addAllModalRef.current?.showOverlay();
  }

  function confirmAddAllUntracked() {
    closeModal(addAllModalRef.current);
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
      const added = untrackedFetcher.data.added ?? 0;
      const switched = untrackedFetcher.data.switched ?? 0;
      shopify.toast.show(
        switched > 0
          ? `${added} collection${added === 1 ? "" : "s"} added — ${switched} switched to Manual sort`
          : `${added} collection${added === 1 ? "" : "s"} added`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [untrackedFetcher.state, untrackedFetcher.data]);

  return (
    <s-page heading="Collections" {...noHydrationWarning}>
      <s-button slot="secondary-actions" onClick={openAddModal} {...noHydrationWarning}>
        Add collection
      </s-button>
      {/* Same one-glyph fix as the row menus — a text label on a menu
          trigger makes Polaris add its own chevron beside it. */}
      <s-button
        slot="secondary-actions"
        icon="menu-horizontal"
        commandFor="collections-overflow-menu"
        accessibilityLabel="More actions"
        {...noHydrationWarning}
      ></s-button>
      <s-menu id="collections-overflow-menu" accessibilityLabel="More actions">
        <PauseAllButton />
      </s-menu>

      {hasAnythingTracked && (
        <s-button slot="primary-action" variant="primary" onClick={openShuffleAllModal} {...noHydrationWarning}>
          Shuffle all now
        </s-button>
      )}

      {/* Above the stat row, below the page header. Rendered whether or not
          anything is tracked yet — a merchant with no collections still needs
          to see which plan they're on. */}
      <PlanBar planId={planId} trackedCount={trackedTotal} loading={isLoading} />

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
          planName={planName}
          planSummary={planSummary}
          canUpgrade={canUpgrade}
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
              <s-button variant="primary" onClick={() => runBulk("bulk-shuffle")} {...(bulkBusy ? { loading: pendingBulkAction === "bulk-shuffle" || undefined, disabled: true } : {})}>
                Shuffle now
              </s-button>

              {/* Third entry point into the same modal. Bulk can set an
                  explicit schedule or reset the whole selection back to the
                  shop default — both are one submit to `set-schedule`. */}
              <s-button
                onClick={() =>
                  openScheduleModal({
                    mode: "bulk",
                    count: selected.size,
                    schedule: (selectedRows[0]?.schedule as SlotSchedule) ?? (shopDefault as SlotSchedule),
                  })
                }
                {...(bulkBusy ? { disabled: true } : {})}
              >
                Set schedule…
              </s-button>

              {selectionHasRunning && (
                <s-button onClick={() => runBulk("bulk-pause")} {...(bulkBusy ? { loading: pendingBulkAction === "bulk-pause" || undefined, disabled: true } : {})}>
                  Pause
                </s-button>
              )}
              {selectionHasPaused && (
                <s-button onClick={() => runBulk("bulk-resume")} {...(bulkBusy ? { loading: pendingBulkAction === "bulk-resume" || undefined, disabled: true } : {})}>
                  Resume
                </s-button>
              )}

              <span className="shuffly-bulk-divider" aria-hidden="true" />

              <s-button tone="critical" onClick={() => bulkRemoveModalRef.current?.showOverlay()} {...(bulkBusy ? { loading: pendingBulkAction === "bulk-remove" || undefined, disabled: true } : {})}>
                Remove from Shuffly
              </s-button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="shuffly-collections-grid-container">
            <CollectionsHeaderRow />
            <CollectionsSkeletonRows count={Math.min(PAGE_SIZE, Math.max(trackedTotal, 3))} />
          </div>
        ) : pageRows.length === 0 && trackedTotal === 0 ? (
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
                    onEditSchedule={openScheduleForRow}
                    onSwitchToManual={(c) =>
                      openSwitchModal({
                        mode: "tracked",
                        id: c.id,
                        gid: c.collectionGid,
                        title: c.title,
                        sortOrderLabel: c.wrongSortLabel ?? "another sort",
                      })
                    }
                  />
                  {i < pageRows.length - 1 && <s-divider />}
                </div>
              ))}
            </div>
            <s-divider />
            <div style={{ padding: "12px 16px" }}>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text color="subdued">
                  {totalStoreCollections == null
                    ? `${trackedTotal} tracked collection${trackedTotal === 1 ? "" : "s"}`
                    : `${trackedTotal} of ${totalStoreCollections} collections`}
                  {" · "}{totalProductsInRotation} products in rotation
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

      {!untrackedDataFetcher.data ? (
        <div className="shuffly-untracked-card">
          <div className="shuffly-untracked-header">
            <div>
              <s-text type="strong">Collections not shuffled yet</s-text>
              <div style={{ marginTop: 4 }}>
                <s-text color="subdued">View collections available to add to Shuffly.</s-text>
              </div>
            </div>
            <s-button
              onClick={() => untrackedDataFetcher.load("/app/collections/untracked")}
              {...(untrackedDataFetcher.state !== "idle" ? { loading: true } : {})}
            >
              View collections
            </s-button>
          </div>
        </div>
      ) : untrackedCollections.length > 0 ? (
        <NotShuffledYetCard
          items={untrackedCollections}
          hasMore={untrackedMore}
          onAddAll={addAllUntracked}
          addingAll={untrackedFetcher.state !== "idle"}
          onFindMore={openAddModal}
          onSwitch={openSwitchModal}
        />
      ) : (
        <div className="shuffly-untracked-card">
          <div className="shuffly-untracked-header">
            <s-text color="subdued">Every collection is already being shuffled.</s-text>
          </div>
        </div>
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

      <AddCollectionsModal
        ref={addModalRef}
        picker={picker}
        onSubmit={submitAddCollections}
        onCancel={() => closeModal(addModalRef.current)}
        onSearch={searchAddModal}
      />

      <ShuffleAllConfirmModal
        ref={shuffleAllModalRef}
        undoRetentionDays={undoRetentionDays}
        onConfirm={confirmShuffleAll}
        onCancel={() => closeModal(shuffleAllModalRef.current)}
      />

      <ScheduleModal
        ref={scheduleModalRef}
        target={scheduleTarget}
        shopDefault={shopDefault as SlotSchedule}
        timezone={timezone}
        slots={scheduleSlots}
        busy={scheduleFetcher.state !== "idle"}
        onConfirm={confirmSchedule}
        onCancel={() => {
          closeModal(scheduleModalRef.current);
          setScheduleTarget(null);
        }}
      />

      <SwitchToManualModal
        ref={switchModalRef}
        target={switchTarget}
        busy={switchFetcher.state !== "idle"}
        onConfirm={confirmSwitch}
        onCancel={() => closeModal(switchModalRef.current)}
      />

      <SwitchSortConfirmModal
        ref={sortConfirmModalRef}
        targets={pendingAdd?.targets ?? []}
        busy={addFetcher.state !== "idle"}
        onConfirm={confirmSortSwitch}
        onCancel={cancelSortSwitch}
      />

      <AddAllUntrackedModal
        ref={addAllModalRef}
        items={untrackedCollections}
        busy={untrackedFetcher.state !== "idle"}
        onConfirm={confirmAddAllUntracked}
        onCancel={() => closeModal(addAllModalRef.current)}
      />

      <BulkRemoveConfirmModal
        ref={bulkRemoveModalRef}
        titles={selectedRows.map((r) => r.title)}
        restorable={selectedRows
          .filter((r) => r.restorableSort || r.hasOrderSnapshot)
          .map((r) => ({ title: r.title, sortOrderLabel: r.restorableSort ?? null }))}
        busy={bulkFetcher.state !== "idle"}
        onConfirm={confirmBulkRemove}
        onCancel={() => closeModal(bulkRemoveModalRef.current)}
      />

      <style>{`
        .shuffly-status-row {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
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
        /* Four cards need a two-up step before stacking, or each one is too
           narrow to read at tablet widths. */
        @container shuffly-status (max-width: 1000px) {
          .shuffly-status-row { grid-template-columns: repeat(2, 1fr); }
        }
        @container shuffly-status (max-width: 560px) {
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
          /* Last column is just the "···" trigger now that the duplicate
             inline buttons are gone — the 170px it used to reserve went
             back to Collection (via the 1fr), Schedule and Last run. */
          grid-template-columns: 36px minmax(250px, 1fr) 110px 150px 175px 48px;
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
        .shuffly-row-select, .shuffly-row-actions, .shuffly-row-schedule { position: relative; z-index: 1; }
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
        /* Critical, not caution — a wrong sort means shuffles silently do
           nothing at all, which is a harder failure than "ran, nothing to
           move". Same 3px bar so the two read as one family. */
        .shuffly-row--wrong-sort {
          box-shadow: inset 3px 0 0 0 var(--p-color-border-critical, #8e0b21);
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
        /* Badges get their own line under the name rather than competing with
           it for width — see CollectionRow.tsx for why. Wrapping, so a row
           with several never pushes the column wider. */
        .shuffly-row-badges {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
          margin-top: 4px;
        }
        /* The Schedule cell's text IS the button. No chrome — it should read
           as the schedule, and only reveal itself as clickable on hover or
           focus, so the table doesn't turn into a wall of buttons. */
        /* Fills the cell rather than hugging the text. A target the width of
           the words leaves dead strips either side of it, and a click that
           lands in one of them appears to do nothing — which is how a
           merchant concludes the app is broken. */
        .shuffly-schedule-button {
          display: block;
          width: 100%;
          padding: 0;
          margin: 0;
          border: none;
          background: none;
          font: inherit;
          text-align: left;
          color: inherit;
          cursor: pointer;
          border-radius: 4px;
        }
        .shuffly-schedule-button:hover { text-decoration: underline; }
        .shuffly-schedule-button:focus-visible {
          outline: 2px solid var(--p-color-border-focus, #005bd3);
          outline-offset: 2px;
        }
        .shuffly-schedule-custom { margin-left: 6px; font-size: 12px; }
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
          padding-right: 8px;
        }
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

function PlanGlyph({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l2.9 6.3 6.9.8-5 4.7 1.3 6.8L12 17.4 5.9 20.6 7.2 13.8l-5-4.7 6.9-.8z" />
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
  planName,
  planSummary,
  canUpgrade,
}: {
  runningCount: number;
  nextRunLabel: string | null;
  nextRunAtMs: number | null;
  lastBatch: { totalMoved: number; anyFailed: boolean; failedTitles: string[]; at: Date } | null;
  totalProductsInRotation: number;
  productsActuallyMoving: number;
  trackedTotal: number;
  totalStoreCollections: number | null;
  planName: string;
  planSummary: string;
  canUpgrade: boolean;
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
            {totalStoreCollections == null
              ? `across ${trackedTotal} tracked collection${trackedTotal === 1 ? "" : "s"}`
              : `across ${trackedTotal} of your ${totalStoreCollections} collections`}
          </div>
        </div>
      </div>
      <div className="shuffly-status-card">
        <div className="shuffly-status-chip" style={{ background: TONE_TOKENS.success.tint }}>
          <PlanGlyph color={TONE_TOKENS.success.accent} />
        </div>
        <div style={{ minWidth: 0, flex: "1 1 0%" }}>
          <div className="shuffly-status-label">Your plan</div>
          <div className="shuffly-status-value">{planName}</div>
          <div className="shuffly-status-detail">{planSummary}</div>
          {canUpgrade && (
            <div style={{ marginTop: 8 }}>
              {/* Links to the in-app Plan page rather than straight to
                  Shopify's pricing page: that URL needs the app handle,
                  which would mean an extra Admin API call in this loader on
                  every dashboard render. /app/plan already has it. */}
              <s-button variant="secondary" href="/app/plan">
                Upgrade
              </s-button>
            </div>
          )}
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
      <s-button variant="tertiary" onClick={onAction} {...(busy ? { loading: true } : {})}>
        {line.actionLabel}
      </s-button>
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

// Reuses the real row's own grid class/columns (see .shuffly-row) instead of
// guessing pixel dimensions, so the skeleton can't drift out of sync with
// the row it's standing in for — the exact CLS risk this is meant to avoid.
function CollectionsSkeletonRows({ count }: { count: number }) {
  const bar = (width: number | string, height = 12) => (
    <div style={{ width, height, borderRadius: 4, background: "var(--p-color-bg-surface-tertiary, #e3e3e3)" }} />
  );
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="shuffly-row" aria-hidden="true">
            <div className="shuffly-row-select">{bar(18, 18)}</div>
            <div className="shuffly-row-text" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {bar("60%", 14)}
              {bar("35%", 11)}
            </div>
            <div className="shuffly-thumbs">{bar(96, 32)}</div>
            <div className="shuffly-row-schedule">{bar(80)}</div>
            <div className="shuffly-row-lastrun">{bar(70)}</div>
            <div className="shuffly-row-actions">{bar(24, 24)}</div>
          </div>
          {i < count - 1 && <s-divider />}
        </div>
      ))}
    </>
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
  hasMore,
  onAddAll,
  addingAll,
  onFindMore,
  onSwitch,
}: {
  items: UntrackedCollectionItem[];
  hasMore: boolean;
  onAddAll: () => void;
  addingAll: boolean;
  onFindMore: () => void;
  onSwitch: (target: SwitchToManualTarget) => void;
}) {
  const anyNeedManual = items.some((item) => item.sortOrder !== "MANUAL");
  return (
    <div className="shuffly-untracked-card">
      <div className="shuffly-untracked-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <s-text type="strong">Not shuffled yet</s-text>
          <s-badge tone="neutral">{items.length} collection{items.length === 1 ? "" : "s"}</s-badge>
        </div>
        <s-button onClick={onAddAll} {...(addingAll ? { loading: true } : {})}>
          Add all {items.length}
        </s-button>
      </div>
      {anyNeedManual && (
        <div style={{ padding: "8px 12px 0" }}>
          <s-text color="subdued">
            Automated collections can be added too — Shuffly asks before switching one to Manual sort.
          </s-text>
        </div>
      )}
      {items.map((item) => (
        <UntrackedRow key={item.gid} item={item} onSwitch={onSwitch} />
      ))}
      {hasMore && (
        <div style={{ padding: "10px 12px" }}>
          <s-text color="subdued">
            More collections aren&apos;t shuffled yet than shown here.{" "}
          </s-text>
          <s-button variant="tertiary" onClick={onFindMore}>
            Search for one
          </s-button>
        </div>
      )}
    </div>
  );
}

function UntrackedRow({
  item,
  onSwitch,
}: {
  item: UntrackedCollectionItem;
  onSwitch: (target: SwitchToManualTarget) => void;
}) {
  const needsManual = item.sortOrder !== "MANUAL";
  const addFetcher = useFetcher<{ ok: boolean; error?: string }>({ key: `row-action-untracked-${item.gid}` });
  const shopify = useAppBridge();
  const busy = addFetcher.state !== "idle";

  function onClick() {
    // Never switch a merchant's sort silently: hand a non-Manual collection
    // to the confirmation modal, which then does the switch AND the add in
    // one submit. An already-Manual one has nothing to confirm.
    if (needsManual) {
      onSwitch({
        mode: "untracked",
        id: "",
        gid: item.gid,
        title: item.title,
        sortOrderLabel: item.sortOrderLabel,
      });
      return;
    }
    addFetcher.submit({ _action: "add-untracked", gid: item.gid, title: item.title }, { method: "post" });
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
      <span style={{ flex: "none" }}>
        <s-button variant="tertiary" onClick={onClick} {...(busy ? { loading: true } : {})}>
          {needsManual ? "Switch & add" : "Add"}
        </s-button>
      </span>
    </div>
  );
}
