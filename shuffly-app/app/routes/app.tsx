import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, useRouteLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import type { loader as rootLoader } from "../root";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
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
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
// Wrapped in AppProvider so a thrown response (e.g. a reauth redirect) still
// renders with Polaris styling and the App Bridge script, instead of the
// bare, unstyled HTML the library's boundary.error() returns on its own.
// apiKey comes from the root loader, not this route's own — this route's
// loader (which calls authenticate.admin) may be the very thing that threw.
export function ErrorBoundary() {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  return (
    <AppProvider embedded apiKey={rootData?.apiKey ?? ""}>
      {boundary.error(useRouteError())}
    </AppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
