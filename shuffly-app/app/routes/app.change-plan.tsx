// Kept only as a safety net. This route used to be the hop that took a
// merchant out to Shopify's plan-selection page, via the admin context's
// `redirect(..., { target: "_top" })`.
//
// That broke Shopify's own "← Select a plan" back arrow. The arrow doesn't
// call history.back() — it returns the merchant to the app's *last visited
// route*, and after the hop that route was /app/change-plan, whose loader
// promptly redirected them back out to the pricing page. The URL never
// appeared to leave it.
//
// The Plan page now links straight to the pricing page with an
// `<a target="_top">` (App Bridge's Navigation API), so no intermediate app
// route is ever visited and /app/plan stays the remembered route. This file
// stays behind so that any merchant whose remembered route is still
// /app/change-plan — or any old bookmark — lands on the Plan page instead of
// a 404.
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // The admin context's own `redirect`, not React Router's: for a same-origin
  // target it copies this request's `embedded`/`shop`/`host`/`id_token` across.
  // React Router's plain `redirect` drops them, and /app/plan then loads with
  // no admin context at all and renders "Something went wrong".
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/plan");
};
