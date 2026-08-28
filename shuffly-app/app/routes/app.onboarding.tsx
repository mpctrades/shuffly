import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, Form, redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { listAllCollections, getCollectionProductsInOrder } from "../lib/collections.server";
import { computeShuffledOrder, type ShuffleProductInput } from "../lib/shuffle-algorithm.server";
import { computeNextRun } from "../lib/schedule.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getOrCreateShopSettings(admin, shop);
  const tracked = await db.collectionConfig.findMany({ where: { shop }, select: { collectionGid: true } });
  const trackedGids = new Set(tracked.map((t) => t.collectionGid));

  const all = await listAllCollections(admin);
  const candidates = all
    .filter((c) => c.sortOrder === "MANUAL" && !trackedGids.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, productsCount: c.productsCount }));

  return { candidates, timezone: settings.timezone };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("_action");

  if (actionType === "preview") {
    const collectionGid = String(formData.get("collectionGid"));
    const pins = Math.max(0, Number(formData.get("pins") ?? 2));
    const pushSoldOutToEnd = formData.get("pushSoldOutToEnd") === "true";
    const boostNewArrivals = formData.get("boostNewArrivals") === "true";
    const giveEveryoneATurn = formData.get("giveEveryoneATurn") === "true";

    const { products } = await getCollectionProductsInOrder(admin, collectionGid, 200);
    const currentOrder = products.map((p) => p.id);
    const now = Date.now();
    const productsById = new Map<string, ShuffleProductInput>(
      products.map((p) => [
        p.id,
        {
          id: p.id,
          isSoldOut: p.tracksInventory && p.totalInventory <= 0,
          isNew: now - new Date(p.createdAt).getTime() <= 14 * 86_400_000,
          neverMove: false,
        },
      ]),
    );
    const result = computeShuffledOrder(currentOrder, productsById, {}, {
      pins,
      pushSoldOutToEnd,
      boostNewArrivals,
      giveEveryoneATurn,
    });
    const titleById = new Map(products.map((p) => [p.id, p.title]));
    return data({
      ok: true,
      order: result.order.slice(0, 16).map((id, idx) => ({
        id,
        title: titleById.get(id) ?? "",
        initial: (titleById.get(id) ?? "?").trim().charAt(0).toUpperCase(),
        pinned: idx < result.pinnedCount,
      })),
      pinnedCount: result.pinnedCount,
      shuffledCount: result.shuffledCount,
      soldOutCount: result.soldOutCount,
    });
  }

  if (actionType === "activate") {
    const settings = await getOrCreateShopSettings(admin, shop);
    const ids = formData.getAll("collectionGid").map(String);
    const titles = formData.getAll("collectionTitle").map(String);
    for (let i = 0; i < ids.length; i++) {
      const nextRunAt = computeNextRun(new Date(), settings.timezone, "DAILY", settings.defaultRunTime, null);
      await db.collectionConfig.upsert({
        where: { shop_collectionGid: { shop, collectionGid: ids[i] } },
        update: {},
        create: { shop, collectionGid: ids[i], title: titles[i] ?? "Collection", scheduleTime: settings.defaultRunTime, nextRunAt },
      });
    }
    await db.shopSettings.update({ where: { shop }, data: { onboardedAt: new Date() } });
    return redirect("/app/collections");
  }

  if (actionType === "skip") {
    await db.shopSettings.upsert({
      where: { shop },
      update: { onboardedAt: new Date() },
      create: { shop, onboardedAt: new Date() },
    });
    return redirect("/app/collections");
  }

  return data({ ok: false }, { status: 400 });
};

