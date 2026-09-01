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

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <AppBridgeHead apiKey={apiKey} />
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
