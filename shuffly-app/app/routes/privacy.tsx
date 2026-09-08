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
// gives this page real Polaris web components without requiring an
// authenticated admin session, which this page must never require:
// reviewers and prospective merchants need to be able to read it before
// installing anything.
//
// v3: fixes the v2 pass — dark-on-dark contrast bug on the hero card,
// restores Settings' full card pattern (tinted icon + colored top border,
// one tone per section — v2 had flattened these to neutral grey), makes
// section titles dominant, and adds a thin orange rule under each title as
// the one small brand touch. Still no loader/async data, so still nothing
// that can shift in after first paint.
const LAST_UPDATED = "September 1, 2026";
const SUPPORT_EMAIL = "team@mapetitecoree.com";
// Same value as shopify.app.toml's application_url. Hardcoded rather than
// read from a loader (which this static page otherwise has no need for) —
// update this if the app ever moves off the "dev" domain.

type Tone = "success" | "warning" | "info";

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
};

// The three mandatory compliance webhooks — same facts as
// app/routes/webhooks.compliance.tsx, restated here for merchants/reviewers
// rather than left to a code comment only they can't see.
const WEBHOOKS: Array<{ topic: string; description: string }> = [
  {
    topic: "customers/data_request",
    description:
      "Sent if a customer asks a merchant for their data. Shuffly never stores customer data, so there is nothing to export — Shuffly acknowledges the request.",
  },
  {
    topic: "customers/redact",
    description:
      "Sent when a customer's data must be erased. Same as above — Shuffly holds no customer records to redact, and acknowledges the request.",
  },
  {
    topic: "shop/redact",
    description:
      "Shopify sends this 48 hours after a shop uninstalls Shuffly. On receipt, Shuffly hard-deletes every stored row for that shop, including configuration, settings, sessions, and run history.",
  },
];

const STORES: Array<{ what: string; why: string }> = [
  {
    what: "Shop domain, timezone, and authenticated app session data (which can include staff name and email)",
    why: "So the app can authenticate the shop and run schedules at the right local time.",
  },
  {
    what: "Which collections you've added, and how (pin count, toggles, schedule)",
    why: "So Shuffly knows what to shuffle and when, and remembers your settings between visits.",
  },
  {
    what: "A rolling history of shuffle runs",
    why: "Powers the Activity screen and Undo.",
  },
  {
    what: "Operational logs such as shop domain, webhook status, and error diagnostics",
    why: "Used to secure, operate, and troubleshoot the service.",
  },
];

