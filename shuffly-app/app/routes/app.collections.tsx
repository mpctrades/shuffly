import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  data,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useFetcher,
  useSearchParams,
  Link,
} from "react-router";
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
import {
  CollectionRow,
  type CollectionRowData,
} from "../components/CollectionRow";
import {
  CollectionsFilterBar,
  type CollectionStatusFilter,
  type CollectionSortKey,
} from "../components/CollectionsFilterBar";
import { ShuffleAllConfirmModal } from "../components/ShuffleAllConfirmModal";
import {
  AddCollectionsModal,
  type AddCollectionsPickerData,
} from "../components/AddCollectionsModal";
import {
  SwitchToManualModal,
  type SwitchToManualTarget,
} from "../components/SwitchToManualModal";
import { BulkRemoveConfirmModal } from "../components/BulkRemoveConfirmModal";

const PAGE_SIZE = 25;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

interface NeedsAttentionItem {
  id: string;
  gid: string;
  title: string;
  sortOrderLabel: string;
}

interface UntrackedAttentionItem {
  gid: string;
  title: string;
  sortOrderLabel: string;
}

interface AllSoldOutItem {
  id: string;
  title: string;
  status: "RUNNING" | "PAUSED";
}

// ============================== loader ==============================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const q = (url.searchParams.get("q") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "all") as CollectionStatusFilter;
  const sort = (url.searchParams.get("sort") ?? "name") as CollectionSortKey;

  const settings = await getOrCreateShopSettings(admin, shop);
  const now = new Date();

  const [tracked, allShopCollections] = await Promise.all([
    db.collectionConfig.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
    // Everything Shuffly needs live (sort order + product count) for every
    // tracked collection, PLUS enough to name any untracked collection
    // that can't be shuffled yet — one full-catalogue fetch instead of the
    // old split of "hydrate this page" + "sort orders for other pages".
    listAllCollections(admin).catch((err) => {
      console.error("[app.collections] listAllCollections failed:", err);
      return null;
    }),
  ]);

  const hydrationFailed = allShopCollections == null;
  const liveByGid = new Map<string, ShopifyCollectionSummary>((allShopCollections ?? []).map((c) => [c.id, c]));

  const latestRuns = tracked.length
    ? await db.shuffleRun.findMany({
        where: { shop, collectionId: { in: tracked.map((t) => t.id) } },
        orderBy: { createdAt: "desc" },
        distinct: ["collectionId"],
      })
    : [];
  const latestRunByCollectionId = new Map(latestRuns.map((r) => [r.collectionId, r]));

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

  const searched = q
    ? fullRows.filter((r) => r.config.title.toLowerCase().includes(q.toLowerCase()))
    : fullRows;

  const filtered = searched.filter((r) => {
    if (status === "running") return r.config.status === "RUNNING";
    if (status === "paused") return r.config.status === "PAUSED";
    if (status === "attention") return r.needsAttention;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (sort) {
      case "products":
        return (b.live?.productsCount ?? b.config.productCount) - (a.live?.productsCount ?? a.config.productCount);
      case "next-run": {
        const av = a.config.nextRunAt?.getTime() ?? Infinity;
        const bv = b.config.nextRunAt?.getTime() ?? Infinity;
        return av - bv;
      }
      case "last-run": {
        const av = a.config.lastRunAt?.getTime() ?? 0;
        const bv = b.config.lastRunAt?.getTime() ?? 0;
        return bv - av;
      }
      default:
        return a.config.title.localeCompare(b.config.title);
    }
  });

  const totalFiltered = sorted.length;
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pageGids = pageRows.map((r) => r.config.collectionGid);
  const previewByGid = new Map<string, CollectionRowData["preview"]>();
  if (!hydrationFailed && pageGids.length) {
    try {
      const hydrated = await hydrateTrackedCollections(admin, pageGids);
      for (const [gid, h] of hydrated) previewByGid.set(gid, h.preview);
    } catch (err) {
      console.error("[app.collections] thumbnail hydration failed:", err);
    }
  }

  const rows: CollectionRowData[] = pageRows.map((r) => {
    const c = r.config;
    const live = r.live;
    const liveCount = live?.productsCount ?? c.productCount;

    const factsParts: string[] = [`${liveCount} product${liveCount === 1 ? "" : "s"}`];
    if (c.lastSoldOutCount != null && c.lastSoldOutCount > 0) factsParts.push(`${c.lastSoldOutCount} sold out`);

    const settingsBadges: string[] = [];
    if (c.pushSoldOutToEnd) settingsBadges.push("Sold-out last");
    if (c.boostNewArrivals) settingsBadges.push("New arrivals first");
    if (c.pins > 0) settingsBadges.push(`${c.pins} pin${c.pins === 1 ? "" : "s"}`);
    if (c.giveEveryoneATurn) settingsBadges.push("Fair rotation");

    const scheduleLine = c.status === "PAUSED" ? "Paused" : scheduleLabel(c.scheduleType, c.scheduleTime, c.scheduleWeekday);
    const scheduleSubLine =
      c.status === "PAUSED"
        ? "Resume to schedule"
        : c.nextRunAt
          ? `Next run in ${formatTimeUntil(c.nextRunAt, now)}`
          : "Shuffles only when you press Shuffle";

    const latestRun = latestRunByCollectionId.get(c.id);
    const lastRun = latestRun
      ? {
          moved: latestRun.movedCount,
          whenLabel: lastRunLabel(latestRun.createdAt, settings.timezone, now),
          failed: latestRun.status === "FAILED",
        }
      : null;

    return {
      id: c.id,
      collectionGid: c.collectionGid,
      title: live?.title ?? c.title,
      status: c.status as "RUNNING" | "PAUSED",
      needsAttention: r.needsAttention,
      factsLine: factsParts.join(" · "),
      settingsBadges,
      preview: previewByGid.get(c.collectionGid) ?? [],
      scheduleLine,
      scheduleSubLine,
      lastRun,
    };
  });

  const trackedGidSet = new Set(tracked.map((t) => t.collectionGid));

  const needsAttention: NeedsAttentionItem[] = fullRows
    .filter((r) => r.needsAttention && r.live)
    .map((r) => ({
      id: r.config.id,
      gid: r.config.collectionGid,
      title: r.live!.title,
      sortOrderLabel: sortOrderLabel(r.live!.sortOrder),
    }));

  const untrackedNeedsAttention: UntrackedAttentionItem[] = hydrationFailed
    ? []
    : (allShopCollections ?? [])
        .filter((c) => !trackedGidSet.has(c.id) && c.sortOrder !== "MANUAL")
        .map((c) => ({ gid: c.id, title: c.title, sortOrderLabel: sortOrderLabel(c.sortOrder) }));

  const allSoldOutCollections: AllSoldOutItem[] = fullRows
    .filter((r) => r.allSoldOut)
    .map((r) => ({ id: r.config.id, title: r.config.title, status: r.config.status as "RUNNING" | "PAUSED" }));

  const runningCount = tracked.filter((t) => t.status === "RUNNING").length;
  const soonestNextRunMs = tracked
    .filter((t) => t.status === "RUNNING" && t.nextRunAt)
    .map((t) => t.nextRunAt!.getTime())
    .sort((a, b) => a - b)[0];

  const totalProductsInRotation = fullRows.reduce(
    (sum, r) => sum + (r.live?.productsCount ?? r.config.productCount),
    0,
  );

  return {
    rows,
    page,
    q,
    status,
    sort,
    trackedTotal: tracked.length,
    totalFiltered,
    totalStoreCollections: hydrationFailed ? null : (allShopCollections?.length ?? null),
    hasNextPage: page * PAGE_SIZE < totalFiltered,
    hasPrevPage: page > 1,
    hydrationFailed,
    needsAttention,
    untrackedNeedsAttention,
    allSoldOutCollections,
    runningCount,
    nextRunInLabel: soonestNextRunMs ? formatTimeUntil(new Date(soonestNextRunMs), now) : null,
    totalProductsInRotation,
  };
};

