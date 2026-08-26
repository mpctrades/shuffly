import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
  const target = settings?.onboardedAt ? "/app/collections" : "/app/onboarding";

  // Shopify loads this page with ?shop=...&host=...&embedded=1 in the URL —
  // App Bridge needs those to initialize. A bare-path redirect drops them,
  // which is what was causing the blank "missing configuration fields: shop"
  // error. Carry the original query string through.
  const url = new URL(request.url);
  return redirect(`${target}?${url.searchParams.toString()}`);
};
