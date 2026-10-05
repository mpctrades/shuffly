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
import { onShutdown, runInBackground } from "./background.server";

declare global {
  // eslint-disable-next-line no-var
  var __shufflySchedulerStarted: boolean | undefined;
}

const POLL_INTERVAL_MS = 60_000;

export function startInProcessSchedulerOnce() {
  if (process.env.DISABLE_IN_PROCESS_SCHEDULER === "1") return;
  if (globalThis.__shufflySchedulerStarted) return;
  globalThis.__shufflySchedulerStarted = true;

  // A sweep over a few 2,000-product collections can outlast the 60s
  // interval. Slot claims already stop a collection running twice, but
  // overlapping sweeps still stack up Admin API traffic, so a tick that finds
  // the previous sweep unfinished just skips.
  let sweeping = false;
  const interval = setInterval(() => {
    if (sweeping) {
      // eslint-disable-next-line no-console
      console.log("[shuffly scheduler] previous sweep still running, skipping this tick");
      return;
    }
    sweeping = true;
    // Registered as background work so a deploy lets it finish instead of
    // cutting a reorder off half-applied.
    runInBackground("scheduler sweep", () =>
      runDueShuffles().finally(() => {
        sweeping = false;
      }),
    );
  }, POLL_INTERVAL_MS);

  onShutdown(() => clearInterval(interval));

  // eslint-disable-next-line no-console
  console.log(`[shuffly scheduler] started, polling every ${POLL_INTERVAL_MS / 1000}s`);
}