function scheduleLabel(
  type: string,
  time: string,
  weekday: number | null,
): string {
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

function formatTimeUntil(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "any moment";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** formatActivityTimestamp's "Today 06:01" / "Yesterday 14:22", lower-cased
 * to match this row's own copy style ("today 06:01"). */
function lastRunLabel(createdAt: Date, timezone: string, now: Date): string {
  return formatActivityTimestamp(createdAt, timezone, now)
    .replace(/^Today/, "today")
    .replace(/^Yesterday/, "yesterday");
}

function spellSmallNumber(n: number): string {
  if (n >= 0 && n <= 10) {
    const word = NUMBER_WORDS[n];
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  return String(n);
}

// ============================== action ==============================

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
    const room =
      plan.maxCollections === Infinity
        ? ids.length
        : Math.max(0, plan.maxCollections - existingCount);
    const toAdd = ids.slice(0, room);

    let preset: {
      pins: number;
      pushSoldOutToEnd: boolean;
      boostNewArrivals: boolean;
      giveEveryoneATurn: boolean;
    };
    if (startWith === "same") {
      const first = await db.collectionConfig.findFirst({
        where: { shop },
        orderBy: { createdAt: "asc" },
      });
      preset = first
        ? {
            pins: first.pins,
            pushSoldOutToEnd: first.pushSoldOutToEnd,
            boostNewArrivals: first.boostNewArrivals,
            giveEveryoneATurn: first.giveEveryoneATurn,
          }
        : {
            pins: 0,
            pushSoldOutToEnd: true,
            boostNewArrivals: true,
            giveEveryoneATurn: true,
          };
    } else if (startWith === "nothing") {
      preset = {
        pins: 0,
        pushSoldOutToEnd: false,
        boostNewArrivals: false,
        giveEveryoneATurn: false,
      };
    } else {
      preset = {
        pins: 0,
        pushSoldOutToEnd: true,
        boostNewArrivals: false,
        giveEveryoneATurn: false,
      };
    }

    for (const gid of toAdd) {
      const title = String(
        formData.get(`collectionTitle:${gid}`) ?? "Collection",
      );
      const nextRunAt = computeNextRun(
        new Date(),
        settings.timezone,
        "DAILY",
        settings.defaultRunTime,
        null,
      );
      await db.collectionConfig.upsert({
        where: { shop_collectionGid: { shop, collectionGid: gid } },
        update: {},
        create: {
          shop,
          collectionGid: gid,
          title,
          scheduleTime: settings.defaultRunTime,
          nextRunAt,
          ...preset,
        },
      });
    }
    return data({
      ok: true,
      added: toAdd.length,
      skipped: ids.length - toAdd.length,
    });
  }

  if (actionType === "switch-to-manual") {
    const id = String(formData.get("id"));
    const gid = String(formData.get("gid"));
    const keepOrder = formData.get("keepOrder") !== "false";
    const config = await db.collectionConfig.findFirst({ where: { id, shop } });
    if (!config)
      return data(
        { ok: false, error: "That collection couldn't be found." },
        { status: 404 },
      );

    const result = await setCollectionManualSort(admin, gid);
    if (!result.ok) return data(result);

    await db.collectionConfig.update({
      where: { id },
      data: { status: "RUNNING", previousSortOrder: result.previousSortOrder },
    });

    if (!keepOrder) {
      await runShuffleForCollection(
        admin,
        shop,
        config,
        settings.timezone,
        settings.neverMoveTags,
        "MANUAL",
      );
    }
    return data({ ok: true });
  }

  if (actionType === "switch-untracked-to-manual") {
    const gid = String(formData.get("gid"));
    const result = await setCollectionManualSort(admin, gid);
    if (!result.ok) {
      return data({ ok: false, error: result.error ?? "Couldn't switch that collection." }, { status: 400 });
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
        ? computeNextRun(
            new Date(),
            settings.timezone,
            config.scheduleType as ScheduleType,
            config.scheduleTime,
            config.scheduleWeekday,
          )
        : null;
    await db.$transaction([
      db.collectionConfig.update({
        where: { id },
        data: { status: nextStatus, nextRunAt },
      }),
      db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger: nextStatus === "PAUSED" ? "PAUSED" : "RESUMED",
          status: "OK",
          message:
            nextStatus === "PAUSED"
              ? `${config.title} paused`
              : `${config.title} resumed`,
        },
      }),
    ]);
    return data({ ok: true });
  }

  if (actionType === "pause-all") {
    const running = await db.collectionConfig.findMany({
      where: { shop, status: "RUNNING" },
    });
    await db.$transaction([
      db.collectionConfig.updateMany({
        where: { shop, status: "RUNNING" },
        data: { status: "PAUSED", nextRunAt: null },
      }),
      ...running.map((c) =>
        db.shuffleRun.create({
          data: {
            shop,
            collectionId: c.id,
            trigger: "PAUSED",
            status: "OK",
            message: `${c.title} paused`,
          },
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
      const result = await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL");
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
    const result = await runShuffleForCollection(
      admin,
      shop,
      config,
      settings.timezone,
      settings.neverMoveTags,
      "MANUAL",
    );
    return data(result);
  }

  if (actionType === "shuffle-remaining") {
    const onPageIds = formData.getAll("onPageId").map(String);
    const remaining = await db.collectionConfig.findMany({
      where: { shop, status: "RUNNING", id: { notIn: onPageIds } },
    });
    let moved = 0;
    for (const config of remaining) {
      const result = await runShuffleForCollection(
        admin,
        shop,
        config,
        settings.timezone,
        settings.neverMoveTags,
        "MANUAL",
      );
      if (result.ok) moved += result.movedCount;
    }
    return data({ ok: true, collections: remaining.length, moved });
  }

  if (actionType === "preview-shuffle-all") {
    const running = await db.collectionConfig.findMany({
      where: { shop, status: "RUNNING" },
    });
    const preview = await previewShuffleAll(
      admin,
      shop,
      running,
      settings.neverMoveTags,
    );
    return data(preview);
  }

  return data({ ok: false, error: "Unknown action" }, { status: 400 });
};

// ============================== component ==============================

export default function Collections() {
  const {
    rows,
    page,
    q,
    status,
    sort,
    trackedTotal,
    totalStoreCollections,
    hasNextPage,
    hasPrevPage,
    hydrationFailed,
    needsAttention,
    untrackedNeedsAttention,
    allSoldOutCollections,
    runningCount,
    nextRunInLabel,
    totalProductsInRotation,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const shopify = useAppBridge();
  const isPaginating =
    navigation.state === "loading" &&
    navigation.location?.pathname === "/app/collections";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const addModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const shuffleAllModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const switchModalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
  const bulkRemoveModalRef = useRef<any>(null);

  const picker = useFetcher<AddCollectionsPickerData>({
    key: "collections-picker",
  });
  const previewFetcher = useFetcher({ key: "shuffle-all-preview" });
  const remainingFetcher = useFetcher({ key: "shuffle-remaining" });
  const switchFetcher = useFetcher<{ ok: boolean; error?: string }>({
    key: "switch-to-manual",
  });
  const untrackedSwitchFetcher = useFetcher<{ ok: boolean; error?: string }>({
    key: "switch-untracked-to-manual",
  });
  const addFetcher = useFetcher<{
    ok: boolean;
    added?: number;
    skipped?: number;
  }>({ key: "add-collections" });
  const bulkFetcher = useFetcher<{ ok: boolean; moved?: number; collections?: number }>({
    key: "bulk-action",
  });

  const [shuffleRunId, setShuffleRunId] = useState<number | null>(null);
  const [pendingRowIds, setPendingRowIds] = useState<Set<string>>(new Set());
  const [switchTarget, setSwitchTarget] = useState<SwitchToManualTarget | null>(
    null,
  );
  const [awaitingAddModal, setAwaitingAddModal] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const shuffleWasActive = useRef(false);

  // A filter/search/sort change (or a page change) makes the previous
  // selection meaningless — rows on screen are a different set now.
  useEffect(() => {
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync on any change to which rows are showing
  }, [q, status, sort, page]);

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    if (value == null || value === "") next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  }

  function openAddModal() {
    // Reload every time (not just when empty) so the addable count is never
    // stale — we decide whether to actually open the modal once it's in.
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
    previewFetcher.submit(
      { _action: "preview-shuffle-all" },
      { method: "post" },
    );
    shuffleAllModalRef.current?.showOverlay();
  }

  function confirmShuffleAll() {
    closeModal(shuffleAllModalRef.current);
    const runningOnPage = rows.filter(
      (r) => r.status === "RUNNING" && !r.needsAttention,
    );
    if (runningOnPage.length === 0 && rows.length === trackedTotal) return; // nothing to do at all
    setPendingRowIds(new Set(runningOnPage.map((r) => r.id)));
    shuffleWasActive.current = true;
    setShuffleRunId((n) => (n ?? 0) + 1);
    remainingFetcher.submit(
      { _action: "shuffle-remaining", onPageId: rows.map((r) => r.id) },
      { method: "post" },
    );
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
      {
        _action: "switch-to-manual",
        id: switchTarget.id,
        gid: switchTarget.gid,
        keepOrder: String(keepOrder),
      },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (switchFetcher.state === "idle" && switchFetcher.data) {
      closeModal(switchModalRef.current);
      if (switchFetcher.data.ok) {
        shopify.toast.show(
          `${switchTarget?.title ?? "Collection"} switched to Manual sort`,
        );
      } else {
        shopify.toast.show(
          switchFetcher.data.error ?? "Couldn't switch that collection",
          { isError: true },
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [switchFetcher.state, switchFetcher.data]);

  function switchUntrackedToManual(gid: string, title: string) {
    untrackedSwitchFetcher.submit({ _action: "switch-untracked-to-manual", gid }, { method: "post" });
    shopify.toast.show(`Switching ${title} to Manual sort…`);
  }

  useEffect(() => {
    if (untrackedSwitchFetcher.state === "idle" && untrackedSwitchFetcher.data) {
      if (untrackedSwitchFetcher.data.ok) {
        shopify.toast.show("Switched to Manual sort");
        revalidator.revalidate();
      } else {
        shopify.toast.show(untrackedSwitchFetcher.data.error ?? "Couldn't switch that collection", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [untrackedSwitchFetcher.state, untrackedSwitchFetcher.data]);

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
    bulkFetcher.submit({ _action: actionName, id: Array.from(selected) }, { method: "post" });
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
  // Which bulk action is actually in flight — so only the pressed button
  // shows a spinner while all four stay disabled, instead of all four
  // spinning at once.
  const pendingBulkAction = bulkBusy ? lastBulkAction : null;
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectionHasRunning = selectedRows.some((r) => r.status === "RUNNING");
  const selectionHasPaused = selectedRows.some((r) => r.status === "PAUSED");

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

  const subtitle = (() => {
    if (!hasAnythingTracked || totalStoreCollections == null) return null;
    const base = `${spellSmallNumber(trackedTotal)} of your ${totalStoreCollections} collection${totalStoreCollections === 1 ? "" : "s"} ${trackedTotal === 1 ? "is" : "are"} being kept fresh.`;
    if (runningCount === 0) return base; // everything's paused — no "next run" to report
    return `${base} Next run in ${nextRunInLabel ?? "—"}.`;
  })();

  return (
    <s-page heading="Collections" {...noHydrationWarning}>
      <s-button
        slot="secondary-actions"
        onClick={openAddModal}
        {...noHydrationWarning}
      >
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
        <s-button
          onClick={() => shopify.toast.show("Export isn't available yet")}
        >
          Export
        </s-button>
        <PauseAllButton />
      </s-menu>

      {hasAnythingTracked && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={openShuffleAllModal}
          {...noHydrationWarning}
        >
          Shuffle all now
        </s-button>
      )}

      {hasAnythingTracked && subtitle && <s-paragraph>{subtitle}</s-paragraph>}

      {hydrationFailed ? (
        <s-banner tone="warning" heading="Couldn't load live data from Shopify">
          <s-paragraph>
            Counts, thumbnails, and the &quot;needs attention&quot; check need a
            live connection — everything below still reflects what Shuffly is
            tracking, just without that extra detail for now.
          </s-paragraph>
          <div>
            <s-button
              onClick={() => revalidator.revalidate()}
              {...(revalidator.state !== "idle" ? { loading: true } : {})}
            >
              Retry
            </s-button>
          </div>
        </s-banner>
      ) : (
        <>
          <NeedsAttentionBanner list={needsAttention} onSwitch={openSwitchModal} />
          <UntrackedAttentionBanner
            list={untrackedNeedsAttention}
            busy={untrackedSwitchFetcher.state !== "idle"}
            onSwitch={switchUntrackedToManual}
          />
          <AllSoldOutBanner list={allSoldOutCollections} />
        </>
      )}

      {hasAnythingTracked && trackedTotal > 5 && (
        <s-section padding="none">
          <CollectionsFilterBar
            q={q}
            status={status}
            sort={sort}
            onQChange={(v) => updateParam("q", v)}
            onStatusChange={(v) => updateParam("status", v === "all" ? null : v)}
            onSortChange={(v) => updateParam("sort", v === "name" ? null : v)}
          />
        </s-section>
      )}

      <s-section padding="none">
        {selected.size > 0 && (
          <div className="shuffly-bulk-bar">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <s-text type="strong">{selected.size} selected</s-text>
              <button
                type="button"
                className="shuffly-bulk-clear"
                aria-label="Clear selection"
                onClick={() => setSelected(new Set())}
              >
                <XGlyph />
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="shuffly-bulk-btn shuffly-bulk-btn--primary"
                onClick={() => runBulk("bulk-shuffle")}
                disabled={bulkBusy}
              >
                {pendingBulkAction === "bulk-shuffle" ? "Shuffling…" : "Shuffle now"}
              </button>

              {selectionHasRunning && (
                <button
                  type="button"
                  className="shuffly-bulk-btn shuffly-bulk-btn--secondary"
                  onClick={() => runBulk("bulk-pause")}
                  disabled={bulkBusy}
                >
                  {pendingBulkAction === "bulk-pause" ? "Pausing…" : "Pause"}
                </button>
              )}
              {selectionHasPaused && (
                <button
                  type="button"
                  className="shuffly-bulk-btn shuffly-bulk-btn--secondary"
                  onClick={() => runBulk("bulk-resume")}
                  disabled={bulkBusy}
                >
                  {pendingBulkAction === "bulk-resume" ? "Resuming…" : "Resume"}
                </button>
              )}

              <span className="shuffly-bulk-divider" aria-hidden="true" />

              <button
                type="button"
                className="shuffly-bulk-btn shuffly-bulk-btn--critical"
                onClick={() => bulkRemoveModalRef.current?.showOverlay()}
                disabled={bulkBusy}
              >
                {pendingBulkAction === "bulk-remove" ? "Removing…" : "Remove from Shuffly"}
              </button>
            </div>
          </div>
        )}

        {isPaginating ? (
          <SkeletonRows />
        ) : rows.length === 0 && trackedTotal === 0 ? (
          <EmptyCollectionsState onAdd={openAddModal} />
        ) : rows.length === 0 ? (
          <s-box padding="large-500">
            <s-stack direction="block" gap="small" alignItems="center">
              <s-text color="subdued">No collections match this filter.</s-text>
            </s-stack>
          </s-box>
        ) : (
          <>
            <div className="shuffly-collections-grid-container">
              <CollectionsHeaderRow />
              {rows.map((r, i) => (
                <div key={r.id}>
                  <CollectionRow
                    collection={r}
                    shuffleRunId={pendingRowIds.has(r.id) ? shuffleRunId : null}
                    onShuffleSettled={handleRowSettled}
                    selected={selected.has(r.id)}
                    onToggleSelect={toggleSelect}
                  />
                  {i < rows.length - 1 && <s-divider />}
                </div>
              ))}
            </div>
            <s-divider />
            <s-box padding="base">
              <s-stack
                direction="inline"
                justifyContent="space-between"
                alignItems="center"
              >
                <s-text color="subdued">
                  {trackedTotal} of {totalStoreCollections ?? "?"} collections · {totalProductsInRotation} products in rotation
                </s-text>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  {(hasPrevPage || hasNextPage) && (
                    <>
                      {hasPrevPage ? (
                        <Link to={`?${withParam(searchParams, "page", String(page - 1))}`}>
                          <s-button variant="tertiary">Previous</s-button>
                        </Link>
                      ) : (
                        <s-button variant="tertiary" disabled>
                          Previous
                        </s-button>
                      )}
                      {hasNextPage ? (
                        <Link to={`?${withParam(searchParams, "page", String(page + 1))}`}>
                          <s-button variant="tertiary">Next</s-button>
                        </Link>
                      ) : (
                        <s-button variant="tertiary" disabled>
                          Next
                        </s-button>
                      )}
                    </>
                  )}
                  <s-button variant="tertiary" onClick={openAddModal}>
                    Add more
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          </>
        )}
      </s-section>

      <AddCollectionsModal
        ref={addModalRef}
        picker={picker}
        onSubmit={submitAddCollections}
        onCancel={() => closeModal(addModalRef.current)}
      />

      <ShuffleAllConfirmModal
        ref={shuffleAllModalRef}
        onConfirm={confirmShuffleAll}
        onCancel={() => closeModal(shuffleAllModalRef.current)}
      />

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
          font-size: 11px;
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
        /* Only the actions cluster rings the row on keyboard focus — not
           the checkbox. Checkboxes keep :focus-visible on a plain mouse
           click (correct, standard behavior for form controls), which was
           making a click that just selects a row also draw the row-wide
           ring, reading as a stray outline. A plain div/link can't itself
           match :focus-visible via :focus-within reliably without also
           catching that mouse click, so :has() targeting the specific
           descendant is what actually scopes this correctly. */
        .shuffly-row:has(> .shuffly-row-link-overlay:focus-visible),
        .shuffly-row:has(> .shuffly-row-actions :focus-visible) {
          outline: 2px solid var(--p-color-border-focus, #005bd3);
          outline-offset: -2px;
        }
        /* Selected: a tint across the full row plus a left accent bar
           (inset box-shadow, so it adds no width and shifts nothing) —
           never a rectangle drawn around content. */
        .shuffly-row--selected,
        .shuffly-row--selected:hover {
          background: var(--p-color-bg-fill-info-secondary, #EAF2FF);
          box-shadow: inset 3px 0 0 0 var(--p-color-border-info, #1F5199);
        }
        .shuffly-row-select { display: flex; align-items: center; justify-content: center; }
        /* s-checkbox has no size prop of its own — scaling it down is the
           only reliable way to make the box itself smaller. transform
           doesn't affect layout size, so the 36px column still reserves
           the same width either way. */
        .shuffly-row-select s-checkbox { transform: scale(0.65); }
        .shuffly-row-text, .shuffly-thumbs, .shuffly-row-schedule, .shuffly-row-lastrun {
          min-width: 0;
        }
        .shuffly-row-title, .shuffly-row-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* Left-aligned, like every other column — Schedule and Last run
           used to be right-aligned, which pushed them together into one
           blob with a gap in front. Aligning every column under its own
           header, left edge to left edge, is what makes the grid scannable
           down the page. */
        .shuffly-thumbs { display: flex; align-items: center; gap: 4px; }
        .shuffly-row-schedule, .shuffly-row-lastrun { text-align: left; }
        .shuffly-row-mobile-label { display: none; }
        .shuffly-row-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 4px;
          padding-right: 8px;
        }
        .shuffly-row-quick-buttons { display: flex; align-items: center; gap: 4px; }
        /* A real container query, not @media — @media measures the whole
           embedded iframe's own viewport, which is narrower than it looks
           because of Admin's surrounding chrome (nav sidebar etc.), so it
           was collapsing the buttons at widths where the CARD itself had
           plenty of room. This measures .shuffly-collections-grid-container
           itself, which is what actually matters. */
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
          /* Below this width the quick buttons collapse into the overflow
             menu (mirrored there — see CollectionRow.tsx), so the row
             never has to scroll sideways to fit them. */
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
        .shuffly-bulk-bar {
          position: sticky;
          top: 0;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 36px;
          padding: 10px 16px;
          /* Light green — same success tint used elsewhere in the app
             (e.g. the Plan page's icon chips). */
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
          /* Quiet at rest — same neutral border as the secondary buttons,
             not a red outline. The red text alone is enough to mark it as
             destructive without it shouting; the border only turns red on
             hover/focus, as an "about to act" signal. */
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
      `}</style>
    </s-page>
  );
}

function withParam(searchParams: URLSearchParams, key: string, value: string): string {
  const next = new URLSearchParams(searchParams);
  next.set(key, value);
  return next.toString();
}

function PauseAllButton() {
  const fetcher = useFetcher();
  return (
    <s-button
      onClick={() =>
        fetcher.submit({ _action: "pause-all" }, { method: "post" })
      }
      {...(fetcher.state !== "idle" ? { loading: true } : {})}
    >
      Pause all
    </s-button>
  );
}

function NeedsAttentionBanner({
  list,
  onSwitch,
}: {
  list: NeedsAttentionItem[];
  onSwitch: (target: SwitchToManualTarget) => void;
}) {
  if (list.length === 0) return null;
  const [first, ...rest] = list;
  const heading =
    rest.length > 0
      ? `“${first.title}” and ${rest.length} other${rest.length === 1 ? "" : "s"} can't be shuffled yet`
      : `“${first.title}” can't be shuffled yet`;

  return (
    <s-banner tone="warning" heading={heading}>
      <s-paragraph>
        It uses Shopify&apos;s{" "}
        <s-text type="strong">{first.sortOrderLabel}</s-text> sort
        {rest.length > 0
          ? ", and the others use their own sort orders too"
          : ""}
        . Shuffly needs Manual sort to set positions.
      </s-paragraph>
      <div>
        <s-button
          onClick={() =>
            onSwitch({
              id: first.id,
              gid: first.gid,
              title: first.title,
              sortOrderLabel: first.sortOrderLabel,
            })
          }
        >
          Switch to Manual
        </s-button>
      </div>
    </s-banner>
  );
}

function UntrackedAttentionBanner({
  list,
  busy,
  onSwitch,
}: {
  list: UntrackedAttentionItem[];
  busy: boolean;
  onSwitch: (gid: string, title: string) => void;
}) {
  if (list.length === 0) return null;
  const [first, ...rest] = list;
  const heading =
    rest.length > 0
      ? `“${first.title}” and ${rest.length} other${rest.length === 1 ? "" : "s"} you haven't added yet can't be shuffled`
      : `“${first.title}” can't be shuffled if you add it`;

  return (
    <s-banner tone="warning" heading={heading}>
      <s-paragraph>
        It uses Shopify&apos;s <s-text type="strong">{first.sortOrderLabel}</s-text> sort. Switch it to
        Manual now, or Shuffly will offer to when you add it.
      </s-paragraph>
      <div>
        <s-button
          onClick={() => onSwitch(first.gid, first.title)}
          {...(busy ? { loading: true } : {})}
        >
          Switch to Manual
        </s-button>
      </div>
    </s-banner>
  );
}

function AllSoldOutBanner({ list }: { list: AllSoldOutItem[] }) {
  if (list.length === 0) return null;
  return (
    <>
      {list.map((c) => (
        <SoldOutBannerItem key={c.id} item={c} />
      ))}
    </>
  );
}

/** Same heading + paragraph + action shape as NeedsAttentionBanner and
 * UntrackedAttentionBanner above — this one was a bare sentence with no
 * heading and nothing to actually do about it, which is why it read as
 * plainer/lower-effort than its two siblings on the same page. Pausing a
 * collection that's 100% sold out is also a genuinely useful default
 * action, not just a cosmetic one — there's nothing for Shuffly to
 * meaningfully do with it until it's back in stock. */
function SoldOutBannerItem({ item }: { item: AllSoldOutItem }) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<{ ok: boolean }>({ key: `pause-soldout-${item.id}` });
  const busy = fetcher.state !== "idle";

  function pause() {
    fetcher.submit({ _action: "pause", id: item.id }, { method: "post" });
  }

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show(`${item.title} paused`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [fetcher.state, fetcher.data]);

  return (
    <s-banner tone="info" heading={`Every product in ${item.title} is sold out`}>
      <s-paragraph>
        Shuffling it won&apos;t change anything until something&apos;s back in stock — pause it for
        now, or leave it running and it&apos;ll pick back up on its own once inventory changes.
      </s-paragraph>
      {item.status === "RUNNING" && (
        <div>
          <s-button onClick={pause} disabled={busy || undefined} {...(busy ? { loading: true } : {})}>
            Pause {item.title}
          </s-button>
        </div>
      )}
    </s-banner>
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
        <s-text color="subdued">
          Add your first collection and Shuffly will keep it fresh
          automatically.
        </s-text>
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
      <path
        d="M2 2L10 10M10 2L2 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Bar({ width }: { width: number }) {
  return (
    <div
      style={{
        width,
        height: 12,
        borderRadius: 4,
        background: "var(--p-color-bg-surface-tertiary, #e3e3e3)",
      }}
    />
  );
}

function SkeletonRows() {
  return (
    <s-box padding="base">
      <s-stack direction="block" gap="base">
        {[0, 1, 2, 3].map((i) => (
          <s-stack
            key={i}
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-stack direction="block" gap="small-200">
              <Bar width={160} />
              <Bar width={220} />
            </s-stack>
            <Bar width={80} />
          </s-stack>
        ))}
      </s-stack>
    </s-box>
  );
}
