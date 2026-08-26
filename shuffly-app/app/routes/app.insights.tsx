import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  data,
  useLoaderData,
  useNavigate,
  useNavigation,
  useFetcher,
  Link,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import {
  computeInsights,
  boostProductsForNextRun,
  type InsightsData,
  type InsightsByCollectionRow,
  type InsightsNeverSeenRow,
  type InsightsRange,
} from "../lib/insights.server";

const VALID_RANGES: InsightsRange[] = ["30d", "90d", "install"];
const MIN_DAYS_FOR_CONFIDENCE = 7;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const requested = url.searchParams.get("range");
  const range: InsightsRange = VALID_RANGES.includes(requested as InsightsRange)
    ? (requested as InsightsRange)
    : "30d";

  const settings = await getOrCreateShopSettings(admin, shop);

  try {
    const insights = await computeInsights(shop, range, settings.createdAt);
    return { range, insights, error: null as string | null };
  } catch {
    return {
      range,
      insights: null as InsightsData | null,
      error: "Couldn't load Insights just now. Try refreshing.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("_action");

  if (actionType === "boost-never-seen") {
    const items = formData
      .getAll("item")
      .map((raw) => {
        const [productGid, collectionId] = String(raw).split("|");
        return { productGid, collectionId };
      })
      .filter((i) => i.productGid && i.collectionId);
    const count = await boostProductsForNextRun(shop, items);
    return data({ ok: true, count });
  }

  return data({ ok: false }, { status: 400 });
};

export default function Insights() {
  const { range, insights, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const boostFetcher = useFetcher<{ ok: boolean; count?: number }>();

  const isLoading =
    navigation.state === "loading" &&
    navigation.location?.pathname === "/app/insights" &&
    new URLSearchParams(navigation.location.search).get("range") !== range;

  useEffect(() => {
    if (boostFetcher.state === "idle" && boostFetcher.data) {
      if (boostFetcher.data.ok) {
        const n = boostFetcher.data.count ?? 0;
        shopify.toast.show(
          `${n} product${n === 1 ? "" : "s"} will lead ${n === 1 ? "its" : "their"} collection's next run`,
        );
      } else {
        shopify.toast.show("Couldn't do that just now", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [boostFetcher.state, boostFetcher.data]);

  function putTheseFirst() {
    if (!insights || insights.neverSeen.length === 0) return;
    boostFetcher.submit(
      {
        _action: "boost-never-seen",
        item: insights.neverSeen.map(
          (n) => `${n.productGid}|${n.collectionId}`,
        ),
      },
      { method: "post" },
    );
  }

  const showYoungHistoryBanner =
    !error &&
    !!insights?.hasHistory &&
    insights.daysOfHistory < MIN_DAYS_FOR_CONFIDENCE;

  return (
    <s-page heading="Insights" inlineSize="large">
      <s-box slot="secondary-actions" inlineSize="180px">
        <s-select
          label="Date range"
          labelAccessibilityVisibility="exclusive"
          value={range}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
          onChange={(e: any) =>
            navigate(`?range=${e.currentTarget?.value ?? "30d"}`)
          }
        >
          <s-option value="30d">Last 30 days</s-option>
          <s-option value="90d">Last 90 days</s-option>
          <s-option value="install">Since install</s-option>
        </s-select>
      </s-box>

      <s-text color="subdued">
        How much of your catalogue customers are actually seeing.
      </s-text>

      {error && <s-banner tone="critical">{error}</s-banner>}

      {showYoungHistoryBanner && (
        <s-banner tone="info">
          These numbers get more useful after a week of runs.
        </s-banner>
      )}

      {isLoading ? (
        <InsightsSkeleton />
      ) : error ? null : !insights || !insights.hasHistory ? (
        <EmptyInsightsState />
      ) : (
        <div>
          <div className="shuffly-stat-grid" style={{ marginBottom: 16 }}>
            <StatTile
              tone={coverageTone(insights.page1Pct)}
              icon="view"
              label="Products seen on page 1"
              value={`${insights.page1Pct}%`}
              sub={<DeltaLine pts={insights.page1DeltaPts} />}
            />
            <StatTile
              tone={soldOutTone(insights.soldOutTop20Mean)}
              icon="alert-triangle"
              label="Sold-out sitting near the top"
              value={String(insights.soldOutTop20Mean)}
              sub={
                <SoldOutSub
                  current={insights.soldOutTop20Mean}
                  baseline={insights.soldOutTop20Baseline}
                />
              }
            />
            <StatTile
              tone="info"
              icon="arrow-up"
              label="New to the top 20"
              value={String(insights.firstTop20Count)}
              sub={
                <s-text color="subdued">
                  {insights.firstTop20Count} product
                  {insights.firstTop20Count === 1 ? "" : "s"} reached it for the
                  first time
                </s-text>
              }
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <s-section>
              <ByCollectionCard
                byCollection={insights.byCollection}
                suggestion={insights.suggestion}
              />
            </s-section>
          </div>

          <s-section>
            <NeverSeenBody
              neverSeen={insights.neverSeen}
              onBoost={putTheseFirst}
              boosting={boostFetcher.state !== "idle"}
            />
          </s-section>
        </div>
      )}

      <s-box paddingBlockEnd="large-500"></s-box>

      <style>{`
        .shuffly-stat-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          align-items: stretch;
          gap: 16px;
          width: 100%;
        }
        @media (max-width: 820px) {
          .shuffly-stat-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </s-page>
  );
}

// ============================== stat tiles ==============================

type Tone = "success" | "warning" | "critical" | "info";

/** Every color a tile can show, sourced from Polaris design tokens — the hex
 * after each token is a same-hue fallback only, never the source of truth. */
const TONE_TOKENS: Record<Tone, { accent: string; tint: string }> = {
  success: {
    accent: "var(--p-color-icon-success, #008060)",
    tint: "var(--p-color-bg-fill-success-secondary, #E3F5EE)",
  },
  warning: {
    accent: "var(--p-color-icon-warning, #FF4B1F)",
    tint: "var(--p-color-bg-fill-warning-secondary, #FFF1E4)",
  },
  critical: {
    accent: "var(--p-color-icon-critical, #D72C0D)",
    tint: "var(--p-color-bg-fill-critical-secondary, #FBEAE5)",
  },
  info: {
    accent: "var(--p-color-icon-info, #1F5199)",
    tint: "var(--p-color-bg-fill-info-secondary, #EAF2FF)",
  },
};

/** ≥60% is healthy, 30–59% needs a look, below that is a real problem. */
function coverageTone(pct: number): Tone {
  if (pct >= 60) return "success";
  if (pct >= 30) return "warning";
  return "critical";
}

/** Sold-out-near-the-top is a count where lower is always better — zero is
 * the only "nothing to see here" state. */
function soldOutTone(count: number): Tone {
  if (count === 0) return "success";
  if (count <= 5) return "warning";
  return "critical";
}

function StatTile({
  tone,
  icon,
  label,
  value,
  sub,
}: {
  tone: Tone;
  icon: "view" | "alert-triangle" | "arrow-up";
  label: string;
  value: string;
  sub: React.ReactNode;
}) {
  const tokens = TONE_TOKENS[tone];
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        minHeight: 148,
        background: "var(--p-color-bg-surface, #ffffff)",
        border: "1px solid var(--p-color-border, #e3e3e3)",
        borderRadius: 12,
        boxShadow: "var(--p-shadow-100, 0 1px 2px rgba(23, 24, 24, 0.07))",
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
          marginBottom: 12,
        }}
      >
        <s-icon type={icon} tone={tone}></s-icon>
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "var(--p-color-text-subdued, #6b7177)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 700,
          lineHeight: 1.15,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, marginTop: 6 }}>{sub}</div>
    </div>
  );
}

/** Rules: positive -> green pill with an up-arrow, negative -> red pill with
 * a down-arrow, exactly zero -> grey pill and no misleading "▲ 0". The pill
 * always carries the arrow and the words too — color is never the only
 * signal. */
function DeltaLine({ pts }: { pts: number }) {
  if (pts === 0) {
    return (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-badge>No change yet</s-badge>
      </s-stack>
    );
  }
  const isUp = pts > 0;
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-badge tone={isUp ? "success" : "critical"}>
        {isUp ? "▲" : "▼"} {Math.abs(pts)} pts
      </s-badge>
      <s-text color="subdued">since install</s-text>
    </s-stack>
  );
}

function SoldOutSub({
  current,
  baseline,
}: {
  current: number;
  baseline: number | null;
}) {
  if (baseline == null) return null;
  if (current < baseline) {
    return (
      <s-text color="subdued">Down from {baseline} a day before install</s-text>
    );
  }
  if (current > baseline) {
    return (
      <s-text color="subdued">Up from {baseline} a day before install</s-text>
    );
  }
  // current === baseline: state the number plainly rather than an
  // unqualified "Same as..." that reads like a rendering bug.
  return <s-text color="subdued">{baseline} a day before install</s-text>;
}

// ============================== by collection ==============================

/** "shuffles daily at 06:00" / "shuffles weekly, Monday" / "paused" / etc. —
 * the same schedule vocabulary Collections uses, phrased for a meta line. */
function scheduleLine(c: InsightsByCollectionRow): string {
  if (c.status === "PAUSED") return "paused";
  switch (c.scheduleType) {
    case "DAILY":
      return `shuffles daily at ${c.scheduleTime}`;
    case "TWICE_DAILY":
      return "shuffles twice daily";
    case "WEEKLY":
      return `shuffles weekly, ${WEEKDAYS[c.scheduleWeekday ?? 1]}`;
    default:
      return "shuffles only when you press Shuffle";
  }
}

function ByCollectionCard({
  byCollection,
  suggestion,
}: {
  byCollection: InsightsByCollectionRow[];
  suggestion: InsightsData["suggestion"];
}) {
  const trackedCount = byCollection.length;
  const sorted = [...byCollection].sort((a, b) => b.pct - a.pct);

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <s-heading>By collection</s-heading>
        <s-text color="subdued">
          {trackedCount} collection{trackedCount === 1 ? "" : "s"}
        </s-text>
      </div>

      <div style={{ marginTop: 16 }}>
        {trackedCount === 0 ? (
          <s-paragraph color="subdued">
            Add a collection to start seeing this.
          </s-paragraph>
        ) : (
          <div>
            {sorted.map((c, i) => (
              <div
                key={c.id}
                style={{ marginBottom: i < sorted.length - 1 ? 20 : 0 }}
              >
                <CollectionBarRow collection={c} />
                {i < sorted.length - 1 && (
                  <div style={{ marginTop: 20 }}>
                    <s-divider />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ByCollectionFooter trackedCount={trackedCount} suggestion={suggestion} />
    </>
  );
}

function CollectionBarRow({
  collection: c,
}: {
  collection: InsightsByCollectionRow;
}) {
  const tone = coverageTone(c.pct);
  const meta = `${c.productCount} product${c.productCount === 1 ? "" : "s"} · ${scheduleLine(c)} · ${c.seenCount} seen · ${c.neverSeenCount} never seen`;

  return (
    <Link
      to={`/app/collections/${c.id}`}
      style={{ display: "block", color: "inherit", textDecoration: "none" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <s-text type="strong">{c.title}</s-text>
        <div style={{ fontVariantNumeric: "tabular-nums" }}>
          <s-text type="strong">{c.pct}%</s-text>
        </div>
      </div>
      <div
        style={{
          marginTop: 6,
          height: 8,
          borderRadius: 999,
          background: "var(--p-color-border, #cdcdcd)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.max(0, Math.min(100, c.pct))}%`,
            borderRadius: 999,
            background: TONE_TOKENS[tone].accent,
            transition: "width 300ms ease",
          }}
        />
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 12,
          color: "var(--p-color-text-subdued, #6b7177)",
        }}
      >
        {meta}
      </div>
    </Link>
  );
}

function ByCollectionFooter({
  trackedCount,
  suggestion,
}: {
  trackedCount: number;
  suggestion: InsightsData["suggestion"];
}) {
  if (trackedCount === 1) {
    return (
      <FooterStrip>
        <s-text color="subdued">Compare more collections</s-text>
        <Link to="/app/collections">
          <s-button>Add collection</s-button>
        </Link>
      </FooterStrip>
    );
  }

  if (suggestion) {
    return (
      <FooterStrip>
        <s-text color="subdued">
          {suggestion.title} only shuffles weekly — switch it to daily to lift
          this.
        </s-text>
        <Link to={`/app/collections/${suggestion.collectionId}`}>
          <s-button>Change it</s-button>
        </Link>
      </FooterStrip>
    );
  }

  // Nothing useful to say — no filler footer.
  return null;
}

function FooterStrip({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 16,
        borderTop: "1px solid var(--p-color-border, #e3e3e3)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

// ============================== still never seen ==============================

function NeverSeenBody({
  neverSeen,
  onBoost,
  boosting,
}: {
  neverSeen: InsightsNeverSeenRow[];
  onBoost: () => void;
  boosting: boolean;
}) {
  const isEmpty = neverSeen.length === 0;

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <s-heading>Still never seen</s-heading>
        {!isEmpty && (
          <s-badge>
            {neverSeen.length} product{neverSeen.length === 1 ? "" : "s"}
          </s-badge>
        )}
      </div>

      {isEmpty ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            paddingTop: 24,
            paddingBottom: 8,
          }}
        >
          <s-icon type="check-circle" tone="success"></s-icon>
          <div style={{ marginTop: 8 }}>
            <s-heading>Everything has been seen</s-heading>
          </div>
          <div style={{ marginTop: 4 }}>
            <s-text color="subdued">
              Every product in your tracked collections reached page 1 in this
              range.
            </s-text>
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 12 }}>
            {neverSeen.map((n, i) => (
              <div
                key={n.productGid}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: i < neverSeen.length - 1 ? 14 : 0,
                }}
              >
                <s-text>{n.title}</s-text>
                <s-text color="subdued">{n.label}</s-text>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <s-button
              onClick={onBoost}
              {...(boosting ? { loading: true } : {})}
            >
              Put these first tomorrow
            </s-button>
          </div>
        </>
      )}
    </>
  );
}