export default function Privacy() {
  return (
    <AppProvider embedded={false}>
      <s-page heading="Privacy">
        {/* Assumption: `breadcrumb-actions` is the slot name for Page's
            `breadcrumbActions` prop — inferred from the primary-action/
            secondary-actions convention used elsewhere in this app. */}
        <s-link slot="breadcrumb-actions" href="/app">
          Shuffly
        </s-link>

        <div style={{ marginTop: -8, marginBottom: 16 }}>
          <s-text color="subdued">Last updated {LAST_UPDATED}</s-text>
        </div>

        {/* Max content width — long lines on a wide monitor are exactly the
            "wall of text" feeling this page keeps getting flagged for. */}
        <div style={{ maxWidth: 800 }}>
          <s-stack direction="block" gap="large">
            <HeroCard>
              <HeroHeading>At a glance</HeroHeading>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 20,
                  margin: "18px 0 20px",
                }}
              >
                <Stat value="3" label="API scopes used" />
                <Stat value="0" label="Customer or order records stored" />
                <Stat value="48 hrs" label="Until Shopify sends the shop deletion request" />
              </div>
              {/* Plain <p>, not <s-paragraph> — Polaris's text components
                  default to a dark, light-surface text color regardless of
                  surrounding background, which is exactly what made this
                  copy unreadable here. Explicit white instead (measured
                  17.1:1 against #1F1B18 — see PR notes). */}
              <p style={{ margin: 0, color: "#FFFFFF", fontSize: 15, lineHeight: 1.65 }}>
                Shuffly requests three Shopify Admin API scopes: <Code>read_products</Code>,{" "}
                <Code>write_products</Code>, and <Code>read_inventory</Code>. They are used to
                read products and collections, set product positions in collections you choose,
                and react when inventory changes. Shuffly never requests customer data, order
                data, or access to your storefront theme.
              </p>
            </HeroCard>

            <SectionCard icon="list-bulleted" tone="info" title="What Shuffly stores">
              <WhatWhyTable rows={STORES} />
              <p style={{ marginTop: 16, marginBottom: 0 }}>
                <s-text color="subdued">
                  We don&apos;t store product content beyond what&apos;s needed to display it
                  inside the app, and we never store customer or order information.
                </s-text>
              </p>
            </SectionCard>

            <SectionCard icon="shield-check-mark" tone="success" title="Data retention &amp; compliance">
              <s-paragraph>
                Shopify sends Shuffly a shop-deletion request 48 hours after uninstall. Shuffly
                deletes the shop&apos;s stored app data when that request arrives. Your collections
                keep whatever order they had at uninstall — Shuffly does not revert anything.
              </s-paragraph>

              <div style={{ marginTop: 24 }}>
                <SubHeading>The three compliance webhooks Shuffly handles</SubHeading>
                <div
                  style={{
                    marginTop: 12,
                    background: "var(--p-color-bg-fill-secondary, #F6F6F7)",
                    borderRadius: 8,
                    padding: 4,
                  }}
                >
                  {WEBHOOKS.map((w, i) => (
                    <div
                      key={w.topic}
                      style={{
                        padding: "14px 16px",
                        borderLeft: "3px solid var(--p-color-border, #c9c9c9)",
                        borderTop: i > 0 ? "1px solid var(--p-color-border-secondary, #e3e3e3)" : undefined,
                      }}
                    >
                      <div style={{ marginBottom: 6 }}>
                        <Code>{w.topic}</Code>
                      </div>
                      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
                        <s-text color="subdued">{w.description}</s-text>
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </SectionCard>

            <SectionCard icon="chat" tone="warning" title="Third parties &amp; contact">
              <s-paragraph>
                Shuffly does not sell your store&apos;s data. Shopify and the infrastructure used
                to operate Shuffly process data only as needed to provide the service. Billing
                is handled through Shopify&apos;s Billing API — Shuffly never sees your payment
                details.
              </s-paragraph>
              <p style={{ marginTop: 12, marginBottom: 0 }}>
                Questions about this policy or your data? Write to{" "}
                <s-link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</s-link>.
              </p>
            </SectionCard>

            <p style={{ textAlign: "center", margin: "4px 0 8px" }}>
              <s-text color="subdued">
                Share this policy outside Shopify Admin:{" "}
                <s-link href="/privacy" target="_blank">
                  Open the public policy
                </s-link>
              </s-text>
            </p>
          </s-stack>
        </div>
      </s-page>
    </AppProvider>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      {/* Brand orange on #1F1B18 measures 5.11:1 — clears even the 4.5:1
          body-text threshold, not just the 3:1 large-text one. */}
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: "#FF4B1F" }}>{value}</div>
      {/* rgba(255,255,255,0.85) over #1F1B18 measures ~12.6:1 — comfortably
          clear of 4.5:1. */}
      <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.4, color: "rgba(255,255,255,0.85)" }}>
        {label}
      </div>
    </div>
  );
}

/** Always dark text on its own light chip, regardless of what it's placed
 * inside — doesn't inherit color from context on purpose, so it stays
 * legible (measured ~16.7:1) whether it's sitting in a light card or inside
 * the white hero paragraph above. */
