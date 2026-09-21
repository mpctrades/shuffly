import { isOverridden, overrideWriteFields, resolveSchedule, shopDefaultSchedule } from "../lib/schedule-resolve";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigation, useFetcher, Form, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { getCollectionPreviewAndCount, setCollectionManualSort, sortOrderLabel } from "../lib/collections.server";
import { restoreOnRemove, runShuffleForCollection, undoRun } from "../lib/shuffle-engine.server";
import {
  formatActivityTimestamp,
  formatNextRun,
  nextRunFor,
  normalizeHhMm,
  slotsFarEnoughApart,
  type ScheduleType,
  type SlotSchedule,
} from "../lib/schedule-core";
import { ShuffleScheduleModal, type ScheduleTarget } from "../components/ShuffleScheduleModal";
import { SwitchToManualModal, type SwitchToManualTarget } from "../components/SwitchToManualModal";
import { ReorderDelayNote } from "../components/ManualSortWarning";
import { RemoveCollectionModal } from "../components/RemoveCollectionModal";
import { closeModal, useModalDismissWorkaround } from "../lib/polaris-modal";
import { isScheduleAllowed, planOf, pruneExpiredUndoSnapshots, timeSlots } from "../lib/plans.server";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RULES_SAVE_BAR_ID = "collection-rules-save-bar";

/** The second slot is a top-tier entitlement. Gate on the entitlement, not
 * on a plan id, so a re-tiering can't quietly lock the feature for the plan
 * that pays for it. */
