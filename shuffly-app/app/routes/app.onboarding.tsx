import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useLoaderData, useFetcher, Form, redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/shop-context.server";
import { listAllCollections, getCollectionProductsInOrder } from "../lib/collections.server";
import { computeShuffledOrder, type ShuffleProductInput } from "../lib/shuffle-algorithm.server";
import { computeNextRun } from "../lib/schedule.server";
import { defaultScheduleForPlan, planOf } from "../lib/plans.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getOrCreateShopSettings(admin, shop);
  const plan = planOf(settings.plan);
  const tracked = await db.collectionConfig.findMany({ where: { shop }, select: { collectionGid: true } });
  const trackedGids = new Set(tracked.map((t) => t.collectionGid));

  // Capped (see listAllCollections) — a fresh install on a store with a huge
  // catalogue still gets a fast, bounded first screen instead of listing
  // every collection in the shop. This is a one-time wizard step, not a
  // searchable picker, so a cap alone (no search field) is enough here.
  const { collections: all, hasMore } = await listAllCollections(admin, { limit: 100 });
  const candidates = all
    .filter((c) => c.sortOrder === "MANUAL" && !trackedGids.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, productsCount: c.productsCount }));

  const room =
    plan.maxCollections === Infinity
      ? candidates.length
      : Math.max(0, plan.maxCollections - tracked.length);

  return {
    candidates,
    hasMore,
    timezone: settings.timezone,
    maxSelectable: Math.min(room, candidates.length),
    canPin: plan.canPin,
    defaultSchedule: defaultScheduleForPlan(plan.id),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("_action");

  if (actionType === "preview") {
    const settings = await getOrCreateShopSettings(admin, shop);
    const plan = planOf(settings.plan);
    const collectionGid = String(formData.get("collectionGid"));
    const pins = plan.canPin ? Math.max(0, Number(formData.get("pins") ?? 2)) : 0;
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
    const plan = planOf(settings.plan);
    const existingCount = await db.collectionConfig.count({ where: { shop } });
    const room =
      plan.maxCollections === Infinity
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, plan.maxCollections - existingCount);
    const requested = new Set(formData.getAll("collectionGid").map(String));
    const { collections } = await listAllCollections(admin, { limit: 100 });
    const allowed = collections
      .filter((collection) => collection.sortOrder === "MANUAL" && requested.has(collection.id))
      .slice(0, room);
    const scheduleType = defaultScheduleForPlan(plan.id);
    const scheduleWeekday = scheduleType === "WEEKLY" ? 1 : null;
    const pins = plan.canPin
      ? Math.max(0, Math.min(10, Number(formData.get("pins") ?? 0)))
      : 0;
    const pushSoldOutToEnd = formData.get("pushSoldOutToEnd") === "true";
    const boostNewArrivals = formData.get("boostNewArrivals") === "true";
    const giveEveryoneATurn = formData.get("giveEveryoneATurn") === "true";

    for (const collection of allowed) {
      const nextRunAt = computeNextRun(
        new Date(),
        settings.timezone,
        scheduleType,
        settings.defaultRunTime,
        scheduleWeekday,
      );
      await db.collectionConfig.upsert({
        where: { shop_collectionGid: { shop, collectionGid: collection.id } },
        update: {},
        create: {
          shop,
          collectionGid: collection.id,
          title: collection.title,
          pins,
          pushSoldOutToEnd,
          boostNewArrivals,
          giveEveryoneATurn,
          scheduleType,
          scheduleTime: settings.defaultRunTime,
          scheduleWeekday,
          nextRunAt,
        },
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
  const { candidates, hasMore, maxSelectable, canPin, defaultSchedule } = useLoaderData<typeof loader>();
  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState<string[]>(candidates.slice(0, Math.min(3, maxSelectable)).map((c) => c.id));
  const [pins, setPins] = useState(canPin ? 2 : 0);
  const [pushSoldOutToEnd, setPushSoldOutToEnd] = useState(true);
  const [boostNewArrivals, setBoostNewArrivals] = useState(true);
  const [giveEveryoneATurn, setGiveEveryoneATurn] = useState(true);
  const previewFetcher = useFetcher<{ order: Array<{ id: string; title: string; initial: string; pinned: boolean }>; pinnedCount: number; shuffledCount: number; soldOutCount: number }>();

  const selectedCollections = candidates.filter((c) => selected.includes(c.id));
  const previewCollection = selectedCollections[0];

  function toggle(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return prev.length < maxSelectable ? [...prev, id] : prev;
    });
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
          <s-paragraph>Keep your collections fresh automatically. A couple of questions, then try it before anything changes.</s-paragraph>
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
              {hasMore && (
                <s-banner tone="info">
                  Showing the first {candidates.length}. You can add more from Collections after setup.
                </s-banner>
              )}
              {selected.length >= maxSelectable && maxSelectable < candidates.length && (
                <s-banner tone="info">
                  Your current plan can track {maxSelectable} more collection{maxSelectable === 1 ? "" : "s"}.
                </s-banner>
              )}
              {candidates.map((c) => (
                <div key={c.id} className="shuffly-onboard-row">
                  <s-checkbox
                    label={c.title}
                    details={`${c.productsCount} product${c.productsCount === 1 ? "" : "s"}`}
                    checked={selected.includes(c.id)}
                    disabled={!selected.includes(c.id) && selected.length >= maxSelectable ? true : undefined}
                    onChange={() => toggle(c.id)}
                  />
                </div>
              ))}
            </s-stack>
          )}
          <div className="shuffly-onboard-actions">
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
          </div>
        </s-section>
      )}

      {step === 2 && previewCollection && (
        <s-section heading={`2. Try it on ${previewCollection.title}`}>
          <s-paragraph>Press Shuffle and watch. This is a real preview — nothing is saved to your store yet.</s-paragraph>
          <s-grid gridTemplateColumns="1fr 2fr" gap="base">
            <s-stack direction="block" gap="base">
              {canPin ? (
                <s-number-field
                  label="Pin the first"
                  value={String(pins)}
                  min={0}
                  max={10}
                  onChange={(e) => setPins(Number(e.currentTarget.value))}
                />
              ) : (
                <s-paragraph>Pinning is available on Starter and Pro.</s-paragraph>
              )}
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
            {selectedCollections.length === 1 ? "" : "s"} on the {defaultSchedule === "WEEKLY" ? "weekly" : "daily"} schedule.
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
              <input type="hidden" name="pins" value={String(pins)} />
              <input type="hidden" name="pushSoldOutToEnd" value={String(pushSoldOutToEnd)} />
              <input type="hidden" name="boostNewArrivals" value={String(boostNewArrivals)} />
              <input type="hidden" name="giveEveryoneATurn" value={String(giveEveryoneATurn)} />
              {selectedCollections.map((c) => (
                <span key={c.id}>
                  <input type="hidden" name="collectionGid" value={c.id} />
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
        .shuffly-onboard-actions {
          margin-top: 20px;
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
