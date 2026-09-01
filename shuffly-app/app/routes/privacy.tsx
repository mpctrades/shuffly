import { Fragment } from "react";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

// Public, unauthenticated page — required for the Shopify App Store listing,
// and also what a merchant sees reaching it from inside Shopify Admin (e.g.
// .../apps/shuffly/privacy) either before or after installing. No loader:
// every word here is static, so there is no loading state to skeleton and
// nothing that can shift in after first paint — deliberate, given the app's
// live CLS investigation is already over budget (see AUDIT.md).
//
// AppProvider embedded={false} (same approach /auth/login already uses)
// gives this page real Polaris web components — the same card shell used on
// Settings/Insights/Help — without requiring an authenticated admin
// session, which this page must never require: reviewers and prospective
// merchants need to be able to read it before installing anything.
const LAST_UPDATED = "September 1, 2026";
const SUPPORT_EMAIL = "support@mpctrades.com";

type Tone = "success" | "warning" | "info" | "neutral";

// Same token family as Settings/Insights/Help/Plan — every value is a
// Polaris token, the hex after each is a same-hue fallback only, never the
// source of truth. Duplicated per-file rather than shared, matching how
// every other card-based page in this app already does it.
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

// The three mandatory compliance webhooks — same facts as
// app/routes/webhooks.compliance.tsx, restated here for merchants/reviewers
// rather than left to a code comment only they can't see.
const WEBHOOKS: Array<{ topic: string; description: string }> = [
  {
    topic: "customers/data_request",
    description:
      "Sent if a customer asks a merchant for their data. Shuffly never stores customer data (see “What Shuffly stores” below), so there is nothing to export — Shuffly acknowledges the request and logs it.",
  },
  {
    topic: "customers/redact",
    description:
      "Sent when a customer's data must be erased. Same as above — Shuffly holds no customer records to redact, and acknowledges the request.",
  },
  {
    topic: "shop/redact",
    description:
      "Sent after a shop uninstalls Shuffly. This is the one with real work to do: it hard-deletes every row Shuffly stored for that shop — collection configuration, settings, and run history — which is what backs the “deleted within 48 hours” promise below.",
  },
];

export default function Privacy() {
  return (
    <AppProvider embedded={false}>
      <s-page heading="Privacy">
        {/* Assumption: `breadcrumb-actions` is the slot name for Page's
            `breadcrumbActions` prop (documented as "link elements", same
            slot mechanism as `primary-action`/`secondary-actions` used
            elsewhere in this app) — unverified against a live render, since
            no other page in this app uses a breadcrumb yet. Worth a visual
            check once deployed. */}
        <s-link slot="breadcrumb-actions" href="/app">
          Shuffly
        </s-link>

        {/* `subheading` isn't in the generated React prop type for s-page
            (only `heading`/`inlineSize` are) — rendered as a plain subdued
            line instead of guessing at an unsupported/slot-only prop. */}
        <div style={{ marginTop: -8, marginBottom: 4 }}>
          <s-text color="subdued">Last updated {LAST_UPDATED}</s-text>
        </div>

        <s-stack direction="block" gap="base">
          <PrivacyCard icon="shield-person" tone="success" title="At a glance">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
              <Stat
                value="2 scopes"
                label={
                  <>
                    Just <Code>read_products</Code> + <Code>write_products</Code>
                  </>
                }
              />
              <Stat value="0" label="Customer or order records stored" />
              <Stat value="48 hrs" label="Until all shop data is deleted after uninstall" />
            </div>
          </PrivacyCard>

          <PrivacyCard icon="lock" tone="success" title="What Shuffly accesses">
            <s-paragraph>
              Shuffly requests two Shopify Admin API scopes: <Code>read_products</Code> and{" "}
              <Code>write_products</Code>. It uses these only to read your product catalogue and
              collections, and to set the position of products inside collections you&apos;ve
              chosen to have it manage. Shuffly does not request access to customer data, order
              data, or your storefront theme.
            </s-paragraph>
          </PrivacyCard>

          <PrivacyCard icon="list-bulleted" tone="info" title="What Shuffly stores">
            <WhatWhyTable
              rows={[
                {
                  what: "Shop domain, timezone, notification preferences",
                  why: "So schedules run at the right local time and reach the right inbox.",
                },
                {
                  what: "Which collections you've added, and how (pin count, toggles, schedule)",
                  why: "So Shuffly knows what to shuffle and when, and remembers your settings between visits.",
                },
                {
                  what: "A rolling history of shuffle runs",
                  why: "Powers the Activity screen and Undo.",
                },
              ]}
            />
            <CardFooterStrip>
              <s-text color="subdued">
                We do not store product content beyond what&apos;s needed to display it inside
                the app, and we never store customer or order information.
              </s-text>
            </CardFooterStrip>
          </PrivacyCard>

          <PrivacyCard icon="calendar" tone="warning" title="Data retention and deletion">
            <s-paragraph>
              If you uninstall Shuffly, all data associated with your shop is deleted within 48
              hours. Your collections keep whatever order they had at the time of uninstall —
              Shuffly does not revert anything.
            </s-paragraph>
          </PrivacyCard>

          <PrivacyCard icon="shield-check-mark" tone="info" title="Compliance webhooks">
            <s-stack direction="block" gap="base">
              {WEBHOOKS.map((w, i) => (
                <div key={w.topic}>
                  <div style={{ marginBottom: 4 }}>
                    <Code>{w.topic}</Code>
                  </div>
                  <s-text color="subdued">{w.description}</s-text>
                  {i < WEBHOOKS.length - 1 && (
                    <div style={{ marginTop: 12 }}>
                      <s-divider />
                    </div>
                  )}
                </div>
              ))}
            </s-stack>
          </PrivacyCard>

          <PrivacyCard icon="globe" tone="neutral" title="Third parties">
            <s-paragraph>
              Shuffly does not sell or share your store&apos;s data with third parties. Billing
              is handled entirely through Shopify&apos;s Billing API — Shuffly never sees your
              payment details.
            </s-paragraph>
          </PrivacyCard>

          <PrivacyCard icon="email" tone="neutral" title="Contact">
            <s-paragraph>
              Questions about this policy or your data:{" "}
              <s-link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</s-link>.
            </s-paragraph>
          </PrivacyCard>
        </s-stack>
      </s-page>
    </AppProvider>
  );
}

