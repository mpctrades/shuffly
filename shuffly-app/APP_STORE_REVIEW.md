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
| 1.2.1 Shopify Billing | ✅ | Paid plans use Shopify's Billing API; no external app billing. |
| 1.2.2 Billing correctness | ⚠️ | Approval/replacement/cancellation code is corrected; test approval, decline, abandoned approval, uninstall, and reinstall in a development store. |
| 1.2.3 In-app plan changes | ⚠️ | Upgrade, paid downgrade, annual/monthly replacement, and cancellation are available in-app; verify charge history and effective entitlements in a development store. |
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

## Fixed in source

- Paid plan downgrades now request a replacement Shopify subscription instead of canceling billing and granting the target plan locally. Shopify remains the source of truth.
- Cancellation errors are no longer swallowed. Free is applied only after a successful cancellation.
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
