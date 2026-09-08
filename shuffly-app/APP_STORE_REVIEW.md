# Shopify App Store review — Shuffly

Reviewed September 1, 2026 against Shopify's current [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), [submission checklist](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review), [privacy requirements](https://shopify.dev/docs/apps/launch/privacy-requirements), and the Shopify AI Toolkit's canonical self-review checklist.

## Verdict

**Not ready to submit yet.** The repository has no known failing automated requirement after the fixes in this review, but submission still depends on the Partner Dashboard, production-store tests, listing assets, and legal/business details that cannot be completed from source code.

## Shopify AI Toolkit checklist

Legend: ✅ supported by code/config; ⚠️ needs a real Partner test. There are no remaining known code failures in the checklist's applicable groups.

| Requirement | Status | Evidence / remaining test |
|---|---:|---|
| 1.1.1 Session-token authentication | ⚠️ | App Bridge CDN and Shopify React Router authentication are used; test embedded navigation in Chrome Incognito with third-party cookies blocked. |
| 1.1.2 Shopify checkout | ✅ | No buyer checkout or offsite payment flow. |
| 1.1.3 Theme Store only | ✅ | No theme download/install/write functionality. |
| 1.1.4 Factual information | ✅ | Unimplemented controls and unsupported timing/status claims were removed; listing content still needs human review. |
| 1.1.6 Single-merchant storefront | ✅ | No marketplace or multi-seller functionality. |
| 1.1.7 Payments API authorization | ✅ | Not a payment gateway app. |
| 1.1.8 Shopify POS only | ✅ | No POS integration. |
| 1.1.9 Buyer consent for charges | ✅ | No buyer fees or cart charges. |
| 1.1.10 Cheapest shipping default | ✅ | No shipping customization. |
| 1.1.13 Authorized product information | ✅ | Reads only the installed merchant's products. |
| 1.1.14 No agency/developer marketplace | ✅ | Support links reach Shuffly's own support. |
| 1.1.15 Original-processor refunds | ✅ | No refund functionality. |
| 1.1.16 No capital lending | ✅ | No lending functionality. |
| 1.2.1 Shopify Billing | ✅ | Paid plans use Shopify managed pricing; no external app billing. |
| 1.2.2 Billing correctness | ⚠️ | Shopify itself runs approval, replacement, proration and cancellation under managed pricing; the app only reads the result back via `billing.check`. Test approval, decline, abandoned approval, uninstall, and reinstall in a development store. |
| 1.2.3 In-app plan changes | ✅ | The Plan page's "View plans & pricing" button opens Shopify's managed pricing page from inside the app, where upgrade, downgrade, monthly↔annual and cancellation all happen — no support contact, no reinstall. Verified end-to-end in a development store on September 7, 2026. Shopify records the charges, so app charge history is its responsibility, not the app's. |
| 2.2.1 Shopify APIs | ✅ | Uses Admin GraphQL for collections, products, inventory, and shop data. |
| 2.2.3 Latest App Bridge | ✅ | `app-bridge.js` is in the document head before other scripts. |
| 2.2.4 GraphQL Admin API | ✅ | No REST Admin API calls found; operations match the configured 2026-07 API. |
| 2.2.6 No promotions in admin extensions | ✅ | No admin extensions are present. |
| 2.2.7 Merchant-triggered Max modal | ✅ | No Max modal/fullscreen API usage. |
| 2.3.1 Shopify-owned install initiation | ✅ | Manual shop-domain form is development-only and cannot render in production. |
| 2.3.2 Authenticate after install | ⚠️ | Standard Shopify auth library flow is present; verify a fresh App Store-style install. |
| 2.3.3 Redirect to UI | ⚠️ | Auth routes target the embedded app; verify the post-consent landing page. |
| 2.3.4 OAuth after reinstall | ⚠️ | Prisma session storage supports replacement sessions; verify uninstall/reinstall on the same shop. |
| 3.1.1 TLS | ✅ | Configured app and privacy URLs served valid HTTPS during review. Confirm the same deployment is used for submission. |
| 3.2.1 `read_all_orders` | ✅ | Not requested. |
| 3.2.2 `write_payment_mandate` | ✅ | Not requested. |
| 3.2.3 `write_checkout_extensions_apis` | ✅ | Not requested. |
| 3.2.4 `read_advanced_dom_pixel_events` | ✅ | Not requested. |
| 3.2.5 `read_checkout_extensions_chat` | ✅ | Not requested. |

