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
  if (!secret) return true; // no secret configured — open (fine for local dev only)
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
