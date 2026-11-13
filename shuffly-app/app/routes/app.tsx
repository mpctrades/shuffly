import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunction } from "react-router";
import { Outlet, useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { WEBSITE_URL } from "../lib/app-config";
import { syncPlanIfStale } from "../lib/billing.server";
import db from "../db.server";
import { I18nProvider, makeT, normalizeLang, type Lang } from "../i18n";

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

  return { lang: await resolveLang(request, session.shop) };
};

/**
 * The language the app renders in (Update 2): the admin user's own Shopify
 * locale, which App Bridge puts on the embedded URL as `locale`. Internal
 * navigations don't always carry it, so the last one seen is remembered in
 * ShopSettings.language (a column that existed but was never read) and used
 * when the URL doesn't say. Never fatal: English is always a fine answer.
 */
async function resolveLang(request: Request, shop: string): Promise<Lang> {
  try {
    const fromUrl = normalizeLang(new URL(request.url).searchParams.get("locale"));
    const stored = await db.shopSettings.findUnique({ where: { shop }, select: { language: true } });
    if (fromUrl && stored && stored.language !== fromUrl) {
      await db.shopSettings.update({ where: { shop }, data: { language: fromUrl } });
    }
    return fromUrl ?? normalizeLang(stored?.language) ?? "en";
  } catch (err) {
    console.error("[app] couldn't resolve the language, using English:", err);
    return "en";
  }
}

// This layout's loader only reconciles the plan (throttled), so a background
// poll — a page calling revalidator.revalidate() on the same URL with no form
// submission — has nothing to gain from re-running it. Navigations and form
// submissions keep React Router's default behavior.
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) => {
  if (!formMethod && currentUrl.href === nextUrl.href) return false;
  return defaultShouldRevalidate;
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
  const data = useLoaderData<typeof loader>();
  // This component renders the provider, so it can't read it via useT().
  const t = makeT(data?.lang ?? "en");
  return (
    <I18nProvider lang={data?.lang ?? "en"}>
    <EmbeddedAppProvider>
      <s-app-nav>
        <s-link href="/app/collections">{t("nav.collections")}</s-link>
        <s-link href="/app/activity">{t("nav.activity")}</s-link>
        <s-link href="/app/insights">{t("nav.insights")}</s-link>
        <s-link href="/app/plan">{t("nav.plan")}</s-link>
        <s-link href="/app/settings">{t("nav.settings")}</s-link>
        <s-link href="/app/help">{t("nav.help")}</s-link>
        <s-link href={WEBSITE_URL} target="_blank">{t("nav.website")}</s-link>
      </s-app-nav>
      <Outlet />
    </EmbeddedAppProvider>
    </I18nProvider>
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
