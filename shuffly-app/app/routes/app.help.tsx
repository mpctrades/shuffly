import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { planOf } from "../lib/plans";
import { KeyValueRows } from "../components/KeyValueRows";
import en from "../locales/en.json";
import fr from "../locales/fr.json";

interface Question {
  id: string;
  q: string;
  a: string;
}

interface QuestionGroup {
  title: string;
  questions: Question[];
}

// Same plain-voice answers the flat list already had, plus the three new
// ones — now grouped by what the merchant is actually worried about.
const GROUPS: QuestionGroup[] = [
  {
    title: "Safety",
    questions: [
      {
        id: "seo",
        q: "Will this hurt my SEO?",
        a: "No. Shuffly changes the real order inside Shopify, so Google sees a normal collection page.",
      },
      {
        id: "speed",
        q: "Will it slow my store down?",
        a: "It adds 0 KB. No theme code, no scripts.",
      },
      {
        id: "uninstall",
        q: "What happens if I uninstall?",
        a: "Your collections keep their current order. Nothing to undo.",
      },
    ],
  },
  {
    title: "Using it",
    questions: [
      {
        id: "reorder",
        q: "What if I re-order products myself?",
        a: "Your changes stand until the next scheduled run — pins are re-applied on the next shuffle.",
      },
      {
        id: "pause",
        q: "Can I stop it during a campaign?",
        a: "Yes — pause a collection from its workspace page, or switch its schedule to manual.",
      },
      {
        id: "cant-add",
        q: "Why can't I add one of my collections?",
        a: "Shopify only lets an app set positions on manually-sorted collections. Shuffly can switch it for you, and it's reversible.",
      },
    ],
  },
  {
    title: "Billing",
    questions: [
      {
        id: "change-plan",
        q: "How do I change or cancel my plan?",
        a: "On the Plan page. It takes effect immediately — no email, no support ticket.",
      },
      {
        id: "downgrade",
        q: "What happens to my collections if I downgrade?",
        a: "Any collections over your new plan's limit are paused, not deleted. We tell you which ones first.",
      },
    ],
  },
];

type Tone = "success" | "warning" | "info";

/** One color story, reused by the "how it works" tiles AND the question-row
 * group chips, so the two systems on this page read as the same design —
 * every value is a Polaris token, the hex after each is a same-hue fallback
 * only, never the source of truth. */
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
};

// Billing gets the brand tone (the same orange stat tiles use elsewhere in
// the app) rather than "info" or "success", since it isn't good or bad news.
const GROUP_TONE: Record<string, Tone> = {
  Safety: "success",
  "Using it": "info",
  Billing: "warning",
};

const HOW_IT_WORKS: Array<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- s-icon's `type` union isn't worth re-declaring here
  icon: any;
  tone: Tone;
  title: string;
  body: string;
}> = [
  {
    icon: "pin",
    tone: "warning",
    title: "Pins stay put",
    body: "The first few products never move.",
  },
  {
    icon: "refresh",
    tone: "info",
    title: "Everything rotates",
    body: "The rest re-order every run, so more of your catalogue gets seen.",
  },
  {
    icon: "inventory",
    tone: "success",
    title: "Sold-out drops",
    body: "Out-of-stock products go to the end automatically.",
  },
];