function Stat({ value, label }: { value: string; label: React.ReactNode }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: "var(--p-color-text, #131110)" }}>
        {value}
      </div>
      <div style={{ marginTop: 4, fontSize: 12 }}>
        <s-text color="subdued">{label}</s-text>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        padding: "0.1em 0.4em",
        background: "var(--p-color-bg-surface-secondary, #f1f1f1)",
        border: "1px solid var(--p-color-border-secondary, #e3e3e3)",
        borderRadius: 4,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "0.85em",
      }}
    >
      {children}
    </code>
  );
}

/** A minimal what/why table — Settings' label/value KeyValueRows right-
 * aligns its value, which reads badly once "value" is a sentence-length
 * explanation rather than a short fact. Two left-aligned columns with a
 * header row instead, same border/spacing tokens as the rest of the app. */
function WhatWhyTable({ rows }: { rows: Array<{ what: string; why: string }> }) {
  const headerStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--p-color-text-secondary, #6b6b6b)",
    paddingBottom: 6,
    borderBottom: "1px solid var(--p-color-border, #e3e3e3)",
  };
  const cellStyle: React.CSSProperties = {
    padding: "10px 0",
    borderBottom: "1px solid var(--p-color-border-secondary, #f1f1f1)",
    fontSize: 14,
    lineHeight: 1.5,
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
      <div style={headerStyle}>What</div>
      <div style={headerStyle}>Why</div>
      {rows.map((r) => (
        <Fragment key={r.what}>
          <div style={{ ...cellStyle, color: "var(--p-color-text, #131110)" }}>{r.what}</div>
          <div style={{ ...cellStyle, color: "var(--p-color-text-secondary, #6b6b6b)" }}>
            {r.why}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** The grey strip along the bottom of a card — same pattern as Settings'
 * CardFooterStrip. */
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

/** The card shell shared by every card on this page — identical to
 * Settings'/Insights'/Help's SettingsCard: white surface, 1px border, 12px
 * radius, subtle shadow, a 3px accent bar on top, and a 32px icon chip
 * beside the heading. Kept as a local copy rather than importing from
 * app.settings.tsx, matching this app's existing per-file convention for
 * this exact shape (see TONE_TOKENS above). */
function PrivacyCard({
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
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
