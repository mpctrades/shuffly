// The one function that actually makes Shuffly "automatic": find every
// collection whose schedule says it's due right now, in that shop's own
// local time, and shuffle it.
//
// Two things call this:
//   1. app/lib/scheduler.server.ts — an in-process poller, good enough for
//      the common case of a single always-on Node server (this template
//      ships a Dockerfile, i.e. a persistent container).
//   2. app/routes/api.cron.run-shuffles.tsx — an HTTP endpoint an external
//      scheduler (platform cron, GitHub Actions, cron-job.org) can hit
//      instead, for serverless/multi-instance deployments. Recommended for
//      production since it survives restarts and avoids double-running
//      across replicas.
//
// How "due" is decided (this changed in Update 1):
//
// Nothing is queued ahead of time. Each pass re-reads every candidate
// collection's *currently stored* schedule and asks `dueSlots` what that
// schedule says about right now. So when a merchant moves their shuffle from
// 18:00 to 09:00, the next run follows the new time immediately — there is no
// leftover job pointing at 18:00, because there was never a job.
//
// `nextRunAt` survives only as (a) the countdown the UI renders and (b) an
// index-backed prefilter that keeps this from scanning every RUNNING
// collection every minute. It is advisory: a stale value can invite a
// collection into a sweep that turns out to have nothing due (harmless, and
// repaired on the way out), but it can never cause a run at the old time.
//
// Firing exactly once is enforced by ShuffleSlotClaim, not by timing: the
// claim row (collection, shop-local date, slot) is inserted *before* the
// shuffle runs, and its unique constraint rejects a second attempt. That
// covers overlapping sweeps, a retried sweep, two replicas racing, and the
// repeated hour on a DST fall-back day.

import { randomUUID } from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runShuffleForCollection } from "./shuffle-engine.server";
import { dueSlots, nextRunFor, type MissedSlot, type ScheduleType } from "./schedule.server";

export interface CronSweepResult {
  checked: number;
  ran: number;
  failed: number;
  /** Slots that were due but already claimed by another sweep — the
   * idempotency guard doing its job, not an error. */
  skipped: number;
  /** Slots whose time passed by more than the grace window. Logged and
   * skipped, never run as backlog. */
  missed: number;
  details: Array<{ shop: string; collection: string; ok: boolean; message: string }>;
}

/** Claims are only useful for as long as a slot could still be considered
 * due, plus enough history to debug a complaint about a missed run. */
const CLAIM_RETENTION_MS = 30 * 86_400_000;

/**
 * Take the (collection, local day, slot) claims for `slots`, returning only
 * the ones this process actually won. A unique-constraint violation (P2002)
 * means another sweep got there first, which is the whole point.
 */