// The "Contact support" card needs real, current facts about this shop — never
// hard-coded — so a merchant's "Copy shop details" always reflects reality.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getOrCreateShopSettings(admin, shop);

  const [trackedCount, lastRun] = await Promise.all([
    db.collectionConfig.count({ where: { shop } }),
    db.shuffleRun.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  return {
    shop,
    planName: planOf(settings.plan).name,
    trackedCount,
    lastRunAt: lastRun ? lastRun.createdAt.toISOString() : null,
    strings: settings.language === "fr" ? fr : en,
  };
};

export default function Help() {
  const { shop, planName, trackedCount, lastRunAt, strings: t } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  function contactSupport() {
    window.location.href = "mailto:team@mapetitecoree.com?subject=Shuffly%20support";
  }

  function copyDetails() {
    const lines = [
      `Shop: ${shop}`,
      `Plan: ${planName}`,
      `Collections tracked: ${trackedCount}`,
      `Last run: ${lastRunAt ?? "none yet"}`,
    ];
    navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => shopify.toast.show(t["help.contactSupport.copyToast"]))
      .catch(() => shopify.toast.show("Couldn't copy that just now", { isError: true }));
  }

  const needle = query.trim().toLowerCase();
  const filteredGroups = needle
    ? GROUPS.map((g) => ({
        ...g,
        questions: g.questions.filter(
          (item) =>
            item.q.toLowerCase().includes(needle) ||
            item.a.toLowerCase().includes(needle),
        ),
      })).filter((g) => g.questions.length > 0)
    : GROUPS;
  const hasResults = filteredGroups.length > 0;

  return (
    <s-page heading="Help">
      <s-button
        slot="primary-action"
        variant="primary"
        href="https://shuffly.mpctrades.com"
        target="_blank"
      >
        Website
      </s-button>

      <s-stack direction="block" gap="base">
        <div
          className="shuffly-help-tiles"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            alignItems: "stretch",
            gap: 16,
          }}
        >
          {HOW_IT_WORKS.map((tile) => {
            const tokens = TONE_TOKENS[tile.tone];
            return (
              <div
                key={tile.title}
                style={{
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 148,
                  background: "var(--p-color-bg-surface, #ffffff)",
                  border: "1px solid var(--p-color-border, #e3e3e3)",
                  borderRadius: 12,
                  boxShadow:
                    "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
                  padding: 16,
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
                    borderRadius: "12px 12px 0 0",
                  }}
                />
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
                    marginBottom: 8,
                  }}
                >
                  <s-icon type={tile.icon} tone={tile.tone}></s-icon>
                </div>
                <s-text type="strong">{tile.title}</s-text>
                <div style={{ marginTop: 4 }}>
                  <s-text color="subdued">{tile.body}</s-text>
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="shuffly-help-grid"
          style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}
        >
          <s-section padding="none">
            <div style={{ padding: "16px 16px 0" }}>
              <s-heading>Questions we get</s-heading>
            </div>
            <div style={{ padding: "12px 16px 16px" }}>
              <s-search-field
                label="Search help"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search help"
                value={query}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
                onInput={(e: any) => setQuery(e.currentTarget?.value ?? "")}
              />
            </div>

            {hasResults ? (
              filteredGroups.map((group, gi) => (
                <div key={group.title}>
                  <div
                    style={{
                      padding: "24px 16px 8px",
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--p-color-text-secondary, #6b6b6b)",
                    }}
                  >
                    {group.title}
                  </div>
                  {group.questions.map((item, qi) => (
                    <div key={item.id}>
                      <QuestionRow
                        item={item}
                        tone={GROUP_TONE[group.title]}
                        open={openId === item.id}
                        onToggle={() =>
                          setOpenId(openId === item.id ? null : item.id)
                        }
                      />
                      {!(
                        gi === filteredGroups.length - 1 &&
                        qi === group.questions.length - 1
                      ) && <s-divider />}
                    </div>
                  ))}
                </div>
              ))
            ) : (
              <s-box padding="large-500">
                <s-stack direction="block" gap="small" alignItems="center">
                  <s-icon type="search" color="subdued" />
                  <s-text type="strong">
                    No results for &quot;{query}&quot;
                  </s-text>
                  <s-text color="subdued">
                    Try a different word, or just ask us directly.
                  </s-text>
                  <div style={{ marginTop: 4 }}>
                    <s-button variant="tertiary" onClick={contactSupport}>
                      Contact support
                    </s-button>
                  </div>
                </s-stack>
              </s-box>
            )}
          </s-section>

          <s-stack direction="block" gap="base">
            <s-section heading="Support">
              <s-stack direction="block" gap="small">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "var(--p-color-bg-fill-success, #29845a)",
                      flex: "none",
                    }}
                  />
                  <s-text color="subdued">Support by email</s-text>
                </div>
                <KeyValueRows
                  rows={[
                    { label: "Contact method", value: "Email" },
                    { label: "Languages", value: "English, Français" },
                  ]}
                />
                <div style={{ marginTop: 4 }}>
                  <s-button
                    variant="secondary"
                    inlineSize="fill"
                    onClick={contactSupport}
                  >
                    Contact support
                  </s-button>
                </div>
              </s-stack>
            </s-section>

            <s-section heading="Start over">
              <s-stack direction="block" gap="small">
                <s-text color="subdued">
                  Re-run the two-question setup — nothing changes until you
                  confirm.
                </s-text>
                <Link to="/app/onboarding">
                  <s-button variant="secondary" inlineSize="fill">
                    Run guided setup again
                  </s-button>
                </Link>
              </s-stack>
            </s-section>

            <s-section>
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-box background="subdued" borderRadius="base" padding="small-200">
                      <s-icon type="email" color="base"></s-icon>
                    </s-box>
                    <s-heading>{t["help.contactSupport.title"]}</s-heading>
                  </s-stack>
                  <s-badge tone="info">{t["help.contactSupport.badge"]}</s-badge>
                </s-stack>

                <s-text color="subdued">{t["help.contactSupport.body"]}</s-text>

                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{t["help.contactSupport.listHeading"]}</s-text>
                  <s-unordered-list>
                    <s-list-item>
                      <s-text color="subdued">{t["help.contactSupport.listItem1"]}</s-text>
                    </s-list-item>
                    <s-list-item>
                      <s-text color="subdued">{t["help.contactSupport.listItem2"]}</s-text>
                    </s-list-item>
                    <s-list-item>
                      <s-text color="subdued">{t["help.contactSupport.listItem3"]}</s-text>
                    </s-list-item>
                  </s-unordered-list>
                </s-stack>

                <s-stack direction="inline" gap="small">
                  <s-button variant="primary" href="mailto:team@mapetitecoree.com">
                    {t["help.contactSupport.emailButton"]}
                  </s-button>
                  <s-button onClick={copyDetails}>
                    {t["help.contactSupport.copyButton"]}
                  </s-button>
                </s-stack>
              </s-stack>
            </s-section>
          </s-stack>
        </div>
      </s-stack>

      <style>{`
        @media (max-width: 820px) {
          .shuffly-help-grid { grid-template-columns: 1fr !important; }
          .shuffly-help-tiles { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </s-page>
  );
}

function QuestionRow({
  item,
  tone,
  open,
  onToggle,
}: {
  item: Question;
  tone: Tone;
  open: boolean;
  onToggle: () => void;
}) {
  const tokens = TONE_TOKENS[tone];
  return (
    <s-clickable onClick={onToggle} padding="none" accessibilityLabel={item.q}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: tokens.tint,
            display: "grid",
            placeItems: "center",
            flex: "none",
          }}
        >
          <s-icon type="question-circle" tone={tone} size="small" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <s-text type="strong">{item.q}</s-text>
          {open && (
            <div style={{ marginTop: 4 }}>
              <s-text color="subdued">{item.a}</s-text>
            </div>
          )}
        </div>
        <div
          style={{
            flex: "none",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          <s-icon type="chevron-down" color="subdued" size="small" />
        </div>
      </div>
    </s-clickable>
  );
}
