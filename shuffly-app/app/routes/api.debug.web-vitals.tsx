import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";

// TEMPORARY — Phase 1 of the CLS/LCP investigation (Partner Dashboard:
// CLS=0.43 budget<0.1, LCP=3270ms budget<2500ms). A per-route feedback loop
// for shopify.webVitals.onReport(), so we don't have to wait on the 28-day
// dashboard window to see whether a fix moved the number. In-memory only —
// resets on redeploy/restart, single-container-appropriate, no DB writes.
// No auth: this only ever stores anonymized performance numbers (metric
// name, value, pathname, attribution strings), nothing shop- or
// customer-identifying. Remove this whole route before the final commit of
// the CLS/LCP work, per the investigation's own rules.

interface WebVitalsReport {
  receivedAt: string;
  pathname: string | null;
  // Shape of window.shopify.webVitals.onReport's payload isn't in any
  // installed type package — passed through as-is rather than guessed at.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  report: any;
}

const MAX_REPORTS = 500;
const reports: WebVitalsReport[] = [];

export const action = async ({ request }: ActionFunctionArgs) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return data({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const b = body as { pathname?: string; report?: unknown } | null;
  reports.push({
    receivedAt: new Date().toISOString(),
    pathname: b?.pathname ?? null,
    report: b?.report ?? b,
  });
  if (reports.length > MAX_REPORTS) reports.splice(0, reports.length - MAX_REPORTS);
  return data({ ok: true, stored: reports.length });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("clear") === "1") {
    reports.length = 0;
    return data({ ok: true, cleared: true });
  }
  return data({ count: reports.length, reports });
};
