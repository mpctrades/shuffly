// Server side of the collection card (Update 2): saving card edits, the
// one-click "New arrivals" preset, and the preset queued for a shop that
// clicked it before upgrading. Every write is checked against the shop's
// plan as the server knows it — never anything the browser sent.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CollectionConfig, Prisma, ShopSettings } from "@prisma/client";
import db from "../db.server";
import { NEW_ARRIVALS_PRESET, NEW_ON_TOP_CHOICES, parseCadence } from "./card-model";
import { getCollectionProductsInOrder } from "./collections.server";
import { canUseNewArrivals } from "./plans";
import { startTracking } from "./product-seen.server";
import { nextRunFor, type SlotSchedule } from "./schedule-core";
import { parseScheduleForm, withIntervalAnchor, type ScheduleFormError } from "./schedule-form.server";
import { overrideWriteFields, resolveSchedule } from "./schedule-resolve";

export interface CardEdit {
  id: string;
  cadence?: string;
  reshuffleOnNew?: boolean;
  keepNewOnTop?: boolean;
  newOnTopHours?: number;
}

export type CardEditError = ScheduleFormError | "PLAN_FEATURE" | "BAD_WINDOW" | "NOT_FOUND";

export type CardEditResult =
  | { ok: true; changed: number }
  | { ok: false; code: CardEditError; id: string; status: 400 | 403 | 404 };

/** Pending presets older than this are dropped rather than applied: an
 * upgrade weeks later shouldn't silently rewrite a collection. */
export const PENDING_PRESET_MAX_AGE_MS = 14 * 86_400_000;

/** English summary for the Activity row when a schedule changes. */
function scheduleText(s: SlotSchedule): string {
  if (s.scheduleType === "INTERVAL") return s.intervalHours === 1 ? "every hour" : `every ${s.intervalHours} hours`;
  if (s.scheduleType === "DAILY") return `daily at ${s.scheduleTime}`;
  if (s.scheduleType === "WEEKLY") return `weekly at ${s.scheduleTime}`;
  if (s.scheduleType === "TWICE_DAILY") return "twice daily";
  return "manual only";
}

/**
 * Validate every edit first and write nothing if any one is refused, so a
 * Save never half-applies. Then write each collection's changes, with an
 * Activity row for schedule changes, and start first-seen tracking for any
 * collection where B or C is being turned on for the first time.
 */
export async function applyCardEdits(
  admin: AdminApiContext | null,
  shop: string,
  settings: ShopSettings,
  edits: CardEdit[],
  now: Date = new Date(),
): Promise<CardEditResult> {
  const configs = await db.collectionConfig.findMany({ where: { shop, id: { in: edits.map((e) => e.id) } } });
  const byId = new Map(configs.map((c) => [c.id, c]));
  const proOk = canUseNewArrivals(settings.plan);

  type Planned = { config: CollectionConfig; data: Prisma.CollectionConfigUpdateInput; activity: string | null; track: boolean };
  const planned: Planned[] = [];

  for (const edit of edits) {
    const config = byId.get(edit.id);
    if (!config) return { ok: false, code: "NOT_FOUND", id: edit.id, status: 404 };
    const data: Prisma.CollectionConfigUpdateInput = {};
    let activity: string | null = null;

    if (edit.cadence != null) {
      const before = resolveSchedule(config, settings);
      const { scheduleType, intervalHours } = parseCadence(edit.cadence);
      // Daily and weekly keep the time of day (and weekday) the collection
      // already runs at; the card only changes how often.
      const form = new FormData();
      form.set("scheduleType", scheduleType);
      if (intervalHours != null) form.set("intervalHours", String(intervalHours));
      form.set("scheduleTime", before.scheduleTime);
      if (before.scheduleTime2) form.set("scheduleTime2", before.scheduleTime2);
      if (before.scheduleWeekday != null) form.set("scheduleWeekday", String(before.scheduleWeekday));
      const parsed = parseScheduleForm(form, settings.plan);
      if (!parsed.ok) return { ok: false, code: parsed.code, id: edit.id, status: parsed.status };
      const after = withIntervalAnchor(before, parsed.schedule, now);
      if (scheduleText(after) !== scheduleText(before) || config.scheduleType == null) {
        Object.assign(data, overrideWriteFields(after), {
          nextRunAt: config.status === "RUNNING" ? nextRunFor(now, settings.timezone, after) : null,
          scheduleUpdatedAt: now,
        });
        activity = `Schedule changed to ${scheduleText(after)} — was ${scheduleText(before)}`;
      }
    }

    const turningOn =
      (edit.reshuffleOnNew === true && !config.reshuffleOnNew) || (edit.keepNewOnTop === true && !config.keepNewOnTop);
    if (turningOn && !proOk) return { ok: false, code: "PLAN_FEATURE", id: edit.id, status: 403 };
    if (edit.reshuffleOnNew != null) data.reshuffleOnNew = edit.reshuffleOnNew;
    if (edit.keepNewOnTop != null) data.keepNewOnTop = edit.keepNewOnTop;
    if (edit.newOnTopHours != null) {
      if (!NEW_ON_TOP_CHOICES.includes(edit.newOnTopHours as (typeof NEW_ON_TOP_CHOICES)[number])) {
        return { ok: false, code: "BAD_WINDOW", id: edit.id, status: 400 };
      }
      data.newOnTopHours = edit.newOnTopHours;
    }
    planned.push({ config, data, activity, track: turningOn && !config.newTrackingSince });
  }

  for (const { config, data, activity, track } of planned) {
    if (Object.keys(data).length === 0) continue;
    await db.$transaction([
      db.collectionConfig.update({ where: { id: config.id }, data }),
      ...(activity
        ? [db.shuffleRun.create({ data: { shop, collectionId: config.id, trigger: "SCHEDULE_CHANGED", status: "OK", message: activity } })]
        : []),
    ]);
    if (track) await baseline(admin, config, now);
  }
  return { ok: true, changed: planned.filter((p) => Object.keys(p.data).length > 0).length };
}

