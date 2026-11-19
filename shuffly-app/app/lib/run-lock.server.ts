// One run at a time per collection (brief §8).
//
// A lease stored on the collection row, taken with a conditional UPDATE so
// two callers can't both win, and expiring on its own so a container killed
// mid-run can't leave a collection locked forever. Every path that writes a
// collection's order takes it: scheduled runs, Shuffle now, the
// new-products trigger, the sold-out reaction and Undo.
//
// The in-memory `serializePerCollection` chain in collections.server.ts stays
// as well. It only orders the reorder *calls*; this lock covers the whole
// read → compute → write cycle, which is what stops a run computing its moves
// from an order another run is halfway through changing.

import { randomUUID } from "node:crypto";
import db from "../db.server";

/** Longer than any real run (a 10,000-product collection is ~40 chunks of
 * 250 with a job wait each, a few minutes), shorter than the 1-hour minimum
 * interval, so a crashed run costs at most one hourly slot. */
export const RUN_LOCK_LEASE_MS = 30 * 60_000;

/** Take the lock, or return null when another run holds it. */
export async function acquireRunLock(
  collectionId: string,
  now: Date = new Date(),
  leaseMs: number = RUN_LOCK_LEASE_MS,
): Promise<string | null> {
  const token = randomUUID();
  const { count } = await db.collectionConfig.updateMany({
    where: {
      id: collectionId,
      OR: [{ runLockedUntil: null }, { runLockedUntil: { lt: now } }],
    },
    data: { runLockedUntil: new Date(now.getTime() + leaseMs), runLockToken: token },
  });
  return count === 1 ? token : null;
}

/** Release only our own lease. A run that outlived its lease and was taken
 * over must not release the newer holder's lock. */
export async function releaseRunLock(collectionId: string, token: string): Promise<void> {
  await db.collectionConfig.updateMany({
    where: { id: collectionId, runLockToken: token },
    data: { runLockedUntil: null, runLockToken: null },
  });
}

export type LockedResult<T> = { locked: true; value: T } | { locked: false };

/** Run `work` holding the lock; `{ locked: false }` without running it when
 * the collection is busy. */
export async function withRunLock<T>(collectionId: string, work: () => Promise<T>): Promise<LockedResult<T>> {
  const token = await acquireRunLock(collectionId);
  if (!token) return { locked: false };
  try {
    return { locked: true, value: await work() };
  } finally {
    await releaseRunLock(collectionId, token).catch((err) => {
      // The lease expires on its own; a failed release only delays the
      // next run, it never wedges the collection.
      console.error(`[run-lock] couldn't release ${collectionId}:`, err);
    });
  }
}

/** For work that must happen rather than be skipped (a sold-out product
 * should still move to the end once the running shuffle finishes): wait for
 * the lock up to `maxWaitMs`, then give up. */
export async function withRunLockWaiting<T>(
  collectionId: string,
  work: () => Promise<T>,
  { maxWaitMs = 120_000, pollMs = 2_000 }: { maxWaitMs?: number; pollMs?: number } = {},
): Promise<LockedResult<T>> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const result = await withRunLock(collectionId, work);
    if (result.locked || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