function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        padding: "0.2em 0.5em",
        background: "#F1F1F1",
        border: "1px solid #E3E3E3",
        borderRadius: 5,
        color: "#131110",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "0.95em",
      }}
    >
      {children}
    </code>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--p-color-text-secondary, #6b6b6b)",
      }}
    >
      {children}
    </div>
  );
}

/** Bold, white, deliberately plain (not <s-heading>, for the same reason
 * Code and the hero paragraph avoid Polaris text components on this dark
 * surface) — the section title the hero card was missing after v2 merged
 * "At a glance" and "What Shuffly accesses" together. */
function HeroHeading({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: "50%", background: "#FF4B1F", flex: "none" }}
      />
      {/* Orange on #1F1B18 measures 5.11:1 — clears the 4.5:1 body-text
          threshold even at this size/weight. */}
      <span style={{ fontSize: 17, fontWeight: 700, color: "#FF4B1F", letterSpacing: "0.01em" }}>
        {children}
      </span>
    </div>
  );
}

/** Two generously-spaced, left-aligned columns instead of Settings'
 * right-aligned label/value rows — those read badly once "value" is a
 * sentence-length explanation rather than a short fact. */
function WhatWhyTable({ rows }: { rows: Array<{ what: string; why: string }> }) {
  const headerStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--p-color-text-secondary, #6b6b6b)",
    paddingBottom: 10,
    borderBottom: "1px solid var(--p-color-border, #e3e3e3)",
  };
  const cellStyle: React.CSSProperties = {
    padding: "16px 0",
    borderBottom: "1px solid var(--p-color-border-secondary, #f1f1f1)",
    fontSize: 15,
    lineHeight: 1.6,
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "0 24px" }}>
      <div style={headerStyle}>What</div>
      <div style={headerStyle}>Why</div>
      {rows.map((r) => (
        <Fragment key={r.what}>
          <div style={{ ...cellStyle, fontWeight: 600, color: "var(--p-color-text, #131110)" }}>
            {r.what}
          </div>
          <div style={{ ...cellStyle, color: "var(--p-color-text-secondary, #6b6b6b)" }}>
            {r.why}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** The one card that carries the brand accent — a near-black surface (same
 * tone used for the Plan page's "most popular" tile) framed in a soft
 * orange outline/glow, with a faint orange radial wash in the corner (same
 * gradient recipe as the landing page's hero glow, just much quieter) —
 * black-with-orange rather than a thin colored stripe, so it actually reads
 * as a hero rather than one more bordered box in a row of them. */
function HeroCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        background:
          "radial-gradient(circle at 100% 0%, rgba(255,75,31,0.16), transparent 55%), #1F1B18",
        border: "1px solid rgba(255,75,31,0.35)",
        borderRadius: 16,
        padding: "28px 28px 24px",
        boxShadow: "0 0 0 1px rgba(255,75,31,0.08), 0 8px 24px rgba(0,0,0,0.18)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/** Every section card below the hero: the full Settings pattern this
 * page's last pass only half-applied — a tinted icon chip AND a 3px
 * tone-colored top border, one tone per section (not the flat neutral grey
 * v2 had). The title is a plain bold element sized clearly larger than
 * body copy (not <s-heading>, whose default weight read too quiet next to
 * 15px body text), with a short orange rule underneath as the one
 * restrained brand touch every section gets regardless of its own tone. */
function SectionCard({
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
        borderRadius: 16,
        boxShadow: "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
        overflow: "hidden",
      }}
    >
      <div
        aria-hidden="true"
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: tokens.accent }}
      />
      <div style={{ padding: "28px 28px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <div
            aria-hidden="true"
            style={{
              width: 36,
              height: 36,
              flex: "0 0 auto",
              borderRadius: 9,
              background: tokens.tint,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <s-icon type={icon} tone={tone}></s-icon>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--p-color-text, #131110)" }}>
            {title}
          </div>
        </div>
        <div style={{ width: 28, height: 2, background: "#FF4B1F", marginBottom: 18 }} aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}
