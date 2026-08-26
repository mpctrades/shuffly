import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigation, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { KeyValueRows } from "../components/KeyValueRows";
import {
  getShopTimezone,
  getShopContactEmail,
} from "../lib/collections.server";
import { timezoneOffsetLabel } from "../lib/schedule.server";

const SAVE_BAR_ID = "settings-save-bar";

type Tone = "success" | "warning" | "info" | "neutral";

/** One color story for every card on this page — the same token family as
 * Insights/Help, so all three pages read as one design. "warning" is the
 * brand/orange accent used everywhere else in the app for that purpose;
 * every value is a Polaris token, the hex after each is a same-hue
 * fallback only, never the source of truth. */
const TONE_TOKENS: Record<Tone, { accent: string; tint: string }> = {
  success: {
    accent: "var(--p-color-icon-success, #008060)",
    tint: "var(--p-color-bg-fill-success-secondary, #E3F5EE)",
  },
  warning: {
    accent: "var(--p-color-icon-warning, #FF4B1F)",
    tint: "var(--p-color-bg-fill-warning-secondary, #FFF1E4)",
  },
  info: {
    accent: "var(--p-color-icon-info, #1F5199)",
    tint: "var(--p-color-bg-fill-info-secondary, #EAF2FF)",
  },
  neutral: {
    accent: "var(--p-color-icon-secondary, #6b6b6b)",
    tint: "var(--p-color-bg-fill-secondary, #F1F1F1)",
  },
};

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

  // Prefer the actual logged-in staff member's email (only ever present for
  // an online session); fall back to the shop's own contact address rather
  // than guessing at "the store owner".
  let notifyEmail: string | null =
    session.onlineAccessInfo?.associated_user?.email ?? null;
  if (!notifyEmail) {
    try {
      notifyEmail = await getShopContactEmail(admin);
    } catch {
      notifyEmail = null;
    }
  }

  return {
    settings: { ...settings, timezone },
    timezoneLabel: `${timezone} (${timezoneOffsetLabel(timezone)})`,
    notifyEmail,
    error,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  await getOrCreateShopSettings(admin, shop);
  const formData = await request.formData();

  const defaultRunTime = String(formData.get("defaultRunTime") ?? "06:00");
  const language = String(formData.get("language") ?? "en");
  const neverMoveTags = String(formData.get("neverMoveTags") ?? "");
  const emailOnFailure = formData.get("emailOnFailure") === "true";
  const emailMonthlySummary = formData.get("emailMonthlySummary") === "true";
  const emailMorningRun = formData.get("emailMorningRun") === "true";

  await db.shopSettings.update({
    where: { shop },
    data: {
      defaultRunTime,
      language,
      neverMoveTags,
      emailOnFailure,
      emailMonthlySummary,
      emailMorningRun,
    },
  });

  return data({ ok: true });
};

