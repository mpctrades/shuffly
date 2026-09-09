import { closeModal } from "../lib/polaris-modal";
import { IconChip } from "../components/IconChip";
import { ScheduleModal, type ScheduleTarget } from "../components/ScheduleModal";
import { shopDefaultSchedule } from "../lib/schedule-resolve";
import { nextRunFor, slotsFarEnoughApart, type ScheduleType, type SlotSchedule } from "../lib/schedule.server";
import { timeSlots } from "../lib/plans.server";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  const soonestNextRunMs = tracked
    .filter((t) => t.status === "RUNNING" && t.nextRunAt)
    .map((t) => t.nextRunAt!.getTime())
    .sort((a, b) => a - b)[0];
  // Collections a run has already found stuck off Manual sort. Persisted by
  // the engine, so this costs nothing here — it will not catch a sort changed
  // since the last run, which the Collections page's live check does.
  const needsManualSort = tracked.filter((t) => t.sortOrderIssueAt != null).length;
  // "Ready" = running, with no sort problem a run has actually hit. Derived
  // from the query above, so it adds nothing. It is the lagging signal, not
  // a live sortOrder read — see the Collections page for that.
  const readyCount = tracked.filter((t) => t.status === "RUNNING" && t.sortOrderIssueAt == null).length;

  return {
    settings: { ...settings, timezone },
    trackedCount: tracked.length,
    nextRunAtMs: soonestNextRunMs ?? null,
    needsManualSort,
    readyCount,
    timezoneLabel: timezone,
    timezoneOffset: timezoneOffsetLabel(timezone),
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
    timezoneOffset,
    shopDefault,
    scheduleSlots,
    shopifyTimezoneUrl,
    trackedCount,
    nextRunAtMs,
    needsManualSort,
    readyCount,
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
  // Split in two so the row can show the time as its value and the cadence
  // as the sub-line, rather than one long sentence.
  const shopDefaultValue = useMemo(() => {
    const day = shopDefault.scheduleWeekday != null ? WEEKDAY_NAMES[shopDefault.scheduleWeekday] : null;
    if (shopDefault.scheduleType === "WEEKLY" && day) return `${day} ${shopDefault.scheduleTime}`;
    if (shopDefault.scheduleType === "TWICE_DAILY")
      return `${shopDefault.scheduleTime} and ${shopDefault.scheduleTime2 ?? "—"}`;
    if (shopDefault.scheduleType === "DAILY") return shopDefault.scheduleTime;
    return "Manual only";
  }, [shopDefault]);
  const shopDefaultCadence = useMemo(() => {
    if (shopDefault.scheduleType === "WEEKLY") return "weekly";
    if (shopDefault.scheduleType === "TWICE_DAILY") return "twice daily";
    if (shopDefault.scheduleType === "DAILY") return "daily";
    return "only when you press Shuffle";
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
        <div className="shuffly-settings-column">
          {/* One rule holds this page together: every control sits on the
              same right edge, on its label's line. The layout this replaced
              had a link at one card's top-right, a button at another's, a
              toggle mid-row and tags bottom-left — four places to look for
              the thing you came to change. */}
          <SettingsGroup icon="clock" title="Schedule">
            <SettingsRow
              label="Timezone"
              help="Read from your Shopify settings"
              valueOverride={timezoneLabel}
              subValue={timezoneOffset}
              control={(helpId) => (
                <s-link href={shopifyTimezoneUrl} target="_blank" aria-describedby={helpId}>
                  Change
                </s-link>
              )}
            />
            <s-divider />
            <SettingsRow
              label="Default schedule"
              badge={nextRunAtMs != null ? <s-badge>{countdown}</s-badge> : undefined}
              help="Collections use this unless you set their own time"
              valueOverride={shopDefaultValue}
              subValue={shopDefaultCadence}
              control={(helpId) => (
                <s-button
                  aria-describedby={helpId}
                  accessibilityLabel="Change the default schedule"
                  onClick={() => {
                    setScheduleTarget({ mode: "shop-default", schedule: shopDefault as SlotSchedule });
                    scheduleModalRef.current?.showOverlay();
                  }}
                >
                  Change
                </s-button>
              )}
            />
          </SettingsGroup>

          <SettingsGroup icon="pin" title="Never move these">
            <SettingsRow
              label="Products tagged"
              help="Left exactly where they are, in every collection"
              control={(helpId) => (
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  {tags.map((tag) => (
                    <s-clickable-chip
                      key={tag}
                      removable
                      accessibilityLabel={`Remove the ${tag} tag`}
                      onRemove={() => removeTag(tag)}
                    >
                      {tag}
                    </s-clickable-chip>
                  ))}
                  {!addingTag && (
                    <s-button
                      aria-describedby={helpId}
                      accessibilityLabel="Add a never-move tag"
                      onClick={() => setAddingTag(true)}
                    >
                      + Add
                    </s-button>
                  )}
                </s-stack>
              )}
            />
            {addingTag && (
              <>
                <s-divider />
                <div className="shuffly-settings-rowpad">
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
                </div>
              </>
            )}
          </SettingsGroup>

          <SettingsGroup icon="apps" title="Collections">
            <SettingsRow
              label="Ready to shuffle"
              badge={
                needsManualSort > 0 ? (
                  <s-badge tone="warning">{needsManualSort} needs Manual sort</s-badge>
                ) : undefined
              }
              help="A collection that leaves Manual sort stops being reordered"
              valueOverride={`${readyCount} of ${trackedCount}`}
              control={(helpId) => (
                <s-link href="/app/collections" aria-describedby={helpId}>
                  Review
                </s-link>
              )}
            />
            <s-divider />
            <SettingsRow
              label="Switch to Manual sort without asking"
              badge={autoSwitchToManual ? <s-badge tone="success">On</s-badge> : <s-badge>Off</s-badge>}
              help="Switches automated collections straight away instead of asking"
              control={(helpId) => (
                <s-switch
                  label="Switch to Manual sort without asking"
                  labelAccessibilityVisibility="exclusive"
                  aria-describedby={helpId}
                  checked={autoSwitchToManual || undefined}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                  onChange={(e: any) => {
                    setAutoSwitchToManual(Boolean(e.currentTarget?.checked));
                    markDirty();
                  }}
                />
              )}
            />
          </SettingsGroup>

          <SettingsGroup icon="email" title="Support">
            <SettingsRow
              label="Email us"
              help="A run you want undone, or a feature you need"
              control={(helpId) => (
                <s-link href={SUPPORT_MAILTO} aria-describedby={helpId}>
                  {SUPPORT_EMAIL}
                </s-link>
              )}
            />
            <s-divider />
            <SettingsRow
              label="Guides and release notes"
              help="Answers to common questions"
              control={(helpId) => (
                <s-link href={WEBSITE_URL} target="_blank" aria-describedby={helpId}>
                  Shuffly website
                </s-link>
              )}
            />
          </SettingsGroup>
        </div>
      )}

      {/* Layout only. The annotated two-column grid and the stat-tile row
          this replaced are both gone, along with all of their rules. */}
      <style>{`
        .shuffly-settings-column {
          display: flex;
          flex-direction: column;
          gap: 24px;
          max-width: 640px;
          margin: 0 auto;
          padding: 4px 0 24px;
        }
        /* The group label sits ABOVE its card, small and uppercase, which is
           what let the side column go — and with it the dead space that sat
           next to every short annotation. */
        .shuffly-settings-grouplabel {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 8px 2px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        .shuffly-icon-chip {
          flex: none;
          border-radius: 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        /* The shared right edge, and the shared rhythm every row keeps. */
        .shuffly-settings-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 16px;
          align-items: center;
          min-height: 54px;
          padding: 12px 16px;
        }
        .shuffly-settings-rowpad { padding: 12px 16px; }
        .shuffly-settings-rowlabel { min-width: 0; }
        .shuffly-settings-labelline {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .shuffly-settings-label { font-weight: 600; color: var(--p-color-text, #131110); }
        .shuffly-settings-help {
          display: block;
          margin-top: 2px;
          font-size: 12px;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        .shuffly-settings-control {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 12px;
          flex-wrap: wrap;
        }
        .shuffly-settings-valuebox { text-align: right; }
        .shuffly-settings-value { display: block; font-weight: 600; color: var(--p-color-text, #131110); }
        .shuffly-settings-subvalue {
          display: block;
          font-size: 12px;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        /* Controls wrap beneath their label rather than squeezing. */
        @media (max-width: 720px) {
          .shuffly-settings-row { grid-template-columns: 1fr; align-items: start; }
          .shuffly-settings-control { justify-content: flex-start; }
          .shuffly-settings-valuebox { text-align: left; }
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
/** A group: a small uppercase label with one tinted chip, sitting ABOVE its
 * card rather than beside it. That is what let the side column go, and with
 * it the dead space next to every short annotation. */
function SettingsGroup({
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
    <section className="shuffly-settings-group">
      <div className="shuffly-settings-grouplabel">
        <IconChip icon={icon} />
        <span>{title}</span>
      </div>
      <s-section padding="none">{children}</s-section>
    </section>
  );
}

/** The one row shape, used without exception.
 *
 * LEFT  the label at 600, an inline badge where state is worth colouring,
 *       and one subdued line of help beneath.
 * RIGHT the value and/or control, right-aligned and vertically centred.
 *
 * `control` is a function of the help text's id so the caller can hang
 * aria-describedby on the real control — the association has to be on the
 * focusable element, and only the caller knows which that is. */
function SettingsRow({
  label,
  badge,
  help,
  valueOverride,
  subValue,
  control,
}: {
  label: string;
  badge?: React.ReactNode;
  help: string;
  /** The row's value, shown above the sub-line. Omitted on rows where the
   * control IS the value, like the toggle or the tag chips. */
  valueOverride?: string;
  subValue?: string;
  control: (helpId: string) => React.ReactNode;
}) {
  const helpId = useId();
  return (
    <div className="shuffly-settings-row">
      <div className="shuffly-settings-rowlabel">
        <div className="shuffly-settings-labelline">
          <span className="shuffly-settings-label">{label}</span>
          {badge}
        </div>
        <span id={helpId} className="shuffly-settings-help">
          {help}
        </span>
      </div>
      <div className="shuffly-settings-control">
        {valueOverride != null && (
          <div className="shuffly-settings-valuebox">
            <span className="shuffly-settings-value">{valueOverride}</span>
            {subValue && <span className="shuffly-settings-subvalue">{subValue}</span>}
          </div>
        )}
        {control(helpId)}
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
    <div className="shuffly-settings-column">
      {[0, 1, 2, 3].map((i) => (
        <section key={i} className="shuffly-settings-group">
          <div className="shuffly-settings-grouplabel">
            <Bar width={90} />
          </div>
          <s-section padding="none">
            {[0, 1].map((r) => (
              <div key={r} className="shuffly-settings-row">
                <div className="shuffly-settings-rowlabel">
                  <Bar width={150} />
                  <Bar width={220} />
                </div>
              </div>
            ))}
          </s-section>
        </section>
      ))}
    </div>
  );
}
