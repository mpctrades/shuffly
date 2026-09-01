import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
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
        <s-link href="https://shuffly.mpctrades.com" target="_blank">Website</s-link>
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
