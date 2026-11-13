// Work that runs after a response has already been sent — today, the
// sold-out reactions behind the products/update and inventory_levels/update
// webhooks, which answer Shopify first and touch the Admin API afterwards.
//
// A bare `void promise` is lost the moment the container stops: a deploy
// sends SIGTERM, and anything mid-flight is cut off with nothing logged.
// Registering it here lets the shutdown hook below wait for it, and gives
// tests a way to await work the handler deliberately didn't.

declare global {
  // eslint-disable-next-line no-var
  var __shufflyBackgroundTasks: Set<Promise<unknown>> | undefined;
  // eslint-disable-next-line no-var
  var __shufflyShutdownHooks: Array<() => void> | undefined;
  // eslint-disable-next-line no-var
  var __shufflyShutdownInstalled: boolean | undefined;
}

const tasks = (globalThis.__shufflyBackgroundTasks ??= new Set());
const shutdownHooks = (globalThis.__shufflyShutdownHooks ??= []);

/** Docker's stop timeout is set above this in docker-compose.yml, so the
 * drain finishes (or gives up) before the container is killed outright. */
const DRAIN_TIMEOUT_MS = 50_000;

/** Run `work` without awaiting it. Failures are logged under `label`, never
 * thrown — the caller has already answered and has nobody left to tell. */
export function runInBackground(label: string, work: () => Promise<unknown>): void {
  const task = Promise.resolve()
    .then(work)
    .catch((err) => {
      console.error(`[background] ${label} failed:`, err);
    })
    .finally(() => {
      tasks.delete(task);
    });
  tasks.add(task);
}

/** Await everything registered so far, including work those tasks register
 * while they run. Resolves `false` if `timeoutMs` passes first. */
export async function drainBackgroundTasks(timeoutMs = DRAIN_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (tasks.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining);
    });
    const outcome = await Promise.race([Promise.allSettled([...tasks]), timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") return false;
  }
  return true;
}

/** Called first on shutdown, before draining — e.g. to stop the scheduler
 * from starting a new sweep while the old work finishes. */
export function onShutdown(hook: () => void): void {
  shutdownHooks.push(hook);
}

/**
 * On SIGTERM/SIGINT: stop starting new work, let in-flight work finish, then
 * exit. react-router-serve closes the HTTP server on the same signals, but the
 * scheduler's interval would otherwise keep Node alive until Docker kills it,
 * cutting off whatever was running.
 */
export function installGracefulShutdownOnce(): void {
  if (globalThis.__shufflyShutdownInstalled) return;
  globalThis.__shufflyShutdownInstalled = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`[shutdown] ${signal}: waiting for ${tasks.size} background task(s)`);
      for (const hook of shutdownHooks) {
        try {
          hook();
        } catch (err) {
          console.error("[shutdown] hook failed:", err);
        }
      }
      void drainBackgroundTasks().then((drained) => {
        console.log(drained ? "[shutdown] drained, exiting" : `[shutdown] gave up on ${tasks.size} task(s), exiting`);
        process.exit(0);
      });
    });
  }
}
