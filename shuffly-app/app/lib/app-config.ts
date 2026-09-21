// App-wide contact and link constants.
//
// These were hardcoded in five places across three routes, so changing the
// support address meant finding all of them. Deliberately NOT a `.server.ts`
// file: the app nav, the Help page and the public privacy page all render
// these in client components, and React Router refuses to let
// client-rendered code import from a `.server.ts` module (same reasoning as
// plans.ts and time-slots.ts).
//
// The App Store listing's own support email and website fields are edited in
// the Partner Dashboard, not here — these only cover what the app itself
// renders.

/** Where merchants reach support, everywhere the app mentions it. */
export const SUPPORT_EMAIL = "team@mpctrades.com";

/**
 * Shuffly's public website.
 *
 * ⚠️ This is the value Arthur is still confirming — it currently points at
 * the same page it always has. When he supplies the app's official URL, this
 * single line is the only edit needed: the app nav (app/routes/app.tsx), the
 * Help page's Website button, and anything added later all read it from
 * here. The Partner Dashboard listing field is separate and edited there.
 */
export const WEBSITE_URL = "https://shuffly.mpctrades.com";

/** `mailto:` for the support address, with a subject that tells us which app
 * the message is about. */
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=Shuffly%20support`;