export default function Onboarding() {
  const { candidates } = useLoaderData<typeof loader>();
  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState<string[]>(candidates.slice(0, 3).map((c) => c.id));
  const [pins, setPins] = useState(2);
  const [pushSoldOutToEnd, setPushSoldOutToEnd] = useState(true);
  const [boostNewArrivals, setBoostNewArrivals] = useState(true);
  const [giveEveryoneATurn, setGiveEveryoneATurn] = useState(true);
  const previewFetcher = useFetcher<{ order: Array<{ id: string; title: string; initial: string; pinned: boolean }>; pinnedCount: number; shuffledCount: number; soldOutCount: number }>();

  const selectedCollections = candidates.filter((c) => selected.includes(c.id));
  const previewCollection = selectedCollections[0];

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function runPreview() {
    if (!previewCollection) return;
    previewFetcher.submit(
      {
        _action: "preview",
        collectionGid: previewCollection.id,
        pins: String(pins),
        pushSoldOutToEnd: String(pushSoldOutToEnd),
        boostNewArrivals: String(boostNewArrivals),
        giveEveryoneATurn: String(giveEveryoneATurn),
      },
      { method: "post" },
    );
  }

  return (
    <s-page heading="Get started">
      <div className="shuffly-onboard-topbar">
        <Form method="post" style={{ display: "inline" }}>
          <input type="hidden" name="_action" value="skip" />
          <s-button type="submit" variant="secondary">
            Skip
          </s-button>
        </Form>

        <div className="shuffly-onboard-head">
          <div className="shuffly-onboard-eyebrow">Getting started</div>
          <s-paragraph>Your collections, fresh every morning. A couple of questions, then try it before anything changes.</s-paragraph>
          <div className="shuffly-onboard-steps" aria-hidden="true">
            <span className={`shuffly-onboard-dot${step >= 1 ? " on" : ""}`} />
            <span className={`shuffly-onboard-dot${step >= 2 ? " on" : ""}`} />
            <span className={`shuffly-onboard-dot${step >= 3 ? " on" : ""}`} />
          </div>
        </div>
      </div>

      {step === 1 && (
        <s-section heading="1. Which collections should stay fresh?">
          {candidates.length === 0 ? (
            <s-paragraph>
              No manually-sorted collections found to add yet. You can still skip and add one later from Collections.
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="small">
              {candidates.map((c) => (
                <div key={c.id} className="shuffly-onboard-row">
                  <s-checkbox
                    label={c.title}
                    details={`${c.productsCount} product${c.productsCount === 1 ? "" : "s"}`}
                    checked={selected.includes(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                </div>
              ))}
            </s-stack>
          )}
          <s-button
            variant="primary"
            onClick={() => {
              setStep(2);
              runPreview();
            }}
            disabled={selected.length === 0 || undefined}
          >
            Next
          </s-button>
        </s-section>
      )}

      {step === 2 && previewCollection && (
        <s-section heading={`2. Try it on ${previewCollection.title}`}>
          <s-paragraph>Press Shuffle and watch. This is a real preview — nothing is saved to your store yet.</s-paragraph>
          <s-grid gridTemplateColumns="1fr 2fr" gap="base">
            <s-stack direction="block" gap="base">
              <s-number-field
                label="Pin the first"
                value={String(pins)}
                min={0}
                max={10}
                onChange={(e) => setPins(Number(e.currentTarget.value))}
              />
              <s-checkbox
                label="Sold-out to the end"
                checked={pushSoldOutToEnd}
                onChange={(e) => setPushSoldOutToEnd(e.currentTarget.checked)}
              />
              <s-checkbox
                label="Boost new arrivals"
                checked={boostNewArrivals}
                onChange={(e) => setBoostNewArrivals(e.currentTarget.checked)}
              />
              <s-checkbox
                label="Give everything a turn"
                checked={giveEveryoneATurn}
                onChange={(e) => setGiveEveryoneATurn(e.currentTarget.checked)}
              />
              <s-button variant="primary" onClick={runPreview} {...(previewFetcher.state !== "idle" ? { loading: true } : {})}>
                Shuffle now
              </s-button>
            </s-stack>

            <s-stack direction="block" gap="base">
              <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="small">
                {(previewFetcher.data?.order ?? []).map((p) => (
                  <s-box key={p.id} padding="small" borderWidth="base" borderRadius="base">
                    <s-stack direction="block" gap="small">
                      {p.pinned && <s-badge tone="info">Pinned</s-badge>}
                      <s-heading>{p.initial}</s-heading>
                      <s-text>{p.title}</s-text>
                    </s-stack>
                  </s-box>
                ))}
              </s-grid>
              {previewFetcher.data && (
                <s-text color="subdued">
                  {previewFetcher.data.pinnedCount} pinned · {previewFetcher.data.shuffledCount} shuffled ·{" "}
                  {previewFetcher.data.soldOutCount} sold-out sent to the end
                </s-text>
              )}
            </s-stack>
          </s-grid>

          <s-stack direction="inline" gap="base">
            <s-button onClick={() => setStep(1)}>Back</s-button>
            <s-button variant="primary" onClick={() => setStep(3)}>
              Looks good
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 3 && (
        <s-section heading="3. Ready">
          <s-paragraph>
            Shuffly will start shuffling {selectedCollections.length} collection
            {selectedCollections.length === 1 ? "" : "s"} tomorrow morning, then every day after that.
          </s-paragraph>
          <s-banner tone="success" heading="Nothing touches your theme">
            <s-paragraph>
              Shuffly changes the real product order inside Shopify. 0 KB added, no scripts, and uninstalling leaves
              your collections exactly as they are.
            </s-paragraph>
          </s-banner>
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => setStep(2)}>Back</s-button>
            <Form method="post">
              <input type="hidden" name="_action" value="activate" />
              {selectedCollections.map((c) => (
                <span key={c.id}>
                  <input type="hidden" name="collectionGid" value={c.id} />
                  <input type="hidden" name="collectionTitle" value={c.title} />
                </span>
              ))}
              <s-button type="submit" variant="primary">
                Turn Shuffly on
              </s-button>
            </Form>
          </s-stack>
        </s-section>
      )}

      <style>{`
        .shuffly-onboard-topbar {
          padding: 20px 0 28px;
        }
        .shuffly-onboard-eyebrow {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #FF4B1F;
          margin-bottom: 6px;
        }
        .shuffly-onboard-steps {
          display: flex;
          gap: 6px;
          margin-top: 16px;
        }
        .shuffly-onboard-dot {
          width: 28px;
          height: 4px;
          border-radius: 999px;
          background: rgba(19, 17, 16, 0.12);
          transition: background-color 150ms ease;
        }
        .shuffly-onboard-dot.on {
          background: #FF4B1F;
        }
        .shuffly-onboard-row {
          border: 1px solid rgba(19, 17, 16, 0.08);
          border-radius: 10px;
          padding: 2px 12px;
          transition: border-color 120ms ease, background-color 120ms ease;
        }
        .shuffly-onboard-row:hover {
          border-color: rgba(255, 75, 31, 0.4);
          background: rgba(255, 75, 31, 0.03);
        }
      `}</style>
    </s-page>
  );
}
