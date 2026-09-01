# Shuffly

A Shopify embedded app that automatically re-orders the products inside your
manually-sorted collections on a schedule — pinning best-sellers, pushing
sold-out products to the end, boosting new arrivals, and giving every product
a fair turn near the front. Nothing runs on your storefront: Shuffly changes
the real product order inside Shopify via the Admin GraphQL API.

Built on Shopify's official React Router (formerly Remix) app template —
embedded via App Bridge, Polaris web components for the UI, Prisma/SQLite for
local dev data.

## What's implemented

- **Collections** — pick which manually-sorted collections Shuffly manages, add/remove, "Shuffle all now", a banner + one-click fix for collections that aren't on manual sort yet (Shopify only allows position-setting on manual-sort collections).
- **Workspace** (per collection) — pin count, sold-out/new-arrival/fairness toggles, schedule (daily / twice daily / weekly / manual-only), live product order, Shuffle now, Undo, and a run history.
- **Activity** — a shop-wide feed of every run, with Restore.
- **Insights** *(Pro plan)* — an estimate of how much of the catalogue has actually rotated into a featured position, derived from Shuffly's own run history (not storefront analytics — Shuffly adds no script to the storefront).
- **Settings** — timezone (read from Shopify), default run time, "never move products tagged …", and accurate access/performance/uninstall disclosures.
- **Plan** — Free / Starter / Pro / Agency, wired to the real Shopify Billing API (subscribe, cancel, test mode outside production).
- **Onboarding** — pick collections, try a real (unsaved) shuffle preview, turn it on.
- **Automatic scheduling** — an in-process poller (`app/lib/scheduler.server.ts`) runs due shuffles every minute; for multi-replica/serverless deployments, point an external cron at `POST /api/cron/run-shuffles` instead (protect it with a `CRON_SECRET` env var) and set `DISABLE_IN_PROCESS_SCHEDULER=1`.
- **Sold-out reaction** — `inventory_levels/update` (with `products/update` as a fallback) pushes a product to the end after Shopify reports the inventory change, without waiting for the next scheduled run.
- **Compliance webhooks** — `customers/data_request`, `customers/redact`, `shop/redact` (the last one cascade-deletes all of that shop's Shuffly data — see Settings' "If you uninstall" promise).
- **Only the scopes it uses** — `read_products`, `write_products`, `read_inventory`. No customer, order, or theme access.

All the Admin GraphQL used here (`collectionReorderProducts`, `collectionUpdate`, pagination, the Job-polling pattern) was validated against the live 2026-07 schema while building this — see `app/lib/collections.server.ts` for the exact operations.

## Local development

```shell
npm install
shopify app dev
```

Press `p` to open the app URL once the tunnel is up, install it on a dev store, and start clicking around. `shopify app dev` will also populate `.env` for you (API key/secret, app URL, scopes) the first time you run it, since this project is already linked to the app in your Partner/Dev Dashboard org.

```shell
npm run typecheck   # react-router typegen + tsc --noEmit
npm run lint
npm test             # vitest — pure logic: shuffle algorithm, scheduling/timezone math, plan pricing, reorder diffing
npm run build        # production build
```

The dev database is a local SQLite file (`prisma/dev.sqlite`). Run `npx prisma studio` to browse it.

## Before submitting to the App Store

A few things are intentionally left for you, since they're business decisions or need a real store to produce:

- [ ] **Confirm the name.** Web research (2026-09-01) found no exact Shopify App Store listing named Shuffly, but the closely named and functionally similar “Shuffler: Sort & Shuffle” is live, and `shuffly.com` belongs to another business. Shopify and trademark clearance are still required before submission.
- [ ] **Privacy policy** — `app/routes/privacy.tsx` now matches the app's scopes and stored data, but still needs a legal review plus the operator's address, infrastructure/subprocessor details, international-transfer basis, and exact log-retention period.
- [ ] **Support email** — referenced in the privacy policy and Settings; wire up a real inbox.
- [ ] **Screenshots + demo store** for the listing — a large catalogue with a couple of sold-out items sitting high, one collection already shuffled, makes the point in one screenshot.
- [ ] **GraphQL codegen** — `npm run graphql-codegen` (config already in `.graphqlrc.ts`) will give the ad-hoc queries in `collections.server.ts` full generated types instead of the couple of `any` escape hatches currently there.
- [x] **Production cron strategy** — confirmed: the real deployment (`dev.shuffly.mpctrades.com`) is a single persistent Docker container, exactly the case `app/lib/scheduler.server.ts`'s in-process poller targets, and it's already wired up (started once from `app/shopify.server.ts`). No action needed unless you move to multiple replicas or serverless, in which case switch to the external `POST /api/cron/run-shuffles` + `DISABLE_IN_PROCESS_SCHEDULER=1` path described above.
