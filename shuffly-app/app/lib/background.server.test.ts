import { describe, expect, it, vi } from "vitest";

import { drainBackgroundTasks, runInBackground } from "./background.server";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runInBackground / drainBackgroundTasks", () => {
  it("waits for in-flight work, including work that work starts", async () => {
    const done: string[] = [];
    runInBackground("outer", async () => {
      await sleep(20);
      done.push("outer");
      runInBackground("inner", async () => {
        await sleep(20);
        done.push("inner");
      });
    });

    expect(await drainBackgroundTasks(1000)).toBe(true);
    expect(done).toEqual(["outer", "inner"]);
  });

  it("logs a failure under its label instead of throwing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runInBackground("doomed", async () => {
      throw new Error("boom");
    });

    expect(await drainBackgroundTasks(1000)).toBe(true);
    expect(consoleError).toHaveBeenCalledWith("[background] doomed failed:", expect.any(Error));
    consoleError.mockRestore();
  });

  it("gives up after the timeout and reports it", async () => {
    runInBackground("slow", () => sleep(200));

    expect(await drainBackgroundTasks(20)).toBe(false);
    expect(await drainBackgroundTasks(1000)).toBe(true);
  });
});