const SECOND_SLOT_SCHEDULE: ScheduleType = "TWICE_DAILY";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const config = await db.collectionConfig.findFirst({ where: { id: params.id, shop } });
  if (!config) throw new Response("Not found", { status: 404 });

  const settings = await getOrCreateShopSettings(admin, shop);
  const plan = planOf(settings.plan);
  await pruneExpiredUndoSnapshots(shop, plan.id);
  // Only fetches the 16 products this page actually renders, plus Shopify's
  // own aggregate count — not the whole collection (see
  // getCollectionPreviewAndCount's doc comment). The real shuffle re-fetches
  // the full ordered list itself when it runs.
  const { sortOrder, totalCount, preview: previewProducts } = await getCollectionPreviewAndCount(admin, config.collectionGid, 16);
  const neverMoveTags = new Set(
    settings.neverMoveTags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  const now = Date.now();
  const newArrivalMs = config.newArrivalDays * 86_400_000;

  const preview = previewProducts.map((p, idx) => ({
    id: p.id,
    title: p.title,
    initial: p.title.trim().charAt(0).toUpperCase() || "?",
    pinned: idx < config.pins,
    soldOut: p.tracksInventory && p.totalInventory <= 0,
    isNew: now - new Date(p.createdAt).getTime() <= newArrivalMs,
    neverMove: p.tags.some((t) => neverMoveTags.has(t.toLowerCase())),
  }));

  const runRows = await db.shuffleRun.findMany({
    where: { collectionId: config.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  // Formatted server-side, in the shop's own timezone, with a fixed locale —
  // `new Date(...).toLocaleString()` in the component would use whatever
  // locale/timezone each *runtime* defaults to, which differs between the
  // Node server and the browser and causes a hydration text mismatch.
  const runs = runRows.map((r) => ({ ...r, whenLabel: formatActivityTimestamp(r.createdAt, settings.timezone, new Date(now)) }));

  return {
    // The effective schedule is overlaid onto the raw row, so this page's form
    // seeds from what the collection actually runs on — which is the shop
    // default whenever the row's own columns are null. `scheduleIsOverridden`
    // is what tells the two apart for display.
    config: { ...config, ...resolveSchedule(config, settings), scheduleIsOverridden: isOverridden(config) },
    sortOrder,
    sortOrderLabel: sortOrderLabel(sortOrder),
    productCount: totalCount,
    preview,
    runs,
    // One field for one value. This page used to send the same timezone
    // three ways (raw, labelled-with-offset, and "name") because three
    // different controls each wanted their own spelling of it; the modal
    // names the timezone itself, once, so the other two had no readers left.
    timezoneName: settings.timezone,
    nextRunLabel: formatNextRun(config.nextRunAt, settings.timezone),
    // Drives the remove dialog's copy — it must only offer what these two
    // fields can actually deliver.
    restorable: {
      sortOrderLabel: config.previousSortOrder ? sortOrderLabel(config.previousSortOrder) : null,
      hasOrderSnapshot: Boolean(config.originalOrder) && !config.previousSortOrder,
    },
    allowedSchedules: plan.allowedSchedules,
    // Same helper the plan bar composes "N time slots" from — so the picker
    // that offers the slot and the copy that advertises it cannot disagree.
    canPickSecondSlot: timeSlots(plan.id) >= 2,
    // The schedule modal's own inputs. `planId` is what gates the frequency
    // grid (via PLANS[].allowedSchedules, the field the scheduler enforces),
    // and `shopDefault` is what "Use shop default" both resets to and
    // previews — the same object the Collections page sends it.
    planId: plan.id,
    scheduleSlots: timeSlots(plan.id),
    shopDefault: shopDefaultSchedule(settings),
    canPin: plan.canPin,
    undoRetentionDays: plan.undoRetentionDays,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const config = await db.collectionConfig.findFirst({ where: { id: params.id, shop } });
  if (!config) throw new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const actionType = formData.get("_action");
  const settings = await getOrCreateShopSettings(admin, shop);
  const plan = planOf(settings.plan);

  if (actionType === "save-settings") {
    const pins = plan.canPin
      ? Math.max(0, Math.min(20, Number(formData.get("pins") ?? 0)))
      : 0;
    const pushSoldOutToEnd = formData.get("pushSoldOutToEnd") === "on";
    const boostNewArrivals = formData.get("boostNewArrivals") === "on";
    const giveEveryoneATurn = formData.get("giveEveryoneATurn") === "on";

    // Schedule is deliberately NOT part of this form any more. It is edited
    // in the shared schedule modal and saved by `set-schedule` below — the
    // same component and the same write path the Collections table uses. The
    // four dropdowns that used to live here were the one schedule UI in the
    // app that had drifted: no cadence cards, no inheritance, no way back to
    // the shop default, and a second-slot field visible on every cadence.
    await db.collectionConfig.update({
      where: { id: config.id },
      data: { pins, pushSoldOutToEnd, boostNewArrivals, giveEveryoneATurn },
    });
    return data({ ok: true });
  }

  // The schedule, saved on its own. A near-copy of the Collections page's
  // `set-schedule` for a single id, and for the same reason: an override is
  // four columns written together, or four columns nulled together to go
  // back to inheriting. Nothing else may write them.
  if (actionType === "set-schedule") {
    const toDefault = String(formData.get("scheduleMode") ?? "") === "default";

    let override: ReturnType<typeof overrideWriteFields>;
    if (toDefault) {
      override = overrideWriteFields(null);
    } else {
      const scheduleType = String(formData.get("scheduleType") ?? "DAILY") as ScheduleType;
      // Checked here, not only in the UI — a hand-rolled POST must not be
      // able to buy a cadence the plan doesn't include.
      if (!isScheduleAllowed(settings.plan, scheduleType)) {
        return data(
          { ok: false, error: `Your ${plan.name} plan doesn't include that schedule.` },
          { status: 400 },
        );
      }
      const scheduleTime = normalizeHhMm(String(formData.get("scheduleTime") ?? "06:00"));
      const rawTime2 = formData.get("scheduleTime2");
      const scheduleTime2 =
        scheduleType === SECOND_SLOT_SCHEDULE && rawTime2 != null && rawTime2 !== ""
          ? normalizeHhMm(String(rawTime2))
          : null;
      if (scheduleTime2 != null && timeSlots(settings.plan) < 2) {
        return data({ ok: false, error: "Two shuffles a day is a Pro feature." }, { status: 400 });
      }
      if (scheduleTime2 != null && !slotsFarEnoughApart(scheduleTime, scheduleTime2)) {
        return data(
          { ok: false, error: "Keep the two shuffle times at least an hour apart." },
          { status: 400 },
        );
      }
      const rawWeekday = formData.get("scheduleWeekday");
      override = overrideWriteFields({
        scheduleType,
        scheduleTime,
        scheduleTime2,
        scheduleWeekday: rawWeekday != null && rawWeekday !== "" ? Number(rawWeekday) : null,
      });
    }

    // Compared against what the collection actually runs on today, which may
    // be the shop default rather than anything stored on this row — and
    // against whether it was inheriting at all, since switching to a custom
    // schedule identical to the default is still a real change.
    const before = resolveSchedule(config, settings);
    const after = resolveSchedule({ ...config, ...override }, settings);
    const summaryOf = (sch: typeof before) =>
      scheduleSummary(sch.scheduleType, sch.scheduleTime, sch.scheduleTime2 ?? null, sch.scheduleWeekday);
    const scheduleChanged =
      summaryOf(before) !== summaryOf(after) || isOverridden(config) !== (override.scheduleType != null);

    await db.collectionConfig.update({
      where: { id: config.id },
      data: {
        ...override,
        // The countdown is derived from the EFFECTIVE schedule, so a row
        // that just went back to inheriting points at the shop default's
        // next run rather than at its own former time.
        nextRunAt: config.status === "RUNNING" ? nextRunFor(new Date(), settings.timezone, after) : null,
        // Stamped only when a schedule field actually moved. The sweep uses
        // it to tell "the worker was down, run this late" apart from "the
        // merchant just moved this slot into the past, don't back-fire".
        ...(scheduleChanged ? { scheduleUpdatedAt: new Date() } : {}),
      },
    });

    // Schedule changes show up in Activity the way pause/resume already do —
    // a merchant asking "why did this run at a different time?" can see when
    // it was changed and to what.
    if (scheduleChanged) {
      await db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger: "SCHEDULE_CHANGED",
          status: "OK",
          message: `Schedule changed to ${summaryOf(after)}${
            override.scheduleType == null ? " (shop default)" : ""
          } — was ${summaryOf(before)}`,
        },
      });
    }
    return data({ ok: true });
  }

  if (actionType === "switch-to-manual") {
    // Same one-click switch the Collections list offers, so a merchant who
    // landed here from a link isn't sent back out to Shopify admin. Covered
    // by the write_products scope the app already has — no new permission.
    const result = await setCollectionManualSort(admin, config.collectionGid);
    if (!result.ok) {
      return data({ ok: false, error: result.error ?? "Couldn't switch that collection." }, { status: 400 });
    }
    await db.collectionConfig.update({
      where: { id: config.id },
      // The sort is Manual again, so whatever health problem was recorded
      // against this collection is resolved — clear it here rather than
      // waiting for the next successful run to do it (matches the identical
      // action in app.collections.tsx).
      data: { status: "RUNNING", previousSortOrder: result.previousSortOrder, sortOrderIssueAt: null },
    });
    if (formData.get("keepOrder") === "false") {
      await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL", undefined, settings.pageSize);
    }
    return data({ ok: true });
  }

  if (actionType === "shuffle-now") {
    const result = await runShuffleForCollection(admin, shop, config, settings.timezone, settings.neverMoveTags, "MANUAL", undefined, settings.pageSize);
    return data(result);
  }

  if (actionType === "undo") {
    const result = await undoRun(admin, shop, config);
    return data(result);
  }

  if (actionType === "toggle-status") {
    const nextStatus = config.status === "RUNNING" ? "PAUSED" : "RUNNING";
    const nextRunAt =
      nextStatus === "RUNNING"
        ? nextRunFor(new Date(), settings.timezone, resolveSchedule(config, settings))
        : null;
    await db.$transaction([
      db.collectionConfig.update({ where: { id: config.id }, data: { status: nextStatus, nextRunAt } }),
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

  if (actionType === "remove") {
    // The merchant chose in the dialog; restore is the default there, but the
    // choice is always explicit — never silent either way.
    const restore = formData.get("restore") !== "false";
    let restored: { restoredSort: string | null; restoredOrder: boolean; error?: string } = {
      restoredSort: null,
      restoredOrder: false,
    };
    if (restore) restored = await restoreOnRemove(admin, config);

    await db.shuffleRun.create({
      data: {
        shop,
        collectionId: config.id,
        // Denormalized: collectionId is about to go null when the delete
        // below cascades (SetNull), and this row is the one place that
        // summary has to survive it.
        collectionTitle: config.title,
        trigger: "SORT_RESTORED",
        status: restored.error ? "FAILED" : "OK",
        message: restored.error
          ? `Removed, but couldn't restore: ${restored.error}`
          : restored.restoredSort
            ? `Removed — sort put back to ${sortOrderLabel(restored.restoredSort)}`
            : restored.restoredOrder
              ? "Removed — original product order put back"
              : "Removed — order left exactly as it is",
      },
    });

    await db.collectionConfig.delete({ where: { id: config.id } });
    return redirect("/app/collections");
  }

  return data({ ok: false }, { status: 400 });
};

export default function Workspace() {
  const {
    config,
    sortOrder,
    sortOrderLabel: currentSortLabel,
    productCount,
    preview,
    runs,
    nextRunLabel,
    timezoneName,
    restorable,
    canPin,
    undoRetentionDays,
    planId,
    scheduleSlots,
    shopDefault,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const isLoading = navigation.state === "loading" && navigation.location?.pathname === `/app/collections/${config.id}`;
  const shopify = useAppBridge();
  const toggleFetcher = useFetcher();
  const removeFetcher = useFetcher();
  const rulesFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const switchFetcher = useFetcher<{ ok: boolean; error?: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay are imperative methods not on the typed public props
  const switchModalRef = useRef<any>(null);
  const [switchTarget, setSwitchTarget] = useState<SwitchToManualTarget | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay are imperative methods not on the typed public props
  const removeModalRef = useRef<any>(null);
  useModalDismissWorkaround(removeModalRef);

  const lastOkRun = runs.find((r) => r.status === "OK" && r.previousOrder);

  // ---- Rules form: controlled state + contextual save bar ----
  const [pins, setPins] = useState(config.pins);
  const [pushSoldOutToEnd, setPushSoldOutToEnd] = useState(config.pushSoldOutToEnd);
  const [boostNewArrivals, setBoostNewArrivals] = useState(config.boostNewArrivals);
  const [giveEveryoneATurn, setGiveEveryoneATurn] = useState(config.giveEveryoneATurn);
  const [rulesDirty, setRulesDirty] = useState(false);

  // The schedule is no longer part of the rules form: it opens the same
  // modal the Collections table and the Settings page use, and saves through
  // its own action. That is the whole point of the rebuild — this page used
  // to be the one place with a different schedule UI.
  const scheduleFetcher = useFetcher<{ ok: boolean; error?: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay are imperative methods not on the typed public props
  const scheduleModalRef = useRef<any>(null);
  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget | null>(null);

  // The effective schedule, in the words the Collections table uses for the
  // same collection — one summary function, so the two screens can't
  // describe one schedule differently.
  const scheduleLine = useMemo(
    () =>
      scheduleSummary(
        config.scheduleType,
        config.scheduleTime,
        config.scheduleTime2,
        config.scheduleWeekday,
      ),
    [config.scheduleType, config.scheduleTime, config.scheduleTime2, config.scheduleWeekday],
  );

  function markRulesDirty() {
    if (!rulesDirty) {
      setRulesDirty(true);
      shopify.saveBar.show(RULES_SAVE_BAR_ID);
    }
  }

  // Same reasoning as Settings' identical effect: leaving this page while
  // dirty must not leave Admin's save-bar state stuck on with no bar left to
  // resolve it.
  useEffect(() => {
    return () => {
      shopify.saveBar.hide(RULES_SAVE_BAR_ID);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only ever needs to run its cleanup, on unmount
  }, []);

  function discardRules() {
    setPins(config.pins);
    setPushSoldOutToEnd(config.pushSoldOutToEnd);
    setBoostNewArrivals(config.boostNewArrivals);
    setGiveEveryoneATurn(config.giveEveryoneATurn);
    setRulesDirty(false);
    shopify.saveBar.hide(RULES_SAVE_BAR_ID);
  }

  function openSwitchModal() {
    setSwitchTarget({
      mode: "tracked",
      id: config.id,
      gid: config.collectionGid,
      title: config.title,
      sortOrderLabel: currentSortLabel,
    });
    switchModalRef.current?.showOverlay();
  }

  function confirmSwitch(keepOrder: boolean) {
    switchFetcher.submit(
      { _action: "switch-to-manual", keepOrder: String(keepOrder) },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (switchFetcher.state !== "idle" || !switchFetcher.data) return;
    closeModal(switchModalRef.current);
    setSwitchTarget(null);
    if (switchFetcher.data.ok) {
      shopify.toast.show(`${config.title} switched to Manual sort`);
    } else {
      shopify.toast.show(switchFetcher.data.error ?? "Couldn't switch that collection", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [switchFetcher.state, switchFetcher.data]);

  function openScheduleModal() {
    setScheduleTarget({
      mode: "collection",
      id: config.id,
      title: config.title,
      productCount,
      // Already resolved by the loader, so a collection that inherits opens
      // showing the default it inherits rather than an empty form.
      schedule: {
        scheduleType: config.scheduleType as ScheduleType,
        scheduleTime: config.scheduleTime,
        scheduleTime2: config.scheduleTime2,
        scheduleWeekday: config.scheduleWeekday,
      },
      isCustom: config.scheduleIsOverridden,
    });
    scheduleModalRef.current?.showOverlay();
  }

  function confirmSchedule(schedule: SlotSchedule | null) {
    closeModal(scheduleModalRef.current);
    setScheduleTarget(null);
    scheduleFetcher.submit(
      schedule == null
        ? { _action: "set-schedule", scheduleMode: "default" }
        : {
            _action: "set-schedule",
            scheduleMode: "custom",
            scheduleType: schedule.scheduleType,
            scheduleTime: schedule.scheduleTime,
            scheduleTime2: schedule.scheduleTime2 ?? "",
            scheduleWeekday: schedule.scheduleWeekday == null ? "" : String(schedule.scheduleWeekday),
          },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (scheduleFetcher.state !== "idle" || !scheduleFetcher.data) return;
    if (scheduleFetcher.data.ok) {
      shopify.toast.show("Schedule updated");
    } else {
      shopify.toast.show(scheduleFetcher.data.error ?? "Couldn't save that schedule", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [scheduleFetcher.state, scheduleFetcher.data]);

  function saveRules() {
    rulesFetcher.submit(
      {
        _action: "save-settings",
        pins: String(pins),
        pushSoldOutToEnd: pushSoldOutToEnd ? "on" : "",
        boostNewArrivals: boostNewArrivals ? "on" : "",
        giveEveryoneATurn: giveEveryoneATurn ? "on" : "",
      },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (rulesFetcher.state !== "idle" || !rulesFetcher.data) return;
    if (rulesFetcher.data.ok) {
      setRulesDirty(false);
      shopify.saveBar.hide(RULES_SAVE_BAR_ID);
      shopify.toast.show("Rules saved");
    } else {
      // Leave the save bar up: the merchant's edit is still unsaved, so
      // hiding it would imply otherwise.
      shopify.toast.show(rulesFetcher.data.error ?? "Couldn't save those rules", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [rulesFetcher.state, rulesFetcher.data]);

  return (
    <s-page heading={config.title}>
      <s-button
        slot="secondary-actions"
        onClick={() => toggleFetcher.submit({ _action: "toggle-status" }, { method: "post" })}
        {...(toggleFetcher.state !== "idle" ? { loading: true } : {})}
      >
        {config.status === "RUNNING" ? "Pause" : "Resume"}
      </s-button>
      <s-button slot="secondary-actions" tone="critical" onClick={() => removeModalRef.current?.showOverlay()}>
        Remove
      </s-button>

      <s-link href="/app/collections">← Collections</s-link>
      <s-paragraph>
        <s-badge tone={config.status === "RUNNING" ? "success" : "neutral"}>
          {config.status === "RUNNING" ? "Running" : "Paused"}
        </s-badge>{" "}
        {productCount} products · next run {config.status === "RUNNING" ? nextRunLabel : "paused"}
      </s-paragraph>

      {sortOrder !== "MANUAL" && (
        <s-banner tone="warning" heading={`This collection is sorted by ${currentSortLabel}`}>
          <s-stack direction="block" gap="small">
            <s-paragraph>
              Shopify only lets an app set product positions on a manually-sorted collection. Shuffly can switch
              it for you — you don&apos;t need to go to Shopify admin.
            </s-paragraph>
            <s-button
              variant="primary"
              onClick={openSwitchModal}
              {...(switchFetcher.state !== "idle" ? { loading: true } : {})}
            >
              Switch to Manual sort
            </s-button>
          </s-stack>
        </s-banner>
      )}

      <s-section heading="Rules" slot="aside">
        <ui-save-bar id={RULES_SAVE_BAR_ID}>
          <button variant="primary" onClick={saveRules} disabled={rulesFetcher.state !== "idle" || undefined}>
            Save
          </button>
          <button onClick={discardRules}>Discard</button>
        </ui-save-bar>

        <s-stack direction="block" gap="base">
          {canPin ? (
            <s-number-field
              label="Pin the first"
              value={String(pins)}
              min={0}
              max={20}
              details="These never move."
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
              onInput={(e: any) => {
                setPins(Math.max(0, Math.min(20, Number(e.currentTarget?.value ?? 0))));
                markRulesDirty();
              }}
            />
          ) : (
            <s-paragraph>
              Pinning is available on Starter and Pro. <s-link href="/app/plan">See plans</s-link>
            </s-paragraph>
          )}
          <s-switch
            label="Sold-out to the end"
            checked={pushSoldOutToEnd || undefined}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
            onChange={(e: any) => {
              setPushSoldOutToEnd(Boolean(e.currentTarget?.checked));
              markRulesDirty();
            }}
          />
          <s-switch
            label="Boost new arrivals"
            checked={boostNewArrivals || undefined}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
            onChange={(e: any) => {
              setBoostNewArrivals(Boolean(e.currentTarget?.checked));
              markRulesDirty();
            }}
          />
          <s-switch
            label="Give everything a turn"
            checked={giveEveryoneATurn || undefined}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
            onChange={(e: any) => {
              setGiveEveryoneATurn(Boolean(e.currentTarget?.checked));
              markRulesDirty();
            }}
          />
          {/* The schedule, as a row that opens the shared modal — not as
              four dropdowns inline. Saving it is a separate action from the
              rules save bar, because a schedule write is four columns that
              have to move together (or be nulled together, to go back to
              following the shop default). */}
          <div className="shuffly-wsched-row">
            <div className="shuffly-wsched-label">
              <div className="shuffly-wsched-labelline">
                <s-text type="strong">Shuffle schedule</s-text>
                {config.scheduleIsOverridden ? (
                  <s-badge tone="info">Custom</s-badge>
                ) : (
                  <s-badge tone="neutral">Shop default</s-badge>
                )}
              </div>
              <s-text color="subdued">
                {config.status === "RUNNING" ? `${scheduleLine} · next run ${nextRunLabel}` : scheduleLine}
              </s-text>
            </div>
            <s-button
              onClick={openScheduleModal}
              {...(scheduleFetcher.state !== "idle" ? { loading: true } : {})}
            >
              Edit
            </s-button>
          </div>
          <style>{`
            .shuffly-wsched-row {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: var(--p-space-400, 16px);
              padding: var(--p-space-300, 12px) var(--p-space-400, 16px);
              border: 1px solid var(--p-color-border, #e3e3e3);
              border-radius: var(--p-border-radius-300, 12px);
            }
            .shuffly-wsched-label { min-width: 0; }
            .shuffly-wsched-labelline {
              display: flex;
              align-items: center;
              gap: var(--p-space-200, 8px);
              flex-wrap: wrap;
              margin-bottom: var(--p-space-050, 2px);
            }
            @media (max-width: 480px) {
              .shuffly-wsched-row { flex-direction: column; align-items: stretch; }
            }
          `}</style>
        </s-stack>
      </s-section>

      <s-section heading="Order">
        <s-paragraph>
          Showing the first {preview.length} of {productCount} products
        </s-paragraph>
        <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
          {isLoading
            ? // Same s-box/s-stack shape as the real tiles below (three lines:
              // badge, heading, text), just with placeholder content — so the
              // grid's own dimensions don't shift when real data lands.
              Array.from({ length: preview.length || 16 }, (_, i) => (
                <s-box key={i} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-stack direction="block" gap="small">
                    <s-badge tone="neutral">&nbsp;</s-badge>
                    <s-heading>&nbsp;</s-heading>
                    <s-text>&nbsp;</s-text>
                  </s-stack>
                </s-box>
              ))
            : preview.map((p, idx) => (
                <s-box key={p.id} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-stack direction="block" gap="small">
                    <s-badge tone={p.pinned ? "info" : p.soldOut ? "neutral" : p.isNew ? "success" : undefined}>
                      {p.pinned ? "Pinned" : p.soldOut ? "Sold out" : p.isNew ? "New" : p.neverMove ? "Never moves" : `#${idx + 1}`}
                    </s-badge>
                    <s-heading>{p.initial}</s-heading>
                    <s-text>{p.title}</s-text>
                  </s-stack>
                </s-box>
              ))}
        </s-grid>

        <s-stack direction="inline" gap="base" alignItems="center">
          <Form method="post">
            <input type="hidden" name="_action" value="shuffle-now" />
            <s-button
              type="submit"
              variant="primary"
              {...(busy ? { loading: true } : {})}
              disabled={sortOrder !== "MANUAL" || undefined}
            >
              Shuffle now
            </s-button>
          </Form>
          {lastOkRun && (
            <Form method="post">
              <input type="hidden" name="_action" value="undo" />
              <s-button type="submit" variant="secondary">
                Undo last shuffle
              </s-button>
            </Form>
          )}
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            This is exactly what happens on schedule, on all {productCount} products — you don&apos;t need to open
            the app.
          </s-paragraph>
          <s-paragraph>
            {/* collectionReorderProducts is asynchronous and the storefront
                is cached, so the new order is instant in admin and lags on
                the live store. */}
            <ReorderDelayNote />
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="History">
        {runs.length === 0 ? (
          <s-paragraph>No runs yet.</s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Trigger</s-table-header>
              <s-table-header>Result</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {runs.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>{r.whenLabel}</s-table-cell>
                  <s-table-cell>{triggerLabel(r.trigger)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.status === "OK" ? "success" : "critical"}>{r.message ?? r.status}</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-paragraph>
          Activity remains logged. Order snapshots can be restored for {undoRetentionDays} day
          {undoRetentionDays === 1 ? "" : "s"} on your plan.
        </s-paragraph>
      </s-section>

      <ShuffleScheduleModal
        ref={scheduleModalRef}
        target={scheduleTarget}
        shopDefault={shopDefault as SlotSchedule}
        timezone={timezoneName}
        slots={scheduleSlots}
        planId={planId}
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
        onCancel={() => {
          closeModal(switchModalRef.current);
          setSwitchTarget(null);
        }}
      />

      <RemoveCollectionModal
        ref={removeModalRef}
        title={config.title}
        restorable={restorable}
        busy={removeFetcher.state !== "idle"}
        onConfirm={(restore) =>
          removeFetcher.submit({ _action: "remove", restore: String(restore) }, { method: "post" })
        }
        onCancel={() => closeModal(removeModalRef.current)}
      />

    </s-page>
  );
}

function triggerLabel(trigger: string) {
  switch (trigger) {
    case "SCHEDULED":
      return "Scheduled";
    case "MANUAL":
      return "Manual";
    case "SOLD_OUT_REACTION":
      return "Sold-out reaction";
    case "RESTOCK_REACTION":
      return "Restock reaction";
    default:
      return trigger;
  }
}

/** The same sentence the Collections list's Schedule column composes, reused
 * for the Activity record so the two never describe one schedule differently. */
function scheduleSummary(
  scheduleType: string,
  scheduleTime: string,
  scheduleTime2: string | null,
  scheduleWeekday: number | null,
): string {
  const time = normalizeHhMm(scheduleTime);
  switch (scheduleType) {
    case "DAILY":
      return `daily at ${time}`;
    case "TWICE_DAILY":
      return `twice daily at ${[time, scheduleTime2 ? normalizeHhMm(scheduleTime2) : null].filter(Boolean).sort().join(" and ")}`;
    case "WEEKLY":
      return `weekly, ${WEEKDAYS[scheduleWeekday ?? 1]} at ${time}`;
    default:
      return "manual only";
  }
}
