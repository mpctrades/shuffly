import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigation, useFetcher, Form, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { getCollectionPreviewAndCount, setCollectionManualSort, sortOrderLabel } from "../lib/collections.server";
import { runShuffleForCollection, undoRun } from "../lib/shuffle-engine.server";
import {
  formatActivityTimestamp,
  formatNextRun,
  nextRunFor,
  normalizeHhMm,
  scheduleWriteFields,
  slotsFarEnoughApart,
  timezoneOffsetLabel,
  type ScheduleType,
} from "../lib/schedule-core";
// Client-safe (see time-slots.ts) — the component below renders these.
import { defaultSecondSlot, timeOptionsIncluding } from "../lib/time-slots";
import { SwitchToManualModal, type SwitchToManualTarget } from "../components/SwitchToManualModal";
import { ReorderDelayNote } from "../components/ManualSortWarning";
import { closeModal, useModalDismissWorkaround } from "../lib/polaris-modal";
import { planOf, pruneExpiredUndoSnapshots, timeSlots } from "../lib/plans.server";

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
    config,
    sortOrder,
    sortOrderLabel: sortOrderLabel(sortOrder),
    productCount: totalCount,
    preview,
    runs,
    timezone: settings.timezone,
    timezoneLabel: `${settings.timezone} (${timezoneOffsetLabel(settings.timezone)})`,
    timezoneName: settings.timezone,
    nextRunLabel: formatNextRun(config.nextRunAt, settings.timezone),
    allowedSchedules: plan.allowedSchedules,
    // Same helper the plan bar composes "N time slots" from — so the picker
    // that offers the slot and the copy that advertises it cannot disagree.
    canPickSecondSlot: timeSlots(plan.id) >= 2,
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
    const scheduleType = String(formData.get("scheduleType") ?? "DAILY") as ScheduleType;
    if (!plan.allowedSchedules.includes(scheduleType)) {
      return data({ ok: false, error: "That schedule isn't available on your plan." }, { status: 400 });
    }
    const scheduleTime = String(formData.get("scheduleTime") ?? "06:00");
    const scheduleWeekdayRaw = formData.get("scheduleWeekday");
    const scheduleWeekday = scheduleWeekdayRaw != null && scheduleWeekdayRaw !== "" ? Number(scheduleWeekdayRaw) : null;

    // The second slot only exists on a plan that allows TWICE_DAILY, and the
    // schedule-type guard above already rejects that type for other plans —
    // so a submitted second time can't slip past by itself.
    const scheduleTime2Raw = formData.get("scheduleTime2");
    const scheduleTime2 =
      scheduleType === SECOND_SLOT_SCHEDULE && scheduleTime2Raw != null && scheduleTime2Raw !== ""
        ? String(scheduleTime2Raw)
        : null;
    if (scheduleTime2 != null && !slotsFarEnoughApart(scheduleTime, scheduleTime2)) {
      return data(
        { ok: false, error: "Keep the two shuffle times at least an hour apart." },
        { status: 400 },
      );
    }

    const scheduleChanged =
      scheduleType !== config.scheduleType ||
      normalizeHhMm(scheduleTime) !== config.scheduleTime ||
      (scheduleTime2 == null ? null : normalizeHhMm(scheduleTime2)) !== config.scheduleTime2 ||
      scheduleWeekday !== config.scheduleWeekday;

    await db.collectionConfig.update({
      where: { id: config.id },
      data: {
        pins,
        pushSoldOutToEnd,
        boostNewArrivals,
        giveEveryoneATurn,
        // Stamped only when a schedule field actually moved. The sweep uses
        // it to tell "the worker was down, run this late" apart from "the
        // merchant just moved this slot into the past, don't back-fire".
        ...(scheduleChanged ? { scheduleUpdatedAt: new Date() } : {}),
        // One helper derives every schedule field *and* nextRunAt together,
        // so the stored countdown can never disagree with the stored time —
        // and the cron sweep re-reads the time each pass anyway, so this
        // save takes effect on the very next sweep with nothing left queued
        // at the old time.
        ...scheduleWriteFields(
          new Date(),
          settings.timezone,
          { scheduleType, scheduleTime, scheduleTime2, scheduleWeekday },
          config.status === "RUNNING" ? "RUNNING" : "PAUSED",
        ),
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
          message: `Schedule changed to ${scheduleSummary(scheduleType, scheduleTime, scheduleTime2, scheduleWeekday)}`,
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
      data: { status: "RUNNING", previousSortOrder: result.previousSortOrder },
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
        ? nextRunFor(new Date(), settings.timezone, {
            scheduleType: config.scheduleType as ScheduleType,
            scheduleTime: config.scheduleTime,
            scheduleTime2: config.scheduleTime2,
            scheduleWeekday: config.scheduleWeekday,
          })
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
    timezoneLabel,
    timezoneName,
    allowedSchedules,
    canPickSecondSlot,
    canPin,
    undoRetentionDays,
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
  const [scheduleType, setScheduleType] = useState(config.scheduleType);
  const [scheduleTime, setScheduleTime] = useState(config.scheduleTime);
  // Pre-filled with a sensible second slot (12h apart, which is what
  // twice-daily used to derive) so a Pro merchant switching to twice-daily
  // isn't handed an empty field.
  const [scheduleTime2, setScheduleTime2] = useState(
    config.scheduleTime2 ?? defaultSecondSlot(config.scheduleTime),
  );
  const [scheduleWeekday, setScheduleWeekday] = useState(config.scheduleWeekday ?? 1);
  const [rulesDirty, setRulesDirty] = useState(false);

  // Recomputed in the browser from the controlled state, not read back from
  // the loader — the whole point is that the merchant sees what their choice
  // means *before* they save it. Same nextRunFor the sweep and the loader
  // use, so the preview can't disagree with what actually happens.
  const previewNextRunLabel = useMemo(() => {
    if (config.status !== "RUNNING") return "—";
    const next = nextRunFor(new Date(), timezoneName, {
      scheduleType: scheduleType as ScheduleType,
      scheduleTime,
      scheduleTime2: scheduleType === SECOND_SLOT_SCHEDULE && canPickSecondSlot ? scheduleTime2 : null,
      scheduleWeekday: scheduleType === "WEEKLY" ? scheduleWeekday : null,
    });
    return formatNextRun(next, timezoneName);
  }, [config.status, timezoneName, scheduleType, scheduleTime, scheduleTime2, scheduleWeekday, canPickSecondSlot]);

  const showSecondSlot = scheduleType === SECOND_SLOT_SCHEDULE || canPickSecondSlot;
  const secondSlotLocked = !canPickSecondSlot;
  const firstSlotOptions = timeOptionsIncluding(config.scheduleTime, scheduleTime);
  const secondSlotOptions = timeOptionsIncluding(config.scheduleTime2, scheduleTime2);
  const slotsClash =
    scheduleType === SECOND_SLOT_SCHEDULE &&
    canPickSecondSlot &&
    !slotsFarEnoughApart(scheduleTime, scheduleTime2);

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
    setScheduleType(config.scheduleType);
    setScheduleTime(config.scheduleTime);
    setScheduleTime2(config.scheduleTime2 ?? defaultSecondSlot(config.scheduleTime));
    setScheduleWeekday(config.scheduleWeekday ?? 1);
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

  function saveRules() {
    rulesFetcher.submit(
      {
        _action: "save-settings",
        pins: String(pins),
        pushSoldOutToEnd: pushSoldOutToEnd ? "on" : "",
        boostNewArrivals: boostNewArrivals ? "on" : "",
        giveEveryoneATurn: giveEveryoneATurn ? "on" : "",
        scheduleType,
        scheduleTime,
        // Only sent when the plan actually has the entitlement — the action
        // ignores it otherwise, but there's no reason to send it.
        scheduleTime2: scheduleType === SECOND_SLOT_SCHEDULE && canPickSecondSlot ? scheduleTime2 : "",
        scheduleWeekday: String(scheduleWeekday),
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
          <button
            variant="primary"
            onClick={saveRules}
            disabled={rulesFetcher.state !== "idle" || slotsClash || undefined}
          >
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
          <s-select
            label="Schedule"
            value={scheduleType}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
            onChange={(e: any) => {
              setScheduleType(e.currentTarget?.value ?? "DAILY");
              markRulesDirty();
            }}
          >
            {allowedSchedules.includes("DAILY") && <s-option value="DAILY">Daily</s-option>}
            {allowedSchedules.includes("TWICE_DAILY") && <s-option value="TWICE_DAILY">Twice daily</s-option>}
            {allowedSchedules.includes("WEEKLY") && <s-option value="WEEKLY">Weekly</s-option>}
            {allowedSchedules.includes("MANUAL") && <s-option value="MANUAL">Only when I press Shuffle</s-option>}
          </s-select>
          {scheduleType !== "MANUAL" && (
            <>
              <s-select
                label={scheduleType === SECOND_SLOT_SCHEDULE ? "First shuffle at" : "Shuffle at"}
                value={scheduleTime}
                details={`${timezoneLabel} — your store's own time`}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                onChange={(e: any) => {
                  setScheduleTime(e.currentTarget?.value ?? "06:00");
                  markRulesDirty();
                }}
              >
                {firstSlotOptions.map((t) => (
                  <s-option key={t} value={t}>
                    {t}
                  </s-option>
                ))}
              </s-select>

              {showSecondSlot && (
                <>
                  <s-select
                    label="Second shuffle at"
                    value={scheduleTime2}
                    disabled={secondSlotLocked || scheduleType !== SECOND_SLOT_SCHEDULE || undefined}
                    details={
                      secondSlotLocked
                        ? "Two shuffles a day is a Pro feature."
                        : scheduleType === SECOND_SLOT_SCHEDULE
                          ? undefined
                          : "Set the schedule to Twice daily to use this."
                    }
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                    onChange={(e: any) => {
                      setScheduleTime2(e.currentTarget?.value ?? "18:00");
                      markRulesDirty();
                    }}
                  >
                    {secondSlotOptions.map((t) => (
                      <s-option key={t} value={t}>
                        {t}
                      </s-option>
                    ))}
                  </s-select>
                  {secondSlotLocked && (
                    <s-paragraph>
                      <s-text color="subdued">Shuffle twice a day on Pro. </s-text>
                      <s-link href="/app/plan">Upgrade to Pro</s-link>
                    </s-paragraph>
                  )}
                  {slotsClash && !secondSlotLocked && (
                    <s-paragraph>
                      <s-text tone="critical">Keep the two shuffle times at least an hour apart.</s-text>
                    </s-paragraph>
                  )}
                </>
              )}
            </>
          )}
          <s-select
            label="Weekday (for weekly)"
            disabled={scheduleType !== "WEEKLY" || undefined}
            value={String(scheduleWeekday)}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
            onChange={(e: any) => {
              setScheduleWeekday(Number(e.currentTarget?.value ?? 1));
              markRulesDirty();
            }}
          >
            {WEEKDAYS.map((w, i) => (
              <s-option key={w} value={String(i)}>
                {w}
              </s-option>
            ))}
          </s-select>
          <s-paragraph>
            Next run <s-text type="strong">{previewNextRunLabel}</s-text>
            {rulesDirty && previewNextRunLabel !== nextRunLabel && (
              <>
                {" "}
                <s-text color="subdued">(once you save)</s-text>
              </>
            )}
          </s-paragraph>
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

      <s-modal ref={removeModalRef} heading={`Remove ${config.title} from Shuffly?`}>
        <s-paragraph>
          Shuffly will stop shuffling this collection. The order it currently has stays exactly as it is — nothing
          reverts.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={() => removeFetcher.submit({ _action: "remove" }, { method: "post" })}
          {...(removeFetcher.state !== "idle" ? { loading: true } : {})}
        >
          Remove
        </s-button>
        <s-button slot="secondary-actions" onClick={() => closeModal(removeModalRef.current)}>
          Cancel
        </s-button>
      </s-modal>
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
