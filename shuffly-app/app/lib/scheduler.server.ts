// Best-effort in-process scheduler: as long as one Node process for this
// app is running, it checks every minute for collections that are due and
// shuffles them. Good enough for the single-container deployment this
// template's Dockerfile targets.
//
// If you deploy across multiple replicas or on a serverless platform, don't
// rely on this — point an external scheduler at
// POST /api/cron/run-shuffles (see app/routes/api.cron.run-shuffles.tsx)
// instead, and set DISABLE_IN_PROCESS_SCHEDULER=1 so replicas don't race.

import { runDueShuffles } from "./cron.server";
import { runNewProductsChecks } from "./new-products.server";
import { onShutdown, runInBackground } from "./background.server";
import { MAINTENANCE_INTERVAL_MS, runMaintenance } from "./maintenance.server";

declare global {
  // eslint-disable-next-line no-var
  var __shufflySchedulerStarted: boolean | undefined;
}

const POLL_INTERVAL_MS = 60_000;

export function startInProcessSchedulerOnce() {
  if (process.env.DISABLE_IN_PROCESS_SCHEDULER === "1") return;
  if (globalThis.__shufflySchedulerStarted) return;
  globalThis.__shufflySchedulerStarted = true;

  // Overlapping ticks are allowed: a sweep skips any shop an earlier one is
  // still working on (see shopsInFlight in cron.server.ts), and the run lock
  // stops a collection running twice. The old "skip the whole tick while any
  // sweep is running" let one slow shop delay every other shop's hourly run.
  const interval = setInterval(() => {
    // Registered as background work so a deploy lets it finish instead of
    // cutting a reorder off half-applied.
    runInBackground("scheduler sweep", () => runDueShuffles());
    // Feature B: one indexed query a minute; Shopify is only asked about
    // collections due their 15-minute poll or a batch whose 10-minute wait
    // just ended.
    runInBackground("new-products checks", () => runNewProductsChecks());
  }, POLL_INTERVAL_MS);

  let maintaining = false;
  const maintenance = setInterval(() => {
    if (maintaining) return;
    maintaining = true;
    runInBackground("maintenance", () =>
      runMaintenance().finally(() => {
        maintaining = false;
      }),
    );
  }, MAINTENANCE_INTERVAL_MS);
  onShutdown(() => clearInterval(maintenance));

  onShutdown(() => clearInterval(interval));

  // eslint-disable-next-line no-console
  console.log(`[shuffly scheduler] started, polling every ${POLL_INTERVAL_MS / 1000}s`);
}
