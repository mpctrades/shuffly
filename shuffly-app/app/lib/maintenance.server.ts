// Housekeeping, on its own 15-minute timer instead of inside every 60-second
// scheduler sweep. With hourly schedules the sweep is the hot path; pruning
// tables on every tick of it was work done 15× more often than needed.
import { pruneExpiredUndoSnapshotsForAllShops } from "./plans.server";
import { pruneProcessedWebhooks } from "./webhook-dedupe.server";
import { resumeSortPausedCollections } from "./sort-pause.server";

export const MAINTENANCE_INTERVAL_MS = 15 * 60_000;

type Task = [label: string, run: (now: Date) => Promise<unknown>];

/** Each task is independent: one failing is logged and the rest still run. */
const TASKS: Task[] = [
  ["undo snapshot prune", pruneExpiredUndoSnapshotsForAllShops],
  ["processed-webhook prune", pruneProcessedWebhooks],
  ["resume sort-paused collections", resumeSortPausedCollections],
];

export async function runMaintenance(now: Date = new Date()): Promise<void> {
  for (const [label, run] of TASKS) {
    try {
      await run(now);
    } catch (err) {
      console.error(`[maintenance] ${label} failed:`, err);
    }
  }
}

/** Lets later features add their own cleanup without editing the list. */
export function registerMaintenanceTask(label: string, run: (now: Date) => Promise<unknown>): void {
  TASKS.push([label, run]);
}
