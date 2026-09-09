import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { WEBSITE_URL } from "../lib/app-config";
import { syncPlanIfStale } from "../lib/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);

  // Every embedded page passes through this layout, so this is where a
  // downgrade or a lapsed trial gets noticed. It used to be reconciled only
  // by the Plan page's loader, which meant a shop that stopped paying kept
  // its paid collection cap, pins and undo retention until somebody happened
  // to open that one page. Throttled, so browsing doesn't re-ask Shopify on
  // every navigation.
  //
  // Never fatal: a billing hiccup must not blank the whole app, and the
  // cached plan is a perfectly good answer until the next page load.
  try {
    await syncPlanIfStale(session.shop, billing);
  } catch (err) {
    console.error("[app] plan sync failed, using the cached plan:", err);
  }

  return null;
};

function EmbeddedAppProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const href = (event.target as Element | null)?.getAttribute("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate);
    return () => document.removeEventListener("shopify:navigate", handleNavigate);
  }, [navigate]);

  // App Bridge is loaded once in root.tsx's document <head>, as required by
  // Built for Shopify. This provider still loads Polaris for every app route.
  return <AppProvider embedded={false}>{children}</AppProvider>;
}

export default function App() {
  return (
    <EmbeddedAppProvider>
      <s-app-nav>
        <s-link href="/app/collections">Collections</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/insights">Insights</s-link>
        <s-link href="/app/plan">Plan</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/help">Help</s-link>
        <s-link href={WEBSITE_URL} target="_blank">Website</s-link>
      </s-app-nav>
      <Outlet />
    </EmbeddedAppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
// Keep Polaris styling and App Bridge navigation behavior when Shopify's
// authentication helper throws a response handled by this route boundary.
export function ErrorBoundary() {
  return (
    <EmbeddedAppProvider>
      {boundary.error(useRouteError())}
    </EmbeddedAppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