Skipped as not applicable: 5.1 Online store, 5.2 Payment, 5.4 Purchase option, 5.6 Checkout customization, 5.7 Sales channel, and 5.8 Post-purchase (there is no `shopify.extension.toml` and none of their scopes/targets). The opt-in groups 5.3 Payment facilitator, 5.5 Product sourcing, 5.9 Mobile app builders, and 5.10 Donation were also skipped because Shuffly provides none of those functions.

## Plan switching failure reported in review

Shopify's September 2026 review rejected the app under 1.2.3 with a screencast showing an error on every plan selection. The cause was not in the page's own logic:

**Shuffly is on Shopify managed pricing, and managed pricing forbids the Billing API.** The plans are defined in the Partner Dashboard, and Shopify renders its own plan-selection page at `https://admin.shopify.com/store/<store>/charges/<app handle>/pricing_plans`. With that in place, `appSubscriptionCreate` is refused outright. Every plan click hit the server and came back 500:

```
BillingError: Error while billing the store
errorData: [{ field: null,
  message: 'Cannot use the Billing API (to create charges) when on Shopify App Pricing.' }]
POST /app/plan.data 500
```

Reproduced on `shuffly-kd37m7ec.myshopify.com` on September 7, 2026, from the app's own Plan page.

The Plan page now hands every plan change to Shopify's pricing page instead of creating charges itself.

**How the handoff works.** The Plan page's "View plans & pricing" CTA is a plain anchor — `<a href="https://admin.shopify.com/store/<store>/charges/<app handle>/pricing_plans" target="_top">` — which is App Bridge's documented Navigation API for reaching an admin page outside the app's iframe.

Two earlier attempts were wrong and are worth recording so they aren't repeated:

1. A client-side `window.open(url, "_top")` from the Plan page. Embedded apps have no permission to move the parent window, so this silently did nothing.
2. A loader-only `/app/change-plan` route that answered with the admin context's `redirect(pricingUrl, { target: "_top" })`. That *did* reach Shopify's page, but it broke Shopify's own "← Select a plan" arrow. The arrow is not `history.back()` — verified by arriving at the pricing page from `/orders` and watching it return to `/apps/shuffly/app/plan` — it returns the merchant to the app's **last visited route**. After the hop that route was `/app/change-plan`, whose loader immediately redirected back out to the pricing page, so the URL never appeared to leave it.

Linking directly means no intermediate app route is ever visited, `/app/plan` stays the remembered route, and the back arrow returns to the Plan page. `app/routes/app.change-plan.tsx` survives as a safety net: any merchant whose remembered route is still `/app/change-plan` is redirected to `/app/plan` using the *admin context's* `redirect` — React Router's plain `redirect` drops the `embedded`/`shop`/`host` query parameters, and the Plan page then renders Shopify's "Something went wrong" with no admin context.

Verified working in the `shuffly-kd37m7ec` development store on September 7, 2026: clicking through from the Plan page lands on Shopify's plan selection page with no error.

**The Plan page no longer shows prices.** It used to render its own three-card pricing table, which contradicted Shopify's: this app said "Starter $3.99/month" while Shopify's page said "$39.90 / year", "$0", "30 trial days". Two disagreeing price lists is both confusing and a 1.1.4 accuracy risk, and only Shopify's page knows the real prices, trials and billing cycle. The page now shows what Shopify's cannot — the active plan, live collection usage against that plan's cap, the next charge, what the next tier would add, and how many collections a drop to Free would pause — and every capability line is derived from `PLANS` rather than hand-written, so no claim can drift from what the code enforces. One "View plans & pricing" button leads to Shopify.

