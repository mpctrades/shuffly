import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

// TEMPORARY — CLS/LCP diagnostic for the admin-performance investigation.
// Dev-only: import.meta.env.DEV is statically known at build time, so Vite
// tree-shakes this entire branch (including the web-vitals import) out of
// the production bundle. Remove this whole component once the fix is
// verified — it is not meant to ship.
function WebVitalsDebug() {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    import("web-vitals/attribution").then(({ onCLS, onLCP }) => {
      if (cancelled) return;
      onCLS((m) => {
        // eslint-disable-next-line no-console
        console.log("[CLS]", m.value, m.attribution.largestShiftTarget, m.attribution.largestShiftSource);
      });
      onLCP((m) => {
        // eslint-disable-next-line no-console
        console.log(
          "[LCP]",
          m.value,
          // `element` in older web-vitals; this installed version (6.x)
          // renamed the field to `target` but kept the same meaning — a
          // selector for the LCP element.
          m.attribution.target,
          "ttfb",
          m.attribution.timeToFirstByte,
          "render",
          m.attribution.elementRenderDelay,
        );
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

// Exposed so any ErrorBoundary (including this one, and app.tsx's nested
// one) can read the API key without depending on a route-specific loader
// that might be the very thing that failed. Not sensitive — it's the same
// public client id already sent to the browser in the App Bridge script tag.
export const loader = async () => {
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
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
        <WebVitalsDebug />
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
// Rendered `embedded={false}` on purpose: by the time an error gets here we
// can no longer assume a valid shop/host pair for App Bridge to initialize
// against, so this only guarantees Polaris styling, not embedding.
export function ErrorBoundary() {
  useRouteError();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
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