// ============================== empty / loading states ==============================

function EmptyInsightsState() {
  return (
    <s-section padding="none">
      <s-box padding="large-500">
        <s-stack direction="block" gap="small" alignItems="center">
          <s-icon type="chart-histogram-growth" color="subdued"></s-icon>
          <s-heading>Nothing to measure yet</s-heading>
          <s-text color="subdued">
            Shuffly needs a few days of runs before these numbers mean anything.
          </s-text>
          <div style={{ marginTop: 4 }}>
            <Link to="/app/collections">
              <s-button variant="primary">Go to Collections</s-button>
            </Link>
          </div>
        </s-stack>
      </s-box>
    </s-section>
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

function InsightsSkeleton() {
  return (
    <>
      <div className="shuffly-stat-grid" style={{ marginBottom: 16 }}>
        {[0, 1, 2].map((i) => (
          <s-box key={i} padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <Bar width={140} />
              <Bar width={70} />
              <Bar width={100} />
            </s-stack>
          </s-box>
        ))}
      </div>
      <s-section heading="By collection">
        <s-stack direction="block" gap="large">
          {[0, 1, 2, 3].map((i) => (
            <s-stack key={i} direction="block" gap="small-200">
              <Bar width={160} />
              <div
                style={{
                  height: 10,
                  borderRadius: 999,
                  background: "var(--p-color-bg-surface-tertiary, #ebebeb)",
                }}
              />
            </s-stack>
          ))}
        </s-stack>
      </s-section>
    </>
  );
}
