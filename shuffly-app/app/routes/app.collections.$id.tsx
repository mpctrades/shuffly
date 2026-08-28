import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigation, useFetcher, Form, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { getCollectionPreviewAndCount } from "../lib/collections.server";
import { runShuffleForCollection, undoRun } from "../lib/shuffle-engine.server";
import { computeNextRun, formatActivityTimestamp, formatNextRun, type ScheduleType } from "../lib/schedule.server";
import { closeModal, useModalDismissWorkaround } from "../lib/polaris-modal";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const RULES_SAVE_BAR_ID = "collection-rules-save-bar";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const config = await db.collectionConfig.findFirst({ where: { id: params.id, shop } });
  if (!config) throw new Response("Not found", { status: 404 });

  const settings = await getOrCreateShopSettings(admin, shop);
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
    productCount: totalCount,
    preview,
    runs,
    timezone: settings.timezone,
    nextRunLabel: formatNextRun(config.nextRunAt, settings.timezone),
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

  if (actionType === "save-settings") {
    const pins = Math.max(0, Math.min(20, Number(formData.get("pins") ?? 0)));
    const pushSoldOutToEnd = formData.get("pushSoldOutToEnd") === "on";
    const boostNewArrivals = formData.get("boostNewArrivals") === "on";
    const giveEveryoneATurn = formData.get("giveEveryoneATurn") === "on";
    const scheduleType = String(formData.get("scheduleType") ?? "DAILY") as ScheduleType;
    const scheduleTime = String(formData.get("scheduleTime") ?? "06:00");
    const scheduleWeekdayRaw = formData.get("scheduleWeekday");
    const scheduleWeekday = scheduleWeekdayRaw != null && scheduleWeekdayRaw !== "" ? Number(scheduleWeekdayRaw) : null;

    const nextRunAt =
      config.status === "RUNNING"
        ? computeNextRun(new Date(), settings.timezone, scheduleType, scheduleTime, scheduleWeekday)
        : null;

    await db.collectionConfig.update({
      where: { id: config.id },
      data: { pins, pushSoldOutToEnd, boostNewArrivals, giveEveryoneATurn, scheduleType, scheduleTime, scheduleWeekday, nextRunAt },
    });
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
        ? computeNextRun(new Date(), settings.timezone, config.scheduleType as ScheduleType, config.scheduleTime, config.scheduleWeekday)
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
  const { config, sortOrder, productCount, preview, runs, nextRunLabel } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const isLoading = navigation.state === "loading" && navigation.location?.pathname === `/app/collections/${config.id}`;
  const shopify = useAppBridge();
  const toggleFetcher = useFetcher();
  const removeFetcher = useFetcher();
  const rulesFetcher = useFetcher<{ ok: boolean }>();
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
  const [scheduleWeekday, setScheduleWeekday] = useState(config.scheduleWeekday ?? 1);
  const [rulesDirty, setRulesDirty] = useState(false);

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
    setScheduleWeekday(config.scheduleWeekday ?? 1);
    setRulesDirty(false);
    shopify.saveBar.hide(RULES_SAVE_BAR_ID);
  }

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
        scheduleWeekday: String(scheduleWeekday),
      },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (rulesFetcher.state === "idle" && rulesFetcher.data?.ok) {
      setRulesDirty(false);
      shopify.saveBar.hide(RULES_SAVE_BAR_ID);
      shopify.toast.show("Rules saved");
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
        <s-banner tone="warning" heading="This collection isn't sorted manually">
          <s-paragraph>
            Shopify only lets an app set product positions when a collection uses manual sort. Go to Collections and
            use &quot;Switch to manual sort&quot; before shuffling this one.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Rules" slot="aside">
        <ui-save-bar id={RULES_SAVE_BAR_ID}>
          <button
            variant="primary"
            onClick={saveRules}
            disabled={rulesFetcher.state !== "idle" || undefined}
          >
            Save
          </button>
          <button onClick={discardRules}>Discard</button>
        </ui-save-bar>

        <s-stack direction="block" gap="base">
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
            <s-option value="DAILY">Daily</s-option>
            <s-option value="TWICE_DAILY">Twice daily</s-option>
            <s-option value="WEEKLY">Weekly</s-option>
            <s-option value="MANUAL">Only when I press Shuffle</s-option>
          </s-select>
          <s-text-field
            label="Time (24h, HH:MM)"
            value={scheduleTime}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
            onInput={(e: any) => {
              setScheduleTime(e.currentTarget?.value ?? "");
              markRulesDirty();
            }}
          />
          <s-select
            label="Weekday (for weekly)"
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
            Next run <s-text type="strong">{config.status === "RUNNING" ? nextRunLabel : "—"}</s-text>
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

        <s-paragraph>
          This is exactly what happens on schedule, on all {productCount} products — you don&apos;t need to open the
          app.
        </s-paragraph>
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
        <s-paragraph>Every run is saved so an earlier order can be put back with Undo.</s-paragraph>
      </s-section>

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
