import { beforeEach, describe, expect, it, vi } from "vitest";

// A one-row fake of collectionConfig.updateMany with the two WHERE shapes the
// lock uses — enough to exercise the real conditional-update logic.
const row = vi.hoisted(() => ({ runLockedUntil: null as Date | null, runLockToken: null as string | null }));

vi.mock("../db.server", () => ({
  default: {
    collectionConfig: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: typeof row }) => {
        if ("runLockToken" in where) {
          if (row.runLockToken !== where.runLockToken) return { count: 0 };
        } else {
          const now = ((where.OR as Array<{ runLockedUntil: { lt: Date } | null }>)[1].runLockedUntil as { lt: Date }).lt;
          if (row.runLockedUntil && row.runLockedUntil >= now) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  },
}));

import { acquireRunLock, releaseRunLock, withRunLock, withRunLockWaiting } from "./run-lock.server";

describe("per-collection run lock", () => {
  beforeEach(() => {
    row.runLockedUntil = null;
    row.runLockToken = null;
  });

  it("lets exactly one caller in", async () => {
    const now = new Date("2026-11-12T10:00:00Z");
    const first = await acquireRunLock("c1", now);
    const second = await acquireRunLock("c1", now);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it("expires on its own, so a crashed run can't wedge the collection", async () => {
    await acquireRunLock("c1", new Date("2026-11-12T10:00:00Z"), 60_000);
    expect(await acquireRunLock("c1", new Date("2026-11-12T10:00:30Z"), 60_000)).toBeNull();
    expect(await acquireRunLock("c1", new Date("2026-11-12T10:01:01Z"), 60_000)).toBeTruthy();
  });

  it("only the holder can release it", async () => {
    const token = (await acquireRunLock("c1"))!;
    await releaseRunLock("c1", "someone-else");
    expect(row.runLockToken).toBe(token);
    await releaseRunLock("c1", token);
    expect(row.runLockedUntil).toBeNull();
  });

  it("an overlapping run is reported as not locked and its work never runs", async () => {
    let release!: () => void;
    const slow = withRunLock("c1", () => new Promise<string>((r) => (release = () => r("done"))));
    await Promise.resolve();
    await Promise.resolve();
    const work = vi.fn(async () => "second");
    expect(await withRunLock("c1", work)).toEqual({ locked: false });
    expect(work).not.toHaveBeenCalled();
    release();
    expect(await slow).toEqual({ locked: true, value: "done" });
  });

  it("releases the lock even when the work throws", async () => {
    await expect(withRunLock("c1", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(row.runLockToken).toBeNull();
  });

  it("the waiting variant runs once the holder finishes", async () => {
    const token = (await acquireRunLock("c1"))!;
    setTimeout(() => void releaseRunLock("c1", token), 30);
    const result = await withRunLockWaiting("c1", async () => "moved", { maxWaitMs: 1_000, pollMs: 10 });
    expect(result).toEqual({ locked: true, value: "moved" });
  });

  it("the waiting variant gives up after its deadline", async () => {
    await acquireRunLock("c1");
    const result = await withRunLockWaiting("c1", async () => "never", { maxWaitMs: 30, pollMs: 10 });
    expect(result).toEqual({ locked: false });
  });
});
