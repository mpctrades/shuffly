import { closeModal } from "../lib/polaris-modal";
import { StatChip, StatTile, StatTileRow, type StatTone } from "../components/StatTiles";
import { ScheduleModal, type ScheduleTarget } from "../components/ScheduleModal";
import { shopDefaultSchedule } from "../lib/schedule-resolve";
import { formatNextRun, nextRunFor, slotsFarEnoughApart, type ScheduleType, type SlotSchedule } from "../lib/schedule.server";
import { timeSlots } from "../lib/plans.server";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigation, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { getShopTimezone } from "../lib/collections.server";
import { timezoneOffsetLabel } from "../lib/schedule.server";
// Client-safe (see time-slots.ts) — the component below renders these.
import { normalizeHhMm } from "../lib/time-slots";
import { SUPPORT_EMAIL, SUPPORT_MAILTO, WEBSITE_URL } from "../lib/app-config";
// The save path lives in a lib so it can be tested without a browser — see
// settings-form.ts for why.
import {
  addTag as addTagTo,
  parseTags,
  removeTag as removeTagFrom,
  settingsSubmission,
} from "../lib/settings-form";

const SAVE_BAR_ID = "settings-save-bar";

/* No accent colour anywhere on this page. The section headings carry the
   hierarchy, and the only colour left is Polaris's own — link blue and the
   primary button — where it tells the merchant something. */


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getOrCreateShopSettings(admin, shop);

  // The shop's timezone is Shopify's own setting, not ours — re-confirm it
  // live on every load (and self-heal our cache) rather than trusting a
  // value that could have gone stale since install.
  let timezone = settings.timezone;
  let error: string | null = null;
  try {
    const live = await getShopTimezone(admin);
    if (live && live !== settings.timezone) {
      await db.shopSettings.update({
        where: { shop },
        data: { timezone: live },
      });
    }
    if (live) timezone = live;
  } catch {
    error =
      "Couldn't confirm your shop's timezone from Shopify just now — showing the last known value.";
  }

  // The status row's numbers, from the same columns the Collections page
  // reads. One indexed query, no Admin API call, no new scope.
  const tracked = await db.collectionConfig.findMany({
    where: { shop },
    select: { status: true, nextRunAt: true, sortOrderIssueAt: true },
  });
  const runningCount = tracked.filter((t) => t.status === "RUNNING").length;
  const soonestNextRunMs = tracked
    .filter((t) => t.status === "RUNNING" && t.nextRunAt)
    .map((t) => t.nextRunAt!.getTime())
    .sort((a, b) => a - b)[0];
  // Collections a run has already found stuck off Manual sort. Persisted by
  // the engine, so this costs nothing here — it will not catch a sort changed
  // since the last run, which the Collections page's live check does.
  const needsManualSort = tracked.filter((t) => t.sortOrderIssueAt != null).length;

  return {
    settings: { ...settings, timezone },
    trackedCount: tracked.length,
    runningCount,
    nextRunAtMs: soonestNextRunMs ?? null,
    nextRunLabel: soonestNextRunMs ? formatNextRun(new Date(soonestNextRunMs), timezone) : null,
    needsManualSort,
    timezoneLabel: `${timezone} (${timezoneOffsetLabel(timezone)})`,
    // The shop-wide default schedule every collection follows unless it has
    // its own. Same shape the Collections page sends the modal.
    shopDefault: shopDefaultSchedule(settings),
    // Where a merchant actually changes the timezone: Shopify's own settings,
    // because Shopify owns the value (see the Timezone row). Built from the
    // shop domain rather than hard-coded so it is right for every store.
    shopifyTimezoneUrl: `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/settings/general`,
    scheduleSlots: timeSlots(settings.plan),
    error,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  await getOrCreateShopSettings(admin, shop);
  const formData = await request.formData();

  // The schedule modal posts here on its own, separately from the settings
  // form save. Nothing is copied onto collection rows — inheriting
  // collections read these values live — so the only follow-up is repairing
  // their advisory countdown.
  if (String(formData.get("_action") ?? "") === "set-shop-default") {
    const scheduleType = String(formData.get("scheduleType") ?? "WEEKLY") as ScheduleType;
    const scheduleTime = normalizeHhMm(String(formData.get("scheduleTime") ?? "06:00"));
    const rawTime2 = formData.get("scheduleTime2");
    const settings = await getOrCreateShopSettings(admin, shop);
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
    const updated = await db.shopSettings.update({
      where: { shop },
      data: {
        defaultScheduleType: scheduleType,
        defaultScheduleTime: scheduleTime,
        defaultScheduleTime2: scheduleTime2,
        defaultScheduleWeekday:
          scheduleType === "WEEKLY" && rawWeekday != null && rawWeekday !== "" ? Number(rawWeekday) : null,
      },
    });
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

  const neverMoveTags = String(formData.get("neverMoveTags") ?? "");
  const autoSwitchToManual = formData.get("autoSwitchToManual") === "on";

  await db.shopSettings.update({
    where: { shop },
    data: {
      neverMoveTags,
      autoSwitchToManual,
    },
  });

  return data({ ok: true });
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function Settings() {
  const {
    settings,
    timezoneLabel,
    shopDefault,
    scheduleSlots,
    shopifyTimezoneUrl,
    trackedCount,
    runningCount,
    nextRunAtMs,
    nextRunLabel,
    needsManualSort,
    error,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const fetcher = useFetcher<{ ok: boolean }>();
  const isLoading =
    navigation.state === "loading" &&
    navigation.location?.pathname === "/app/settings";
  const busy = fetcher.state !== "idle";

  // Same label the Collections table shows, from the same values, so the two
  // screens can't describe the shop default differently.
  const shopDefaultLabel = useMemo(() => {
    const day = shopDefault.scheduleWeekday != null ? WEEKDAY_NAMES[shopDefault.scheduleWeekday] : null;
    if (shopDefault.scheduleType === "WEEKLY" && day) return `Weekly, ${day} at ${shopDefault.scheduleTime}`;
    if (shopDefault.scheduleType === "TWICE_DAILY")
      return `Twice daily at ${shopDefault.scheduleTime} and ${shopDefault.scheduleTime2 ?? "—"}`;
    if (shopDefault.scheduleType === "DAILY") return `Daily at ${shopDefault.scheduleTime}`;
    return "Only when you press Shuffle";
  }, [shopDefault]);


  // Ticks client-side from the fixed instant, like the Collections
  // countdown — no polling, and it can't disagree with the stored time.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (nextRunAtMs == null) return;
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [nextRunAtMs]);
  const countdown = useMemo(() => {
    if (nextRunAtMs == null) return "Not scheduled";
    const mins = Math.max(0, Math.round((nextRunAtMs - nowMs) / 60_000));
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }, [nextRunAtMs, nowMs]);

  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay are imperative methods not on the typed public props
  const scheduleModalRef = useRef<any>(null);
  const scheduleFetcher = useFetcher<{ ok?: boolean; error?: string; moved?: number }>();

  useEffect(() => {
    if (scheduleFetcher.state !== "idle" || !scheduleFetcher.data) return;
    if (scheduleFetcher.data.ok) {
      const n = scheduleFetcher.data.moved ?? 0;
      shopify.toast.show(
        n > 0
          ? `Default schedule saved — ${n} collection${n === 1 ? "" : "s"} moved with it`
          : "Default schedule saved",
      );
    } else {
      shopify.toast.show(scheduleFetcher.data.error ?? "Couldn't save that schedule", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [scheduleFetcher.state, scheduleFetcher.data]);
  const [autoSwitchToManual, setAutoSwitchToManual] = useState(settings.autoSwitchToManual);
  const [tags, setTags] = useState<string[]>(() =>
    parseTags(settings.neverMoveTags),
  );
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [dirty, setDirty] = useState(false);

  function markDirty() {
    if (!dirty) {
      setDirty(true);
      shopify.saveBar.show(SAVE_BAR_ID);
    }
  }

  // Leaving this page (e.g. clicking another nav item) while dirty unmounts
  // the <ui-save-bar> element without ever calling .hide() on it — Admin's
  // own "a save bar is active" state is tracked separately from that DOM
  // node, so it never got told the bar is gone. That leaves Admin dimmed
  // and blocked everywhere outside this app's own iframe, on whatever page
  // you navigate to next, with no visible save bar left to resolve it.
  useEffect(() => {
    return () => {
      shopify.saveBar.hide(SAVE_BAR_ID);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only ever needs to run its cleanup, on unmount
  }, []);

  function handleDiscard() {
    setAutoSwitchToManual(settings.autoSwitchToManual);
    setTags(parseTags(settings.neverMoveTags));
    setAddingTag(false);
    setNewTag("");
    setDirty(false);
    shopify.saveBar.hide(SAVE_BAR_ID);
  }

  function handleSave() {
    // One builder, shared with the tests, so what CI verifies is byte-for-byte
    // what the save bar actually posts.
    fetcher.submit(settingsSubmission({ tags, autoSwitchToManual }), { method: "post" });
  }

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setDirty(false);
      shopify.saveBar.hide(SAVE_BAR_ID);
      shopify.toast.show("Settings saved");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [fetcher.state, fetcher.data]);

  function addTag() {
    setTags((prev) => {
      const next = addTagTo(prev, newTag);
      if (next !== prev) markDirty();
      return next;
    });
    setNewTag("");
    setAddingTag(false);
  }

  function removeTag(tag: string) {
    setTags((prev) => {
      const next = removeTagFrom(prev, tag);
      if (next.length !== prev.length) markDirty();
      return next;
    });
  }

  return (
    <s-page heading="Settings">
      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={handleSave}
          disabled={busy || undefined}
        >
          Save
        </button>
        <button onClick={handleDiscard}>Discard</button>
      </ui-save-bar>

      {error && <s-banner tone="warning">{error}</s-banner>}

      {isLoading ? (
        <SettingsSkeleton />
      ) : (
        <s-stack direction="block" gap="base">
          {/* Every tile is a real number read from the same columns the
              Collections bento reads, in the same treatment — the page needed
              an anchor, and an anchor made of live facts rather than
              ornament. */}
          <StatTileRow>
            <StatTile
              icon="collection"
              tone="info"
              label="Shuffling"
              value={`${runningCount} collection${runningCount === 1 ? "" : "s"}`}
              detail={trackedCount === runningCount ? "all tracked" : `of ${trackedCount} tracked`}
            />
            <StatTile
              icon="clock"
              tone="warning"
              label="Next run"
              value={countdown}
              detail={nextRunLabel ?? "No collection is scheduled"}
            />
            <StatTile
              icon="globe"
              tone="success"
              label="Timezone"
              value={settings.timezone}
              detail="From your Shopify settings"
            />
            <StatTile
              icon="pin"
              tone="info"
              label="Never move"
              value={`${tags.length} tag${tags.length === 1 ? "" : "s"}`}
              detail="In every collection"
            />
          </StatTileRow>

          {/* Annotated sections, the way Shopify's own settings pages are
              laid out: the section's name and what it is for on the left,
              its controls on the right, stacked down one column. The old
              two-column card grid gave every section the same weight and
              left a void wherever the shorter column ran out. */}
          <AnnotatedSection
            icon="clock"
            tone="warning"
            title="Schedule"
            description="When Shuffly reorders your collections."
          >
            {/* Read-only on purpose. Shopify owns this value: the
                shop/update webhook overwrites it whenever the merchant
                changes it in Shopify, and this page's loader re-reads it
                live on every visit. */}
            <SettingsRow
              label="Timezone"
              value={timezoneLabel}
              help="Read from your Shopify settings."
              action={
                <s-link href={shopifyTimezoneUrl} target="_blank">
                  Change in Shopify
                </s-link>
              }
            />
            <s-divider />
            <SettingsRow
              label="Default schedule"
              badge={nextRunAtMs != null ? <s-badge>{countdown}</s-badge> : undefined}
              value={shopDefaultLabel}
              help="Collections use this unless you set a different time on the collection itself."
              action={
                <s-button
                  onClick={() => {
                    setScheduleTarget({ mode: "shop-default", schedule: shopDefault as SlotSchedule });
                    scheduleModalRef.current?.showOverlay();
                  }}
                >
                  Change
                </s-button>
              }
            />
          </AnnotatedSection>

          <s-divider />

          <AnnotatedSection
            icon="pin"
            tone="info"
            title="Never move these"
            description="Products Shuffly leaves exactly where they are, in every collection."
          >
            {/* "+ Add tag" belongs at the end of the list it appends to, not
                pinned to the card's far corner away from the tags. */}
            <SettingsRow
              label="Products tagged"
              value={
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  {tags.map((tag) => (
                    <s-clickable-chip
                      key={tag}
                      removable
                      accessibilityLabel={`Remove ${tag}`}
                      onRemove={() => removeTag(tag)}
                    >
                      {tag}
                    </s-clickable-chip>
                  ))}
                  {!addingTag && (
                    <s-button onClick={() => setAddingTag(true)}>+ Add tag</s-button>
                  )}
                </s-stack>
              }
            />
            {addingTag && (
              <s-grid gridTemplateColumns="1fr auto auto" gap="small" alignItems="end">
                <s-text-field
                  label="New tag"
                  labelAccessibilityVisibility="exclusive"
                  value={newTag}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                  onInput={(e: any) => setNewTag(e.currentTarget?.value ?? "")}
                />
                <s-button variant="primary" onClick={addTag}>
                  Add
                </s-button>
                <s-button
                  onClick={() => {
                    setAddingTag(false);
                    setNewTag("");
                  }}
                >
                  Cancel
                </s-button>
              </s-grid>
            )}
          </AnnotatedSection>

          <s-divider />

          <AnnotatedSection
            icon="apps"
            tone="info"
            title="Adding collections"
            description="Shuffly can only set the order on a collection that uses Manual sort."
          >
            {/* The switch is both the value and the control, so it takes the
                action slot and the row keeps its shape. */}
            <SettingsRow
              label="Switch collections to Manual sort without asking"
              badge={
                autoSwitchToManual ? <s-badge tone="success">On</s-badge> : <s-badge>Off</s-badge>
              }
              help="With this on, an automated collection is switched straight away instead of asking first. You can always put its original sort back when you remove it."
              action={
                <s-switch
                  label="Switch collections to Manual sort without asking"
                  labelAccessibilityVisibility="exclusive"
                  checked={autoSwitchToManual || undefined}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                  onChange={(e: any) => {
                    setAutoSwitchToManual(Boolean(e.currentTarget?.checked));
                    markDirty();
                  }}
                />
              }
            />
            {needsManualSort > 0 && (
              <>
                <s-divider />
                {/* Warning tone because it is a real problem: those
                    collections are not being reordered at all. */}
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone="warning">
                    {needsManualSort} collection{needsManualSort === 1 ? "" : "s"} need
                    {needsManualSort === 1 ? "s" : ""} Manual sort
                  </s-badge>
                  <s-link href="/app/collections">Review in Collections</s-link>
                </s-stack>
              </>
            )}
          </AnnotatedSection>

          <s-divider />

          <AnnotatedSection
            icon="email"
            tone="success"
            title="Support"
            description="Email us about anything — a collection that didn't shuffle, a run you want undone, or a feature you need."
          >
            <SettingsRow
              label="Get in touch"
              value={
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-link href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</s-link>
                  <s-link href={WEBSITE_URL} target="_blank">
                    Shuffly website
                  </s-link>
                </s-stack>
              }
            />
          </AnnotatedSection>
        </s-stack>
      )}

      {/* The only CSS on this page, and it is layout only: the annotated
          two-column measure, collapsing to one column on narrow viewports
          the way Shopify's own settings pages do. */}
      <style>{`
        .shuffly-annotated-section {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
          gap: var(--p-space-500, 20px);
          align-items: start;
        }
        /* The card carries its own padding, so without this the annotation
           starts higher than the first label it annotates. One padding step
           down puts them on the same baseline. */
        .shuffly-annotated-section > :first-child {
          padding-block-start: var(--p-space-400, 16px);
        }
        @media (max-width: 820px) {
          .shuffly-annotated-section { grid-template-columns: 1fr; }
          .shuffly-annotated-section > :first-child { padding-block-start: 0; }
        }
      `}</style>

          <ScheduleModal
        ref={scheduleModalRef}
        target={scheduleTarget}
        shopDefault={shopDefault as SlotSchedule}
        timezone={settings.timezone}
        slots={scheduleSlots}
        busy={scheduleFetcher.state !== "idle"}
        onConfirm={(schedule) => {
          closeModal(scheduleModalRef.current);
          setScheduleTarget(null);
          if (!schedule) return;
          scheduleFetcher.submit(
            {
              _action: "set-shop-default",
              scheduleType: schedule.scheduleType,
              scheduleTime: schedule.scheduleTime,
              scheduleTime2: schedule.scheduleTime2 ?? "",
              scheduleWeekday: schedule.scheduleWeekday == null ? "" : String(schedule.scheduleWeekday),
            },
            { method: "post" },
          );
        }}
        onCancel={() => {
          closeModal(scheduleModalRef.current);
          setScheduleTarget(null);
        }}
      />

</s-page>
  );
}

/** One section of the page: its name and what it is for on the left, its
 * controls on the right. This is how Shopify's own settings pages are laid
 * out, and it replaced a two-column card grid that gave every section equal
 * weight and left a void wherever the shorter column ran out. */
function AnnotatedSection({
  icon,
  tone,
  title,
  description,
  children,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- s-icon's `type` union isn't worth re-declaring here
  icon: any;
  tone: StatTone;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="shuffly-annotated-section">
      <s-stack direction="block" gap="small-200">
        {/* One icon per section, one size, sitting on the heading's own
            baseline — no tinted chip behind it and no colour. The chips this
            replaced used brand orange as decoration; a plain icon anchors the
            heading without claiming to mean anything. */}
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <StatChip icon={icon} tone={tone} size={28} />
          <s-heading>{title}</s-heading>
        </s-stack>
        <s-text color="subdued">{description}</s-text>
      </s-stack>
      <s-section padding="base">
        <s-stack direction="block" gap="base">
          {children}
        </s-stack>
      </s-section>
    </div>
  );
}

/** One row shape for every setting, everywhere on this page: the label, the
 * value it currently has, and an action only when the value can be changed
 * from here. The help line always sits underneath — never above, never
 * beside. `value` takes a node as well as a string so a chip list or a link
 * is still laid out as the row's value rather than becoming its own shape. */
function SettingsRow({
  label,
  value,
  help,
  badge,
  action,
}: {
  label: string;
  value?: React.ReactNode;
  /** Omitted where the section's annotation already says it — a row that
   * repeats its own heading in smaller grey type is noise. */
  help?: string;
  /** State worth colouring, next to the label. A Polaris tone badge is the
   * only colour on these rows, and it always carries meaning: whether a
   * setting is on, how long until the next run, what needs attention. */
  badge?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-200">
          {/* Where a row has a value, that value is the thing the merchant
              came to read, so it takes the strong weight and the label
              becomes its caption. Where a row has no value — a toggle, whose
              label IS the setting — the label keeps the weight instead. */}
          {value != null ? (
            <>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text color="subdued">{label}</s-text>
                {badge}
              </s-stack>
              {typeof value === "string" ? <s-text type="strong">{value}</s-text> : value}
            </>
          ) : (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">{label}</s-text>
              {badge}
            </s-stack>
          )}
        </s-stack>
        {action}
      </s-grid>
      {help && <s-text color="subdued">{help}</s-text>}
    </s-stack>
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

function SettingsSkeleton() {
  return (
    <s-stack direction="block" gap="base">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="shuffly-annotated-section">
          <s-stack direction="block" gap="small-200">
            <Bar width={140} />
            <Bar width={200} />
          </s-stack>
          <s-section padding="base">
            <s-stack direction="block" gap="base">
              <Bar width={180} />
              <Bar width={260} />
            </s-stack>
          </s-section>
        </div>
      ))}
    </s-stack>
  );
}