export default function Settings() {
  const { settings, timezoneLabel, notifyEmail, error } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const fetcher = useFetcher<{ ok: boolean }>();
  const isLoading =
    navigation.state === "loading" &&
    navigation.location?.pathname === "/app/settings";
  const busy = fetcher.state !== "idle";

  const [defaultRunTime, setDefaultRunTime] = useState(settings.defaultRunTime);
  const [language, setLanguage] = useState(settings.language);
  const [tags, setTags] = useState<string[]>(() =>
    parseTags(settings.neverMoveTags),
  );
  const [emailOnFailure, setEmailOnFailure] = useState(settings.emailOnFailure);
  const [emailMonthlySummary, setEmailMonthlySummary] = useState(
    settings.emailMonthlySummary,
  );
  const [emailMorningRun, setEmailMorningRun] = useState(
    settings.emailMorningRun,
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
    setDefaultRunTime(settings.defaultRunTime);
    setLanguage(settings.language);
    setTags(parseTags(settings.neverMoveTags));
    setEmailOnFailure(settings.emailOnFailure);
    setEmailMonthlySummary(settings.emailMonthlySummary);
    setEmailMorningRun(settings.emailMorningRun);
    setAddingTag(false);
    setNewTag("");
    setDirty(false);
    shopify.saveBar.hide(SAVE_BAR_ID);
  }

  function handleSave() {
    fetcher.submit(
      {
        defaultRunTime,
        language,
        neverMoveTags: tags.join(","),
        emailOnFailure: String(emailOnFailure),
        emailMonthlySummary: String(emailMonthlySummary),
        emailMorningRun: String(emailMorningRun),
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

  function setLanguageAndMark(lang: string) {
    setLanguage(lang);
    markDirty();
  }

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
            <SettingsCard icon="clock" tone="warning" title="Store">
              <s-stack direction="block" gap="base">
                <s-select
                  label="Timezone"
                  value={settings.timezone}
                  details="Read from Shopify. All schedules follow it."
                >
                  <s-option value={settings.timezone}>{timezoneLabel}</s-option>
                </s-select>
                <s-text-field
                  label="Default run time"
                  value={defaultRunTime}
                  details="Your quietest hour, from your own orders."
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                  onInput={(e: any) => {
                    setDefaultRunTime(e.currentTarget?.value ?? "");
                    markDirty();
                  }}
                />
                {/* The only language control on the page now — a header
                    toggle used to exist alongside this and could disagree
                    with it (FR selected up top, English rendered below).
                    This select is the real setting: it's what gets saved,
                    and it's the only thing that should ever claim a
                    language is selected. */}
                <s-select
                  label="Language"
                  value={language}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                  onChange={(e: any) =>
                    setLanguageAndMark(e.currentTarget?.value ?? "en")
                  }
                >
                  <s-option value="en">English</s-option>
                  <s-option value="fr">Français</s-option>
                </s-select>
              </s-stack>
            </SettingsCard>

            <SettingsCard icon="pin" tone="warning" title="Never move these">
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

            <SettingsCard icon="email" tone="info" title="Email me">
              <s-stack direction="block" gap="small">
                <s-switch
                  label="If a run fails"
                  checked={emailOnFailure}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                  onChange={(e: any) => {
                    setEmailOnFailure(Boolean(e.currentTarget?.checked));
                    markDirty();
                  }}
                />
                <s-switch
                  label="A monthly summary"
                  checked={emailMonthlySummary}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                  onChange={(e: any) => {
                    setEmailMonthlySummary(Boolean(e.currentTarget?.checked));
                    markDirty();
                  }}
                />
                <s-switch
                  label="Every morning after the run"
                  checked={emailMorningRun}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.checked isn't in the typed event map
                  onChange={(e: any) => {
                    setEmailMorningRun(Boolean(e.currentTarget?.checked));
                    markDirty();
                  }}
                />
              </s-stack>
              <CardFooterStrip>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    width: "100%",
                    gap: 12,
                  }}
                >
                  <s-text color="subdued">Sent to</s-text>
                  <div style={{ fontWeight: 500 }}>
                    {notifyEmail ?? "No notification email on file yet"}
                  </div>
                </div>
              </CardFooterStrip>
            </SettingsCard>
          </s-stack>

          <s-stack direction="block" gap="base">
            <SettingsCard
              icon="shield-person"
              tone="success"
              title="What Shuffly can access"
            >
              <KeyValueRows
                rows={[
                  {
                    label: "Read your products",
                    value: <AccessValue text="Yes" tone="neutral" />,
                  },
                  {
                    label: "Change collection order",
                    value: <AccessValue text="Yes" tone="neutral" />,
                  },
                  {
                    label: "Customer data",
                    value: <AccessValue text="No access" tone="success" />,
                  },
                  {
                    label: "Orders",
                    value: <AccessValue text="No access" tone="success" />,
                  },
                  {
                    label: "Your theme",
                    value: <AccessValue text="No access" tone="success" />,
                  },
                ]}
              />
            </SettingsCard>

            <SettingsCard icon="gauge" tone="success" title="Your store speed">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 16,
                }}
              >
                {[
                  { value: "0 KB", label: "Page weight" },
                  { value: "0", label: "Theme files" },
                  { value: "0", label: "Scripts" },
                ].map((stat) => (
                  <div key={stat.label} style={{ textAlign: "center" }}>
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        color: "var(--p-color-text-success, #008060)",
                      }}
                    >
                      {stat.value}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      <s-text color="subdued">{stat.label}</s-text>
                    </div>
                  </div>
                ))}
              </div>
              <CardFooterStrip>
                <s-text color="subdued">
                  Shuffly changes the real product order in Shopify. Nothing
                  runs in your customers&apos; browsers.
                </s-text>
              </CardFooterStrip>
            </SettingsCard>

            <SettingsCard icon="apps" tone="info" title="Works alongside">
              <KeyValueRows
                rows={[
                  {
                    label: "Judge.me Reviews",
                    value: (
                      <s-button
                        onClick={() =>
                          shopify.toast.show(
                            "Judge.me integration isn't available yet",
                          )
                        }
                      >
                        Connect
                      </s-button>
                    ),
                  },
                  // Shopify's own Flow and Search & Discovery are covered by
                  // a real compatibility statement, not live detection —
                  // there's no signal yet for whether a shop actually has
                  // them installed. That's why these read as fixed facts
                  // ("no conflict with how Shuffly writes order") rather
                  // than a connected/disconnected status. If a row like
                  // this is ever added WITHOUT that backing fact being
                  // true, hide it instead of shipping a guess.
                  {
                    label: "Shopify Flow",
                    value: <AccessValue text="Connected" tone="success" />,
                  },
                  {
                    label: "Search & Discovery",
                    value: <AccessValue text="No conflict" tone="success" />,
                  },
                ]}
              />
              <CardFooterStrip>
                <s-text color="subdued">
                  If another app also sets collection order, Shuffly tells you
                  instead of fighting it.
                </s-text>
              </CardFooterStrip>
            </SettingsCard>

            <SettingsCard icon="info" tone="neutral" title="If you uninstall">
              <s-paragraph>
                Your collections keep the order they have. Nothing to clean up.
                Shuffly&apos;s data is deleted within 48 hours.
              </s-paragraph>
            </SettingsCard>
          </s-stack>
        </div>
      )}

      <style>{`
        @media (max-width: 820px) {
          .shuffly-settings-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </s-page>
  );
}

/** The grey strip along the bottom of a card. Doesn't force its own text
 * styling — most callers just want plain subdued copy (wrap the string in
 * `<s-text color="subdued">` yourself), but the email strip needs a label
 * and a value styled differently from each other, so this stays a plain
 * container. */
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

/** A "Yes"/"No access" style value with a small check icon before it —
 * `tone="success"` for the reassuring cases (no access, no conflict),
 * `tone="neutral"` for a plain fact that isn't good or bad news. A custom
 * SVG, not `s-icon type="check"`: that icon doesn't honor `tone` and
 * always renders green (same issue found on the Plan page's trust row),
 * which would make the "neutral" rows here — "Yes" to reading your
 * products, changing collection order — look identically reassuring to
 * the actual "No access" rows below them, on a card whose whole point is
 * that distinction. */
function AccessValue({
  text,
  tone,
}: {
  text: string;
  tone: "neutral" | "success";
}) {
  const color =
    tone === "success" ? "var(--p-color-icon-success, #008060)" : "var(--p-color-icon-secondary, #6b6b6b)";
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M2.5 7.3L5.6 10.4L11.5 3.6"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <s-text type="strong" tone={tone === "success" ? "success" : undefined}>
        {text}
      </s-text>
    </s-stack>
  );
}

/** The card shell shared by every card on this page — and matching the one
 * on Insights/Help: white surface, 1px border, 12px radius, subtle shadow,
 * a 3px accent bar on top, and a 32px icon chip beside the heading. */
function SettingsCard({
  icon,
  tone,
  title,
  children,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- s-icon's `type` union isn't worth re-declaring here
  icon: any;
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  const tokens = TONE_TOKENS[tone];
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
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: tokens.accent,
        }}
      />
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
              background: tokens.tint,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <s-icon type={icon} tone={tone}></s-icon>
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
        {[0, 1, 2, 3].map((i) => (
          <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <Bar width={140} />
              <Bar width={140} />
              <Bar width={140} />
            </s-stack>
          </s-box>
        ))}
      </s-stack>
    </div>
  );
}
