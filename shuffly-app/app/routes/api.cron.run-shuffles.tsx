import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { runDueShuffles } from "../lib/cron.server";

// Point an external scheduler (platform cron, GitHub Actions on a schedule,
// cron-job.org, ...) at this endpoint every few minutes if you're not
// relying on the in-process scheduler (see app/lib/scheduler.server.ts) —
// e.g. across multiple replicas or a serverless deployment.
//
//   curl -X POST https://<your-app-url>/api/cron/run-shuffles \
//     -H "Authorization: Bearer $CRON_SECRET"

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured: open in local dev (NODE_ENV isn't "production"),
    // but closed by default in production — this endpoint would otherwise
    // let anyone on the internet trigger shuffle runs for every shop, and
    // "remember to set CRON_SECRET" isn't a safe thing to depend on. If
    // you're relying on the in-process scheduler (the default for this
    // app's single-container Dockerfile), this route isn't even needed —
    // just leave CRON_SECRET unset and it'll stay locked.
    return process.env.NODE_ENV !== "production";
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorized(request)) return data({ error: "Unauthorized" }, { status: 401 });
  const result = await runDueShuffles();
  return data(result);
};

// Some cron providers only support GET.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!authorized(request)) return data({ error: "Unauthorized" }, { status: 401 });
  const result = await runDueShuffles();
  return data(result);
};