async function claimSlots<T extends { slot: number; dateKey: string; at: Date }>(
  shop: string,
  collectionId: string,
  slots: T[],
): Promise<T[]> {
  const won: T[] = [];
  for (const slot of slots) {
    try {
      await db.shuffleSlotClaim.create({
        data: { shop, collectionId, dateKey: slot.dateKey, slot: slot.slot, scheduledFor: slot.at },
      });
      won.push(slot);
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }
  return won;
}

async function pruneOldSlotClaims(now: Date): Promise<void> {
  await db.shuffleSlotClaim.deleteMany({
    where: { claimedAt: { lt: new Date(now.getTime() - CLAIM_RETENTION_MS) } },
  });
}

export async function runDueShuffles(now: Date = new Date()): Promise<CronSweepResult> {
  // Advisory prefilter — see the note at the top of this file. `nextRunAt:
  // null` is included because a row that has never been scheduled (or was
  // written by a path that didn't set it) must still be evaluated.
  const candidates = await db.collectionConfig.findMany({
    where: {
      status: "RUNNING",
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
  });

  const result: CronSweepResult = { checked: candidates.length, ran: 0, failed: 0, skipped: 0, missed: 0, details: [] };
  if (candidates.length === 0) return result;

  const byShop = new Map<string, typeof candidates>();
  for (const config of candidates) {
    byShop.set(config.shop, [...(byShop.get(config.shop) ?? []), config]);
  }

  for (const [shop, configs] of byShop) {
    let settings = await db.shopSettings.findUnique({ where: { shop } });
    if (!settings) {
      settings = await db.shopSettings.create({ data: { shop } });
    }

    // Work out what's due before paying for an admin session: a sweep that
    // only picked these collections up because of a stale nextRunAt has
    // nothing to do, and shouldn't touch Shopify at all.
    const work = configs.map((config) => {
      const { due, missed } = dueSlots(
        now,
        settings.timezone,
        {
          scheduleType: config.scheduleType as ScheduleType,
          scheduleTime: config.scheduleTime,
          scheduleTime2: config.scheduleTime2,
          scheduleWeekday: config.scheduleWeekday,
        },
        config.scheduleUpdatedAt,
      );
      return { config, due, missed };
    });

    // Repair the advisory countdown for everything in this sweep, whether or
    // not it runs — this is what stops a stale nextRunAt from persisting.
    for (const { config } of work) {
      const nextRunAt = nextRunFor(new Date(), settings.timezone, {
        scheduleType: config.scheduleType as ScheduleType,
        scheduleTime: config.scheduleTime,
        scheduleTime2: config.scheduleTime2,
        scheduleWeekday: config.scheduleWeekday,
      });
      if (nextRunAt?.getTime() !== config.nextRunAt?.getTime()) {
        await db.collectionConfig.update({ where: { id: config.id }, data: { nextRunAt } });
      }
    }

    // A slot whose time passed by more than the grace window is recorded and
    // dropped — never run as backlog hours later. The claim goes in too, so
    // a later sweep doesn't reconsider it.
    for (const { config, missed } of work) {
      if (missed.length === 0) continue;
      const claimed = await claimSlots(shop, config.id, missed);
      if (claimed.length === 0) continue;
      result.missed += claimed.length;
      await db.shuffleRun.create({
        data: {
          shop,
          collectionId: config.id,
          trigger: "SCHEDULED",
          status: "FAILED",
          message: `Missed — Shuffly wasn't running at ${formatSlotTimes(claimed, settings.timezone)}`,
        },
      });
      result.details.push({
        shop,
        collection: config.title,
        ok: false,
        message: `Missed ${claimed.length} slot(s) outside the grace window`,
      });
    }

    const withWork = work.filter((item) => item.due.length > 0);
    if (withWork.length === 0) continue;

    let admin;
    try {
      admin = (await unauthenticated.admin(shop)).admin;
    } catch (err) {
      for (const { config } of withWork) {
        result.failed++;
        result.details.push({
          shop,
          collection: config.title,
          ok: false,
          message: `Could not get an admin session (app may be uninstalled): ${String(err)}`,
        });
      }
      continue;
    }

    // One id shared by every collection in this shop's sweep, so the
    // Activity feed can show "Morning run — N collections, M products
    // moved" as a single entry instead of N separate lines.
    const batchId = randomUUID();

    for (const { config, due } of withWork) {
      // Claim every due slot but shuffle only once. If a sweep comes back
      // from an outage with both of today's slots overdue, running the same
      // collection twice inside a second would move products twice for no
      // merchant-visible benefit and log two Activity entries — while
      // claiming both is what stops the earlier one being retried later.
      const won = await claimSlots(shop, config.id, due);
      if (won.length === 0) {
        result.skipped += due.length;
        continue;
      }

      const ranLate = won.some((slot) => slot.late);

      try {
        const summary = await runShuffleForCollection(
          admin,
          shop,
          config,
          settings.timezone,
          settings.neverMoveTags,
          "SCHEDULED",
          batchId,
          settings.pageSize,
        );
        if (summary.ok) result.ran++;
        else result.failed++;
        if (summary.ok && ranLate) {
          // The shuffle happened, just not on the minute — worth saying in
          // Activity so a merchant who notices isn't left guessing.
          await db.shuffleRun.updateMany({
            where: { shop, collectionId: config.id, batchId, status: "OK" },
            data: { message: `${summary.message} · ran late (Shuffly was catching up)` },
          });
        }
        result.details.push({ shop, collection: config.title, ok: summary.ok, message: summary.message });
      } catch (err) {
        result.failed++;
        result.details.push({ shop, collection: config.title, ok: false, message: String(err) });
      }
    }
  }

  await pruneOldSlotClaims(now);
  return result;
}

/** "06:00" / "06:00 and 18:00", in the shop's own timezone — for a missed-run
 * message that names the times the merchant actually chose. */
function formatSlotTimes(slots: MissedSlot[], timeZone: string): string {
  const times = slots.map((slot) =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot.at),
  );
  return times.length <= 1 ? (times[0] ?? "its scheduled time") : `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
}