/** "When the feature is first turned on, mark existing products as a
 * baseline." Done right away when we have an admin client; otherwise the
 * next poll or run does it (see pollCollection / the shuffle engine). */
async function baseline(admin: AdminApiContext | null, config: CollectionConfig, now: Date): Promise<void> {
  if (!admin) return;
  try {
    const { products } = await getCollectionProductsInOrder(admin, config.collectionGid);
    await startTracking(config.id, products.map((p) => ({ id: p.id, createdAt: p.createdAt })), now);
  } catch (err) {
    // Not fatal: the next poll or run baselines it instead.
    console.error(`[card] couldn't baseline ${config.collectionGid} now, will on the next poll:`, err);
  }
}

/** One click: every 2 hours + reshuffle on new products + new on top for
 * 48 h. Pro only; the merchant can change any of it afterwards. */
export async function applyNewArrivalsPreset(
  admin: AdminApiContext | null,
  shop: string,
  settings: ShopSettings,
  collectionId: string,
  now: Date = new Date(),
): Promise<CardEditResult> {
  const result = await applyCardEdits(
    admin,
    shop,
    settings,
    [
      {
        id: collectionId,
        cadence: NEW_ARRIVALS_PRESET.cadence,
        reshuffleOnNew: NEW_ARRIVALS_PRESET.reshuffleOnNew,
        keepNewOnTop: NEW_ARRIVALS_PRESET.keepNewOnTop,
        newOnTopHours: NEW_ARRIVALS_PRESET.newOnTopHours,
      },
    ],
    now,
  );
  if (result.ok) {
    await db.collectionConfig.update({ where: { id: collectionId }, data: { pendingPresetAt: null } });
  }
  return result;
}

/** The preset clicked on Free/Starter: remember it, and send the merchant
 * to the plan page. Nothing about the collection changes now. */
export async function queueNewArrivalsPreset(shop: string, collectionId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await db.collectionConfig.updateMany({ where: { shop, id: collectionId }, data: { pendingPresetAt: now } });
  return count === 1;
}

/** Called when a shop's plan becomes one that includes the preset. */
export async function applyQueuedPresets(shop: string, now: Date = new Date()): Promise<number> {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings || !canUseNewArrivals(settings.plan)) return 0;
  const queued = await db.collectionConfig.findMany({ where: { shop, pendingPresetAt: { not: null } } });
  let applied = 0;
  for (const c of queued) {
    const fresh = now.getTime() - c.pendingPresetAt!.getTime() <= PENDING_PRESET_MAX_AGE_MS;
    if (fresh && (await applyNewArrivalsPreset(null, shop, settings, c.id, now)).ok) applied++;
    else await db.collectionConfig.update({ where: { id: c.id }, data: { pendingPresetAt: null } });
  }
  return applied;
}
