import { closeModal } from "../lib/polaris-modal";
import { ScheduleModal, type ScheduleTarget } from "../components/ScheduleModal";
import { shopDefaultSchedule } from "../lib/schedule-resolve";
import { nextRunFor, slotsFarEnoughApart, type ScheduleType, type SlotSchedule } from "../lib/schedule.server";
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

const SAVE_BAR_ID = "settings-save-bar";

/* One accent, used once. The cards used to carry a 3px coloured bar along
   the top — orange on the left column, blue on the right — which encoded
   nothing and put a colour in the UI that isn't in Shuffly's palette (brand
   orange, ink, paper). The bar is gone and the card's own border does the
   separating; the icon chip is the single accent, and it is always the brand
   orange. Polaris token, with a same-hue hex fallback only. */
const ICON_TINT = "var(--p-color-bg-fill-warning-secondary, #FFF1E4)";

function parseTags(csv: string): string[] {
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

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

  return {
    settings: { ...settings, timezone },
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
  const { settings, timezoneLabel, shopDefault, scheduleSlots, shopifyTimezoneUrl, error } =
    useLoaderData<typeof loader>();
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
    fetcher.submit(
      {
        neverMoveTags: tags.join(","),
        autoSwitchToManual: autoSwitchToManual ? "on" : "",
      },
      { method: "post" },
    );
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
    const t = newTag.trim();
    if (t) {
      setTags((prev) =>
        prev.some((x) => x.toLowerCase() === t.toLowerCase())
          ? prev
          : [...prev, t],
      );
      markDirty();
    }
    setNewTag("");
    setAddingTag(false);
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
    markDirty();
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
        <div
          className="shuffly-settings-grid"
          style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}
        >
          <s-stack direction="block" gap="base">
            {/* Everything left in this card is about when things run, so it
                is called Schedule. Both rows use the same shape — label,
                current value, and an action only when the value is editable
                here — with the help line always underneath. */}
            <SettingsCard icon="clock" title="Schedule">
              <s-stack direction="block" gap="base">
                {/* Read-only on purpose. Shopify owns this value: the
                    shop/update webhook overwrites it whenever the merchant
                    changes it in Shopify, and this page's loader re-reads it
                    live on every visit. It was previously rendered as a
                    dropdown, which promised an edit the app could not keep —
                    the select had no name, so it never submitted anything,
                    and even if it had, the webhook would have reverted it. */}
                <SettingsRow
                  label="Timezone"
                  value={timezoneLabel}
                  help="Read from your Shopify settings. All schedules follow it."
                  action={
                    <s-link href={shopifyTimezoneUrl} target="_blank">
                      Change in Shopify
                    </s-link>
                  }
                />

                <SettingsRow
                  label="Default schedule"
                  value={shopDefaultLabel}
                  help="All collections use this unless you set a different time on the collection itself."
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
              </s-stack>
            </SettingsCard>

            <SettingsCard icon="pin" title="Never move these">
              <s-stack direction="block" gap="small-200">
                <div>
                  <s-text type="strong">Products tagged</s-text>
                  <div style={{ marginTop: 2 }}>
                    <s-text color="subdued">
                      Applies to every collection.
                    </s-text>
                  </div>
                </div>
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
                    <s-button onClick={() => setAddingTag(true)}>
                      + Add tag
                    </s-button>
                  )}
                </s-stack>
                {addingTag && (
                  <s-grid
                    gridTemplateColumns="1fr auto auto"
                    gap="small"
                    alignItems="end"
                  >
                    <s-text-field
                      label="New tag"
                      labelAccessibilityVisibility="exclusive"
                      value={newTag}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                      onInput={(e: any) =>
                        setNewTag(e.currentTarget?.value ?? "")
                      }
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
              </s-stack>
            </SettingsCard>

          </s-stack>

          <s-stack direction="block" gap="base">
            <SettingsCard icon="apps" title="Adding collections">
              <s-stack direction="block" gap="small-200">
                <s-switch
                  label="Switch collections to Manual sort without asking"
                  checked={autoSwitchToManual || undefined}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                  onChange={(e: any) => {
                    setAutoSwitchToManual(Boolean(e.currentTarget?.checked));
                    markDirty();
                  }}
                />
                <s-text color="subdued">
                  Shuffly can only set the order on a collection that uses Manual sort. With this on,
                  adding an automated collection switches it straight away instead of asking first.
                </s-text>
              </s-stack>
              <CardFooterStrip>
                <s-text color="subdued">
                  You can always put a collection&apos;s original sort back when you remove it from
                  Shuffly.
                </s-text>
              </CardFooterStrip>
            </SettingsCard>

            <SettingsCard icon="email" title="Support">
              <s-stack direction="block" gap="small-200">
                <s-paragraph>
                  Email us about anything — a collection that didn&apos;t shuffle, a run you want undone, or a
                  feature you need.
                </s-paragraph>
                <s-paragraph>
                  <s-link href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</s-link>
                </s-paragraph>
                <s-paragraph>
                  <s-link href={WEBSITE_URL} target="_blank">
                    Shuffly website
                  </s-link>
                </s-paragraph>
              </s-stack>
              <CardFooterStrip>
                <s-text color="subdued">
                  The Help page has the same address, plus a button that copies your shop details for us.
                </s-text>
              </CardFooterStrip>
            </SettingsCard>
          </s-stack>
        </div>
      )}

      <style>{`
        @media (max-width: 820px) {
          .shuffly-settings-grid { grid-template-columns: 1fr !important; }
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

/** The grey strip along the bottom of a card. Callers provide their own
 * text styling so the container stays reusable. */
function CardFooterStrip({ children }: { children: React.ReactNode }) {
  return (
    <>
      <s-divider />
      <s-box padding="base" background="subdued">
        {children}
      </s-box>
    </>
  );
}

/** The card shell shared by every card on this page — and matching the one
 * on Insights/Help: white surface, 1px border, 12px radius, subtle shadow,
 * a 3px accent bar on top, and a 32px icon chip beside the heading. */
/** One row shape for every setting: the label, the value it currently has,
 * and an action only when the value can be changed from here. The help line
 * always sits underneath, never above and never beside — three different
 * arrangements in one small card is what made this page hard to read. */
function SettingsRow({
  label,
  value,
  help,
  action,
}: {
  label: string;
  value: string;
  help: string;
  action: React.ReactNode;
}) {
  return (
    <div>
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <div>
          <s-text type="strong">{label}</s-text>
          <div style={{ marginTop: 2 }}>
            <s-text>{value}</s-text>
          </div>
        </div>
        {action}
      </s-grid>
      <div style={{ marginTop: 4 }}>
        <s-text color="subdued">{help}</s-text>
      </div>
    </div>
  );
}

function SettingsCard({
  icon,
  title,
  children,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- s-icon's `type` union isn't worth re-declaring here
  icon: any;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        background: "var(--p-color-bg-surface, #ffffff)",
        border: "1px solid var(--p-color-border, #e3e3e3)",
        borderRadius: 12,
        boxShadow: "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 32,
              height: 32,
              flex: "0 0 auto",
              borderRadius: 8,
              background: ICON_TINT,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <s-icon type={icon} tone="warning"></s-icon>
          </div>
          <s-heading>{title}</s-heading>
        </div>
        {children}
      </div>
    </div>
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
    <div
      className="shuffly-settings-grid"
      style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}
    >
      <s-stack direction="block" gap="base">
        {[0, 1, 2].map((i) => (
          <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <Bar width={120} />
              <Bar width={220} />
              <Bar width={160} />
            </s-stack>
          </s-box>
        ))}
      </s-stack>
      <s-stack direction="block" gap="base">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="small">
            <Bar width={140} />
            <Bar width={140} />
            <Bar width={140} />
          </s-stack>
        </s-box>
      </s-stack>
    </div>
  );
}