**Plan-name matching is now normalized — defensively, not as a bug fix.** An earlier note here claimed `planIdFromSubscriptionName` would have reported a paying merchant as Free, because the pricing page displays the plans as "Free", "Starter" and "PRO" while the map keyed on `STARTER`/`PRO`. That was wrong: the *display* name and the name `billing.check()` returns are different fields. The Partner Dashboard's "Plan name for merchant invoices" values are `STARTER`, `PRO` and `Free`, so the original exact-match map resolved all three correctly (`Free` fell through to the `FREE` default). Matching is still normalized for case, punctuation and a trailing billing-cycle word, so `Starter`, `STARTER_ANNUAL` and `Starter (yearly)` all resolve to `STARTER` — that is robustness against a future plan rename, not a defect that was live. An unrecognized name still falls back to `FREE` rather than granting paid features.

Two related corrections landed with them:

- `billing.check({ isTest: true })` — on `check`, `isTest` means *"also count test charges"*, not *"create one"*. It must stay `true` regardless of environment: development stores, and stores inside managed pricing's trial, hold a test subscription, so `isTest: false` filtered out the very plan the merchant had just picked.
- The "Test mode" badge and `SHOPIFY_BILLING_TEST` were removed. The app no longer creates charges, so a flag claiming to control whether they are test charges controlled nothing, and the badge would have been a false statement to merchants (1.1.4).

### What was superseded

An earlier pass at this rejection diagnosed it as the App Bridge `Authorization` header making `billing.request()` throw a bare `401` that React Router turned into an `ErrorResponse`, so `app/routes/app.tsx`'s boundary rendered `boundary.error`'s empty-bodied fallback in place of the Plan page. That mechanism is real and the unwrap worked, but it was not the cause here — the Billing API never got far enough to redirect. Those helpers are gone, since the Billing API cannot be called by this app at all.

## Fixed in source

- Plan changes are handed to Shopify's managed pricing page rather than attempted through the Billing API, which this app is not permitted to use. Shopify remains the source of truth, and `billing.check` re-derives entitlements on every Plan page load.
- Collection limits, schedule availability, pinning, onboarding defaults, and undo retention are now enforced server-side and reflected in the UI.
- Expired undo snapshots are pruned while activity records remain available.
- Onboarding now honors the active plan, persists the previewed rules, and validates submitted collections against Shopify.
- Removed the public, unauthenticated Web Vitals diagnostics endpoint and unconditional debug beacon.
- Removed unfinished Email, Export, Judge.me Connect, and false Shopify Flow/status controls.
- Corrected privacy and Settings disclosures to include `read_inventory` and authenticated-session data; compliance handlers no longer log customer IDs and explicitly delete all shop data tables.
- Worked around the current Shopify React Router 1.2.1 revoked-token webhook bug for `app/uninstalled` and compliance topics: these endpoints validate Shopify's HMAC without trying to refresh a revoked offline token, so cleanup still runs after uninstall.
- Removed unsupported sold-out timing, response-time, live-status, and setup-speed claims; unified the public support email.
- Kept the legacy Agency billing definition for existing subscribers but blocked new merchant selection, so public pricing has only Free, Starter, and Pro.

## Submission blockers outside source code

Complete every unchecked item before clicking **Submit for review**.

### App setup and data access

- [ ] Confirm `https://dev.shuffly.mpctrades.com` is the permanent production deployment (not a tunnel, staging service, or development server). If not, replace `application_url`, redirect URLs, webhook URLs, privacy URL, and Dashboard URLs with the final HTTPS host.
- [ ] Deploy this reviewed commit and a Shopify app configuration version, then confirm Dashboard configuration matches `shopify.app.toml` exactly.
- [ ] In API access, confirm only `read_products`, `write_products`, and `read_inventory`; opt out of protected customer data / select Level 0 because no protected customer data is used.
- [ ] Run the Dashboard automated checks and clear every reported issue.
- [ ] Verify all mandatory compliance webhook deliveries receive 2xx responses and test `shop/redact` against a disposable shop.

