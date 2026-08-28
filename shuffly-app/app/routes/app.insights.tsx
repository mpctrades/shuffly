import { Fragment, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useNavigate, useNavigation, useFetcher, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { fetchProductThumbnails } from "../lib/collections.server";
import {
  computeInsights,
  boostProductsForNextRun,
  invalidateInsightsCache,
  type InsightsData,
  type InsightsRange,
  type InsightsTile,
  type InsightsWaitingRow,
} from "../lib/insights.server";

const VALID_RANGES: InsightsRange[] = ["7d", "30d", "install"];
const RANGE_LABELS: Record<InsightsRange, string> = { "7d": "7 days", "30d": "30 days", install: "Since install" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const requested = url.searchParams.get("range");
  const range: InsightsRange = VALID_RANGES.includes(requested as InsightsRange) ? (requested as InsightsRange) : "30d";

  const settings = await getOrCreateShopSettings(admin, shop);

  try {
    const insights = await computeInsights(shop, range, settings.timezone, settings.pageSize, settings.createdAt);
    // A small, bounded (<=5) live lookup for "Waiting longest"'s
    // thumbnails — the only place on this page that needs a real Shopify
    // call, and one batched request regardless of how many rows there are.
    const thumbsByGid = insights.waitingLongest.length
      ? await fetchProductThumbnails(admin, insights.waitingLongest.map((n) => n.productGid))
      : new Map<string, { title: string; imageUrl: string | null }>();
    const waitingLongest = insights.waitingLongest.map((n) => ({ ...n, imageUrl: thumbsByGid.get(n.productGid)?.imageUrl ?? null }));
    return { range, insights: { ...insights, waitingLongest }, error: null as string | null };
  } catch (err) {
    console.error("[app.insights] computeInsights failed:", err);
    return { range, insights: null as InsightsData | null, error: "Couldn't load Insights just now. Try refreshing." };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("_action");

  if (actionType === "put-these-first") {
    const items = formData
      .getAll("item")
      .map((raw) => {
        const [productGid, collectionId] = String(raw).split("|");
        return { productGid, collectionId };
      })
      .filter((i) => i.productGid && i.collectionId);
    const count = await boostProductsForNextRun(shop, items);
    invalidateInsightsCache(shop);
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

  const isLoading = navigation.state === "loading" && navigation.location?.pathname === "/app/insights" && new URLSearchParams(navigation.location.search).get("range") !== range;
  // Highlight the just-clicked pill immediately, before the navigation
  // commits — the alternative (waiting for the new range's data to land)
  // makes a click look like it did nothing for a beat, then jump.
  const pendingRange = isLoading ? (new URLSearchParams(navigation.location!.search).get("range") as InsightsRange | null) : null;
  const displayRange = pendingRange && VALID_RANGES.includes(pendingRange) ? pendingRange : range;

  useEffect(() => {
    if (boostFetcher.state === "idle" && boostFetcher.data) {
      if (boostFetcher.data.ok) {
        const n = boostFetcher.data.count ?? 0;
        shopify.toast.show(`${n} product${n === 1 ? "" : "s"} will lead ${n === 1 ? "its" : "their"} collection's next run`);
      } else {
        shopify.toast.show("Couldn't do that just now", { isError: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on fetcher settle
  }, [boostFetcher.state, boostFetcher.data]);

  const boosted = boostFetcher.state !== "idle" || (boostFetcher.data?.ok ?? false);

  function putTheseFirst() {
    if (!insights || insights.waitingLongest.length === 0) return;
    // Optimistic: the button shows "Boosting…" immediately via the
    // fetcher's own pending state, then a toast confirms once the real
    // write (and the loader's revalidation behind it) settles.
    boostFetcher.submit(
      { _action: "put-these-first", item: insights.waitingLongest.map((n) => `${n.productGid}|${n.collectionId}`) },
      { method: "post" },
    );
  }

  return (
    <s-page heading="Insights" inlineSize="large">
      {error && <s-banner tone="critical">{error}</s-banner>}

      <div className="shuffly-insights-page">
        {error ? (
          <div className="shuffly-insights-rangebar">
            <RangePicker range={displayRange} onChange={(r) => navigate(`?range=${r}`)} />
          </div>
        ) : !insights || !insights.hasHistory ? (
          <>
            <div className="shuffly-insights-rangebar">
              <RangePicker range={displayRange} onChange={(r) => navigate(`?range=${r}`)} />
            </div>
            <EmptyInsightsState />
          </>
        ) : (
          // Switching ranges never swaps this whole section for a
          // different skeleton layout — React Router keeps `insights` from
          // the previous range on screen while the new one loads, so the
          // strip (and the range picker inside it) stays exactly where it
          // is; only a soft dim signals a refresh is in flight.
          <div className={`shuffly-insights-stack${isLoading ? " shuffly-insights-stack--busy" : ""}`} aria-busy={isLoading || undefined}>
            <SummaryStrip insights={insights} range={displayRange} onRangeChange={(r) => navigate(`?range=${r}`)} />

            <div className="shuffly-insights-tiles">
              <Tile lead heading="Rotation fairness" tile={insights.rotationFairness} unit="/100" />
              <Tile heading="Typical wait" tile={insights.typicalWait} unit=" days" />
              <Tile
                heading="Longest wait"
                tile={insights.longestWait}
                unit=" days"
                detailOverride={insights.longestWaitProduct ?? undefined}
              />
              <Tile heading="Sold-out response" tile={insights.soldOutResponse} unit="s" />
            </div>

            <div className="shuffly-insights-columns">
              <DistributionCard insights={insights} />
              <WaitingLongestCard rows={insights.waitingLongest} onBoost={putTheseFirst} boosting={boosted} />
            </div>

            <WhoHadATurnCard insights={insights} />
          </div>
        )}
      </div>

      <s-box paddingBlockEnd="large-500"></s-box>

      <style>{`
        .shuffly-insights-page { max-width: 1040px; margin: 0 auto; }
        .shuffly-insights-rangebar {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 14px;
        }
        .shuffly-insights-range {
          display: inline-flex;
          padding: 3px;
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 999px;
          background: var(--p-color-bg-surface, #ffffff);
        }
        .shuffly-insights-range-btn {
          border: none;
          outline: none;
          background: transparent;
          border-radius: 999px;
          padding: 6px 14px;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          color: var(--p-color-text-secondary, #6b6b6b);
          cursor: pointer;
          transition: background-color 100ms ease, color 100ms ease;
        }
        .shuffly-insights-range-btn:hover:not(.shuffly-insights-range-btn--active) {
          background: var(--p-color-bg-fill-secondary, rgba(19, 17, 16, 0.06));
          color: var(--p-color-text, #131110);
        }
        .shuffly-insights-range-btn--active {
          background: var(--p-color-bg-fill-warning, #FF4B1F);
          color: #ffffff;
        }
        .shuffly-insights-stack--busy {
          opacity: 0.55;
          transition: opacity 120ms ease;
        }
        .shuffly-insights-range-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
        .shuffly-insights-stack { display: flex; flex-direction: column; gap: 14px; }
        .shuffly-insights-tiles {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px;
        }
        .shuffly-insights-columns {
          display: grid;
          grid-template-columns: 1.45fr 1fr;
          gap: 14px;
          align-items: stretch;
        }
        @container shuffly-insights (max-width: 900px) {
          .shuffly-insights-columns { grid-template-columns: 1fr; }
        }
        @container shuffly-insights (max-width: 700px) {
          .shuffly-insights-tiles { grid-template-columns: 1fr 1fr; }
        }
        .shuffly-card {
          background: var(--p-color-bg-surface, #ffffff);
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 12px;
          overflow: hidden;
        }
        .shuffly-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 14px 16px;
          border-bottom: 1px solid var(--p-color-border, #e3e3e3);
        }
        .shuffly-pill {
          display: inline-flex;
          align-items: center;
          height: 18px;
          padding: 0 7px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          white-space: nowrap;
          flex: none;
        }
        .shuffly-pill--orange {
          background: var(--p-color-bg-fill-warning-secondary, #FFE4D6);
          color: var(--p-color-text-warning, #d93c15);
        }
        .shuffly-pill--grey {
          background: var(--p-color-bg-fill-secondary, #F1F1F1);
          color: var(--p-color-text-secondary, #6b6b6b);
        }
      `}</style>
    </s-page>
  );
}

// ============================== range picker ==============================

function RangePicker({ range, onChange }: { range: InsightsRange; onChange: (r: InsightsRange) => void }) {
  return (
    <div className="shuffly-insights-range" role="group" aria-label="Date range">
      {VALID_RANGES.map((r) => (
        <button key={r} type="button" className={`shuffly-insights-range-btn${range === r ? " shuffly-insights-range-btn--active" : ""}`} onClick={() => onChange(r)}>
          {RANGE_LABELS[r]}
        </button>
      ))}
    </div>
  );
}

// ============================== summary strip ==============================

function SummaryStrip({ insights, range, onRangeChange }: { insights: InsightsData; range: InsightsRange; onRangeChange: (r: InsightsRange) => void }) {
  return (
    <div className="shuffly-strip">
      <div className="shuffly-strip-glow" aria-hidden="true" />
      <div className="shuffly-strip-top">
        <div className="shuffly-strip-eyebrow">Catalogue reaching page 1</div>
        <div className="shuffly-strip-range">
          <RangePicker range={range} onChange={onRangeChange} />
        </div>
      </div>
      <div className="shuffly-strip-headline">
        <span className="shuffly-strip-number">{insights.coveragePct}%</span>
        <span className="shuffly-strip-of"> of {insights.totalProducts} products</span>
      </div>
      <p className="shuffly-strip-explain">
        {insights.coverageSeenCount} of your products showed up on page 1 of a collection at least once {insights.rangeSentence}.
      </p>
      {insights.heroShowComparison ? (
        <div className="shuffly-strip-bars">
          <div className="shuffly-strip-bar-row">
            <span className="shuffly-strip-bar-label">Before Shuffly</span>
            <span className="shuffly-strip-bar-value">{insights.heroBeforePct}%</span>
          </div>
          <div className="shuffly-strip-track">
            <div className="shuffly-strip-fill shuffly-strip-fill--before" style={{ width: `${insights.heroBeforePct}%` }} />
          </div>
          <div className="shuffly-strip-bar-row" style={{ marginTop: 10 }}>
            <span className="shuffly-strip-bar-label">Now</span>
            <span className="shuffly-strip-bar-value">{insights.coveragePct}%</span>
          </div>
          <div className="shuffly-strip-track">
            <div className="shuffly-strip-fill shuffly-strip-fill--now" style={{ width: `${insights.coveragePct}%` }} />
          </div>
        </div>
      ) : (
        <p className="shuffly-strip-note">{insights.heroNote}</p>
      )}
      <style>{`
        .shuffly-strip {
          position: relative;
          overflow: hidden;
          border-radius: 12px;
          background: var(--p-color-bg-fill-inverse, #131110);
          padding: 16px 20px 20px;
        }
        .shuffly-strip-glow {
          position: absolute;
          top: -60px;
          right: -40px;
          width: 260px;
          height: 260px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(255, 75, 31, 0.35), transparent 70%);
          pointer-events: none;
        }
        .shuffly-strip-top {
          position: relative;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          flex-wrap: wrap;
        }
        .shuffly-strip-eyebrow {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.6);
        }
        .shuffly-strip-range .shuffly-insights-range {
          border-color: rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.07);
        }
        .shuffly-strip-range .shuffly-insights-range-btn {
          color: rgba(255, 255, 255, 0.78);
        }
        .shuffly-strip-range .shuffly-insights-range-btn:hover:not(.shuffly-insights-range-btn--active) {
          background: rgba(255, 255, 255, 0.12);
          color: #ffffff;
        }
        .shuffly-strip-range .shuffly-insights-range-btn--active {
          color: #ffffff;
        }
        .shuffly-strip-headline { position: relative; margin-top: 4px; line-height: 1; }
        .shuffly-strip-number { font-size: 40px; font-weight: 800; color: var(--p-color-text-warning, #FF4B1F); }
        .shuffly-strip-of { font-size: 18px; font-weight: 600; color: #ffffff; margin-left: 4px; }
        .shuffly-strip-explain {
          position: relative;
          margin: 8px 0 0;
          max-width: 460px;
          font-size: 13px;
          line-height: 1.5;
          color: rgba(255, 255, 255, 0.65);
        }
        .shuffly-strip-note {
          position: relative;
          margin: 14px 0 0;
          font-size: 13px;
          color: rgba(255, 255, 255, 0.5);
        }
        .shuffly-strip-bars { position: relative; margin-top: 16px; }
        .shuffly-strip-bar-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
        .shuffly-strip-bar-label { color: rgba(255, 255, 255, 0.5); }
        .shuffly-strip-bar-value { color: #ffffff; font-weight: 700; }
        .shuffly-strip-track { height: 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.12); overflow: hidden; }
        .shuffly-strip-fill { height: 100%; border-radius: 999px; }
        .shuffly-strip-fill--before { background: rgba(255, 255, 255, 0.4); }
        .shuffly-strip-fill--now { background: linear-gradient(90deg, var(--p-color-bg-fill-warning, #FF4B1F), #ff9166); }
      `}</style>
    </div>
  );
}

// ============================== tiles ==============================

/** Every tile is the same shape: 11px uppercase label, then the value
 * pushed to the bottom with margin-top:auto so all four values share one
 * baseline regardless of how many description lines sit above or below,
 * then one description line. Never lets a tile reflow to a different
 * number of lines. */
function Tile({
  heading,
  tile,
  unit,
  lead,
  detailOverride,
}: {
  heading: string;
  tile: InsightsTile;
  unit: string;
  lead?: boolean;
  detailOverride?: string;
}) {
  const detail = tile.noData ? tile.detail : (detailOverride ?? tile.detail);
  return (
    <div className="shuffly-insights-tile">
      <div className="shuffly-insights-tile-bar" style={lead ? { background: "var(--p-color-bg-fill-warning, #FF4B1F)" } : { background: "var(--p-color-bg-fill-inverse, #131110)", opacity: 0.12 }} />
      <div className="shuffly-insights-tile-label">{heading.toUpperCase()}</div>
      <div className={`shuffly-insights-tile-value${lead && !tile.noData ? " shuffly-insights-tile-value--orange" : ""}`}>
        {tile.noData ? "—" : (
          <>
            {tile.value}
            <span className="shuffly-insights-tile-unit">{unit}</span>
          </>
        )}
      </div>
      <div className="shuffly-insights-tile-detail">{detail}</div>
      <style>{`
        .shuffly-insights-tile {
          position: relative;
          display: flex;
          flex-direction: column;
          min-height: 96px;
          background: var(--p-color-bg-surface, #ffffff);
          border: 1px solid var(--p-color-border, #e3e3e3);
          border-radius: 12px;
          padding: 14px;
          overflow: hidden;
        }
        .shuffly-insights-tile-bar { position: absolute; top: 0; left: 0; right: 0; height: 2px; }
        .shuffly-insights-tile-label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          color: var(--p-color-text-secondary, #6b6b6b);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .shuffly-insights-tile-value {
          margin-top: auto;
          padding-top: 6px;
          font-size: 24px;
          font-weight: 800;
          font-variant-numeric: tabular-nums;
          color: var(--p-color-text, #131110);
          line-height: 1.1;
        }
        .shuffly-insights-tile-value--orange { color: var(--p-color-text-warning, #FF4B1F); }
        .shuffly-insights-tile-unit { font-size: 14px; font-weight: 600; margin-left: 2px; }
        .shuffly-insights-tile-detail {
          margin-top: 4px;
          font-size: 12px;
          color: var(--p-color-text-secondary, #6b6b6b);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `}</style>
    </div>
  );
}

// ============================== distribution ==============================

function DistributionCard({ insights }: { insights: InsightsData }) {
  const bars = insights.distributionBars;
  const max = Math.max(1, insights.distributionMax);
  const avgRatio = insights.distributionAvg / max;

  return (
    <div className="shuffly-card">
      <div className="shuffly-card-header">
        <s-text type="strong">How the top spots are shared</s-text>
        <s-text color="subdued">
          {insights.totalProducts} products · {insights.rangeLabel}
        </s-text>
      </div>
      <div style={{ padding: 16 }}>
        <div className="shuffly-dist-chart" role="img" aria-label={insights.distributionAriaLabel}>
          <div className="shuffly-dist-avgline" style={{ bottom: `${Math.min(100, avgRatio * 100)}%` }}>
            <span className="shuffly-dist-avglabel">avg {Math.round(insights.distributionAvg * 10) / 10}</span>
          </div>
          {bars.map((b, i) => (
            <div
              key={i}
              className={`shuffly-dist-bar${b.belowHalfAvg ? " shuffly-dist-bar--dim" : ""}`}
              style={{ height: `${Math.max(2, (b.turns / max) * 100)}%` }}
              title={`${Math.round(b.turns)} turns`}
            />
          ))}
        </div>
        <div className="shuffly-dist-axis">
          <span>Most turns</span>
          <span>Fewest turns</span>
        </div>
        {insights.distributionBucketed && (
          <div className="shuffly-dist-bucketnote">
            <s-text color="subdued">Bucketed into {bars.length} bars for readability.</s-text>
          </div>
        )}
        <s-divider />
        <p className="shuffly-dist-caption">{insights.distributionCaption}</p>
      </div>
      <style>{`
        .shuffly-dist-chart {
          position: relative;
          display: flex;
          align-items: flex-end;
          gap: 3px;
          height: 104px;
        }
        .shuffly-dist-bar {
          flex: 1;
          min-width: 2px;
          background: linear-gradient(180deg, var(--p-color-bg-fill-warning, #FF4B1F), #ff9166);
          border-radius: 2px 2px 0 0;
          cursor: default;
        }
        .shuffly-dist-bar--dim { background: var(--p-color-bg-fill-inverse, #131110); }
        .shuffly-dist-avgline {
          position: absolute;
          left: 0;
          right: 0;
          border-top: 1px dashed var(--p-color-border, #b7b7b7);
        }
        .shuffly-dist-avglabel {
          position: absolute;
          right: 0;
          top: -16px;
          font-size: 11px;
          color: var(--p-color-text-secondary, #6b6b6b);
          background: var(--p-color-bg-surface, #ffffff);
          padding-left: 4px;
        }
        .shuffly-dist-axis {
          display: flex;
          justify-content: space-between;
          margin-top: 8px;
          font-size: 11px;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        .shuffly-dist-bucketnote { margin-top: 6px; }
        .shuffly-dist-caption { margin: 12px 0 0; font-size: 13px; line-height: 1.5; color: var(--p-color-text, #131110); }
      `}</style>
    </div>
  );
}

// ============================== waiting longest ==============================

function WaitingLongestCard({
  rows,
  onBoost,
  boosting,
}: {
  rows: Array<InsightsWaitingRow & { imageUrl: string | null }>;
  onBoost: () => void;
  boosting: boolean;
}) {
  return (
    <div className="shuffly-card shuffly-waiting-card">
      <div className="shuffly-card-header">
        <s-text type="strong">Waiting longest</s-text>
        <s-text color="subdued">
          {rows.length} product{rows.length === 1 ? "" : "s"}
        </s-text>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 16 }}>
          <s-text color="subdued">Nothing is waiting — every product has had a recent turn.</s-text>
        </div>
      ) : (
        <>
          <div style={{ flex: "1 1 auto" }}>
            {rows.map((r) => (
              <div key={r.productGid} className="shuffly-waiting-row">
                {r.imageUrl ? (
                  <img src={r.imageUrl} alt="" width={32} height={32} style={{ borderRadius: 6, objectFit: "cover", flex: "none" }} />
                ) : (
                  <div style={{ width: 32, height: 32, borderRadius: 6, background: "var(--p-color-bg-fill-secondary, #e3dbd3)", flex: "none" }} />
                )}
                <div style={{ flex: "1 1 0%", minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <s-text type="strong">{r.title}</s-text>
                  </div>
                  <div style={{ fontSize: 12 }}>
                    <s-text color="subdued">{r.collectionTitle}</s-text>
                  </div>
                </div>
                <span className={`shuffly-pill ${r.urgent ? "shuffly-pill--orange" : "shuffly-pill--grey"}`}>{r.label}</span>
              </div>
            ))}
          </div>
          <div className="shuffly-card-footer">
            <s-text color="subdued">Give them the next turn</s-text>
            <s-button variant="tertiary" onClick={onBoost} {...(boosting ? { loading: true } : {})}>
              Put these first
            </s-button>
          </div>
        </>
      )}
      <style>{`
        .shuffly-waiting-card { display: flex; flex-direction: column; }
        .shuffly-waiting-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--p-color-border, #e3e3e3);
        }
        .shuffly-card-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 14px 16px;
        }
        .shuffly-put-first-btn {
          flex: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 32px;
          padding: 0 16px;
          border: none;
          outline: none;
          border-radius: 8px;
          background: var(--p-color-bg-fill-warning, #FF4B1F);
          color: #ffffff;
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .shuffly-put-first-btn:hover:not(:disabled) { background: var(--p-color-bg-fill-warning-hover, #d93c15); }
        .shuffly-put-first-btn:disabled { opacity: 0.6; cursor: default; }
        .shuffly-put-first-btn:focus-visible {
          outline: 2px solid var(--p-color-border-warning, #FF4B1F);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}

// ============================== who's had a turn ==============================

function WhoHadATurnCard({ insights }: { insights: InsightsData }) {
  const totalSeen = insights.byCollectionTurns.reduce((sum, c) => sum + c.seenCount, 0);
  const totalProducts = insights.byCollectionTurns.reduce((sum, c) => sum + c.productCount, 0);
  // The "Not yet" swatch only means something if an ink square is actually
  // on screen somewhere below it — otherwise it's explaining a colour
  // nobody can see.
  const hasAnyNotYet = insights.byCollectionTurns.some((c) => c.squares.some((sq) => !sq.hadTurn));

  return (
    <div className="shuffly-card">
      <div className="shuffly-card-header">
        <s-text type="strong">Who&apos;s had a turn</s-text>
        <s-text color="subdued">
          {totalSeen} of {totalProducts} products
        </s-text>
      </div>
      <div>
        {insights.byCollectionTurns.map((c, i) => {
          const atFull = c.productCount > 0 && c.seenCount === c.productCount;
          // Cadence first (it's the more specific fact), "sold out" always
          // shown when true, "last turn" as the fallback that always has a
          // value — never an empty-feeling "not enough data" pill.
          const pillText = c.soldOut ? "sold out" : (c.avgGapLabel ?? c.lastTurnLabel);
          return (
            // The divider is a SIBLING of the row, not a child of it — the
            // row's flex layout depends on having exactly its three real
            // columns (label, squares, pill) and nothing else.
            <Fragment key={c.id}>
              <div className="shuffly-turn-row">
                <div className="shuffly-turn-label" title={c.title}>
                  <div className="shuffly-turn-title">{c.title}</div>
                  <div className="shuffly-turn-stat">
                    {atFull && (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shuffly-turn-check">
                        <path d="M3 8.5L6.5 12L13 4.5" stroke="var(--p-color-icon-warning, #FF4B1F)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    <span className="shuffly-turn-stat-num">{c.seenCount}</span> of {c.productCount}
                    {c.avgGapLabel ? ` · ${c.avgGapLabel}` : ""}
                  </div>
                </div>
                <div className="shuffly-turn-squares">
                  {c.squares.map((sq) => (
                    <span
                      key={sq.productGid}
                      className={`shuffly-turn-square${sq.hadTurn ? " shuffly-turn-square--turn" : ""}`}
                      title={sq.tooltip}
                      aria-label={sq.tooltip}
                    />
                  ))}
                  {c.moreCount > 0 && <span className="shuffly-turn-more">+{c.moreCount} more</span>}
                </div>
                <span className="shuffly-pill shuffly-pill--grey">{pillText}</span>
              </div>
              {i < insights.byCollectionTurns.length - 1 && <s-divider />}
            </Fragment>
          );
        })}
      </div>
      <div className="shuffly-insights-legend">
        <span className="shuffly-legend-item">
          <span className="shuffly-legend-swatch shuffly-legend-swatch--turn" />
          Reached page 1
        </span>
        {hasAnyNotYet && (
          <span className="shuffly-legend-item">
            <span className="shuffly-legend-swatch shuffly-legend-swatch--empty" />
            Not yet
          </span>
        )}
      </div>
      <style>{`
        .shuffly-turn-row {
          padding: 12px 16px;
          display: grid;
          grid-template-columns: 250px 1fr auto;
          align-items: center;
          gap: 28px;
        }
        .shuffly-turn-label { min-width: 0; }
        .shuffly-turn-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--p-color-text, #131110);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .shuffly-turn-stat {
          margin-top: 3px;
          font-size: 12px;
          color: var(--p-color-text-secondary, #6b6b6b);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .shuffly-turn-check { vertical-align: -1px; margin-right: 6px; }
        .shuffly-turn-stat-num { color: var(--p-color-text-warning, #FF4B1F); font-weight: 700; }
        .shuffly-turn-squares { min-width: 0; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; align-content: center; }
        .shuffly-turn-square {
          width: 11px;
          height: 11px;
          border-radius: 3px;
          background: rgba(19, 17, 16, 0.15);
          cursor: default;
        }
        .shuffly-turn-square--turn { background: var(--p-color-bg-fill-warning, #FF4B1F); }
        .shuffly-turn-more { font-size: 11px; color: var(--p-color-text-secondary, #6b6b6b); align-self: center; margin-left: 2px; }
        .shuffly-insights-legend {
          display: flex;
          gap: 20px;
          padding: 12px 16px;
          border-top: 1px solid var(--p-color-border, #e3e3e3);
          font-size: 12px;
          color: var(--p-color-text-secondary, #6b6b6b);
        }
        .shuffly-legend-item { display: inline-flex; align-items: center; gap: 6px; }
        .shuffly-legend-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
        .shuffly-legend-swatch--turn { background: var(--p-color-bg-fill-warning, #FF4B1F); }
        .shuffly-legend-swatch--empty { background: rgba(19, 17, 16, 0.15); }
      `}</style>
    </div>
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
          <s-text color="subdued">Shuffly needs a few days of runs before these numbers mean anything.</s-text>
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

