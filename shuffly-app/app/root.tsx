import { useEffect } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

// Exposed so any ErrorBoundary (including this one, and app.tsx's nested
// one) can read the API key without depending on a route-specific loader
// that might be the very thing that failed. Not sensitive — it's the same
// public client id already sent to the browser in the App Bridge script tag.
export const loader = async () => {
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function AppBridgeHead({ apiKey }: { apiKey: string }) {
  return (
    <>
      <meta name="shopify-api-key" content={apiKey} />
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
    </>
  );
}

// TEMPORARY — Phase 1 of the CLS/LCP investigation (Partner Dashboard:
// CLS=0.43 budget<0.1, LCP=3270ms budget<2500ms). Shopify's own debug flag —
// logs real-time Web Vitals with attribution (which element shifted/was the
// LCP element) straight from the runtime Shopify actually grades, unlike
// Lighthouse against this iframed app. Deliberately NOT gated behind
// import.meta.env.DEV: process.env.NODE_ENV and Vite's import.meta.env.DEV
// are independent flags (dev.shuffly.mpctrades.com runs via `vite dev`,
// which sets DEV=true regardless of NODE_ENV) — rather than assume which
// way that resolves on whatever's live, this stays unconditional so it's
// guaranteed visible on the exact deployment being measured. Remove this
// meta tag before the final commit of the CLS/LCP work, per the
// investigation's own rules.
function ShopifyDebugHead() {
  return <meta name="shopify-debug" content="web-vitals" />;
}

// TEMPORARY — Phase 1 step 3 (optional): mirrors shopify.webVitals.onReport
// to a local endpoint (app/routes/api.debug.web-vitals.tsx) so per-route
// numbers can be pulled on demand instead of waiting on the console or the
// 28-day dashboard window. Feature-detected — `webVitals` isn't in any
// installed App Bridge type package, so this only activates if the
// CDN-loaded runtime actually exposes it; if it doesn't, this is a silent
// no-op and Phase 1 falls back to reading the shopify-debug console output
// directly. Same "why not DEV-gated" reasoning as ShopifyDebugHead. Remove
// before the final commit.
function WebVitalsReporter() {
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shopifyGlobal = (window as any).shopify;
    const onReport = shopifyGlobal?.webVitals?.onReport;
    if (typeof onReport !== "function") return;

    const unsubscribe = onReport((report: unknown) => {
      fetch("/api/debug/web-vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pathname: window.location.pathname, report }),
        keepalive: true,
      }).catch(() => {
        /* best-effort diagnostic beacon — never block or throw on failure */
      });
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);
  return null;
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <AppBridgeHead apiKey={apiKey} />
        <ShopifyDebugHead />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <Meta />
        <Links />
      </head>
      <body>
        <WebVitalsReporter />
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// Last-resort boundary for anything that escapes every nested route's own
// ErrorBoundary (e.g. app.tsx's, which only handles Shopify's own
// ErrorResponse shape and rethrows everything else). Root has no parent to
// supply <html>/<head>/<body>, so it has to render the full document itself.
export function ErrorBoundary() {
  useRouteError();
  const rootData = useRouteLoaderData<typeof loader>("root");

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <AppBridgeHead apiKey={rootData?.apiKey ?? ""} />
        <ShopifyDebugHead />
        <Meta />
        <Links />
      </head>
      <body>
        <AppProvider embedded={false}>
          <s-page heading="Something went wrong">
            <s-banner tone="critical" heading="This page hit an unexpected error">
              <s-paragraph>
                Try reloading the page. If this keeps happening, contact support from the Help page.
              </s-paragraph>
            </s-banner>
          </s-page>
        </AppProvider>
        <Scripts />
      </body>
    </html>
  );
}