### Contacts, URLs, and legal

- [ ] Activate and monitor `support@mpctrades.com`; make sure it is the support email everywhere.
- [ ] Add the app/API contact email and an emergency developer contact with both email and phone. Allow mail from `noreply@shopify.com`.
- [ ] Add the public support URL and `https://dev.shuffly.mpctrades.com/privacy` (or its final-host equivalent).
- [ ] Have counsel finish the privacy policy: legal operator name and physical address, hosting/subprocessors, international-transfer basis, exact operational-log retention, and the merchant data-rights/request process.
- [ ] Decide whether “Priority support” is operationally real for Pro and document the SLA; otherwise remove that plan claim before submission.
- [ ] Clear the name with Shopify and trademark counsel. No exact “Shuffly” listing was found, but “Shuffler: Sort & Shuffle” is a close, directly competing live listing and `shuffly.com` belongs to another company.

### Pricing

- [ ] Configure/list exactly: Free $0; Starter $3.99/month or $39.90/year; Pro $7.99/month or $79.90/year; no trial unless one is added in code and tested.
- [ ] Test upgrade, paid downgrade, monthly↔annual change, decline, cancellation to Free, uninstall/reinstall, and application charge history using Shopify test charges.
- [ ] Confirm the listing's pricing section contains every public charge and that no subtitle, description, screenshot, or feature graphic contains pricing.

### Listing

- [ ] Use **Shuffly** consistently for the app name and listing; choose English as the only supported listing language unless the entire embedded UI is translated.
- [ ] Choose the Collections category and only accurate collection-sorting tags (automated/manual/custom rules/push down/bulk management as available in the Dashboard).
- [ ] Upload a 1200×1200 PNG/JPEG app icon; `app/assets/brand/shuffly-icon-orange-1200.png` is ready.
- [ ] Write a factual subtitle and description with no testimonials, reviews, rankings, “best/first/only” claims, statistics, unsupported performance guarantees, keyword stuffing, or pricing outside the pricing section.
- [ ] Upload real, unique app screenshots with no browser chrome, device frames, price text, merchant/customer personal data, or unrelated Shopify/third-party branding.
- [ ] Add accurate geographic availability, feature tags, integrations, and online-store requirements. Shuffly has no theme dependency, so do not claim a theme/app-block requirement.
- [ ] If the public marketing website is used as the developer/support website, replace its remaining “early access,” “working title,” and “not yet on the App Store” launch copy with final, accurate status copy at launch.

### Review test package

- [ ] Record an English demo screencast (or add English subtitles) showing install/OAuth, onboarding, manual-sort handling, automatic/manual shuffle, plan change/cancel, and Undo.
- [ ] Prepare a development test shop with manually sorted collections, enough products, new arrivals, and sold-out inventory to exercise every advertised rule.
- [ ] Give reviewers exact step-by-step test instructions and any credentials they need. State that there is no separate external account login.
- [ ] Test fresh install and same-shop reinstall in Chrome Incognito with third-party cookies blocked; confirm no blank page, cookie loop, manual domain prompt, or dead end.
- [ ] Test every page and action at desktop and narrow Admin widths, including empty/loading/error states, billing decline, scope change, and uninstall/reinstall.

## Automated evidence

- Shopify CLI 4.7.0: `shopify app config validate --json` → valid, no issues.
- TypeScript typecheck → passed.
- ESLint → passed.
- Vitest → 7 files / 65 tests passed.
- Production React Router build → passed.
- App icon → 1200×1200 PNG.
- Live app, privacy, and marketing hosts returned valid HTTPS during review.
