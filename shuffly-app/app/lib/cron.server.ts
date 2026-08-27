// The one function that actually makes Shuffly "automatic": find every
// collection across every shop whose nextRunAt has passed, and shuffle it.
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

import { randomUUID } from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runShuffleForCollection } from "./shuffle-engine.server";

export interface CronSweepResult {
  checked: number;
  ran: number;
  failed: number;
  details: Array<{ shop: string; collection: string; ok: boolean; message: string }>;
}

export async function runDueShuffles(): Promise<CronSweepResult> {
  const due = await db.collectionConfig.findMany({
    where: { status: "RUNNING", nextRunAt: { lte: new Date() } },
  });

  const result: CronSweepResult = { checked: due.length, ran: 0, failed: 0, details: [] };
  if (due.length === 0) return result;

  const byShop = new Map<string, typeof due>();
  for (const config of due) {
    byShop.set(config.shop, [...(byShop.get(config.shop) ?? []), config]);
  }

  for (const [shop, configs] of byShop) {
    let settings = await db.shopSettings.findUnique({ where: { shop } });
    if (!settings) {
      settings = await db.shopSettings.create({ data: { shop } });
    }
    let admin;
    try {
      admin = (await unauthenticated.admin(shop)).admin;
    } catch (err) {
      for (const config of configs) {
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

    for (const config of configs) {
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
        result.details.push({ shop, collection: config.title, ok: summary.ok, message: summary.message });
      } catch (err) {
        result.failed++;
        result.details.push({ shop, collection: config.title, ok: false, message: String(err) });
      }
    }
  }

  return result;
}
