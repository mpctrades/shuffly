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

declare global {
  // eslint-disable-next-line no-var
  var __shufflySchedulerStarted: boolean | undefined;
}

const POLL_INTERVAL_MS = 60_000;

export function startInProcessSchedulerOnce() {
  if (process.env.DISABLE_IN_PROCESS_SCHEDULER === "1") return;
  if (globalThis.__shufflySchedulerStarted) return;
  globalThis.__shufflySchedulerStarted = true;

  setInterval(() => {
    runDueShuffles().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[shuffly scheduler] sweep failed", err);
    });
  }, POLL_INTERVAL_MS);

  // eslint-disable-next-line no-console
  console.log(`[shuffly scheduler] started, polling every ${POLL_INTERVAL_MS / 1000}s`);
}
