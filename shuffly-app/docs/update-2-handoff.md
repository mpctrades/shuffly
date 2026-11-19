# Update 2 — handoff for Arthur

**Branch:** `update-2-unlimited-pro` (from `collections-toolbar`). **Prices unchanged.** Nothing has been sent to any customer.

## What changed

- **Pro: unlimited shuffles, as often as every hour.** Each collection can run every 1, 2, 3, 4, 6 or 12 hours, daily or weekly. One hour is the minimum on every plan. Hourly schedules count from when you save and aren't affected by daylight-saving changes. Existing "twice daily" Pro schedules keep running exactly as before and show as "Twice daily (current)" until changed.
- **Reshuffle when new products arrive (Pro).** Checked every 15 minutes. After new products are detected it waits 10 minutes for the import to finish, then runs one shuffle. At most once an hour per collection, and it skips if a scheduled run is due within 15 minutes. Logged as "Triggered by new products (N added)".
- **Keep new arrivals on top (Pro),** for 24 h, 48 h, 72 h or 7 days. Order: pinned → new arrivals (newest first) → fair rotation → sold-out last. Products with a never-move tag stay where they are.
- **"New arrivals" one-click setup:** every 2 hours + reshuffle on new products + new on top for 48 h. It shows as a banner on collections whose title contains new / nouveau / arrival / latest, and as a link on every other card. On Free/Starter it opens the plan page, and the setup is applied by itself once the shop upgrades (within 14 days).
- **New collection screen:** one card per collection (frequency, new arrivals, fixed products, last run + Undo, Shuffle now). Pro-only options are greyed on lower plans with a badge naming the plan that unlocks them.
- **Safety at hourly volume:** one run at a time per collection; only the products that need to move are sent; batches of 250 that wait for Shopify between batches; collections over 2,000 products are now shuffled in full. If a merchant changes the sort away from Manual, the collection pauses with a warning on its card and resumes once it's Manual again.
- **Plans enforced on the server, including after downgrades done in Shopify admin** (new `app_subscriptions/update` webhook). Pro → Starter: Daily at the same time of day; → Free: Weekly. New-arrivals options are turned off and a notice lists what changed.
- **French** for the Collections screen, the card, the setup and the new Activity messages (follows the admin's language).

## How to test on the dev store

Full step-by-step for all nine checks: **`docs/update-2-qa.md`**. Quick path:
1. Deploy the branch, then **`shopify app deploy`**. This registers the new webhook. No new permissions, so merchants won't see a re-approval prompt.
2. Give the dev store **Pro**, open Collections, and on a collection called e.g. "New Arrivals" click **Use "New arrivals" setup**.
3. Import ~50 products into it. About 10–25 minutes later Activity should show one "Triggered by new products (50 added)" and the new products should be on top.
4. Downgrade to **Starter** and check the notice and the Daily fallback.
5. Switch the admin to French and look over the Collections screen.

## Known limitations

- **Not yet tested on a real store.** Everything is covered by automated tests (407 passing); the dev-store pass is yours (`docs/update-2-qa.md`).
- **French is partial.** Dialogs, Workspace, Insights, Settings, Plan, Help, Onboarding and older Activity messages are still English. **Don't publish the French listing yet.** Shopify expects a listed language to cover the whole app (see `docs/update-2-listing-copy.md`).
- **New-products timing is 10–25 minutes, not instant.** Webhook-based triggering is planned for v2. The listing copy says "automatically", never "instantly".
- **Undo pauses the collection** (as before), so an hourly schedule doesn't immediately reshuffle it. Resume from the card's ⋯ menu.
- **Free undo is 1 day** in the app, though the brief's table shows "—". The listing copy leaves it out.
- **"Excluded" on the card** counts products with the shop's never-move tags, as of the last run. Per-collection exclusions and type/vendor exclusions don't exist (the brief's §2 mentions them).

## For the listing

- EN + FR copy for the main bullet, the Pro bullets and the pricing page: **`docs/update-2-listing-copy.md`**.
- **Screenshot needed:** the new collection card. Spec: a "New Arrivals" collection, ~1,000 products, Every 2 hours, both new-arrivals options on (48 h), "Next shuffle in 42 min", "3 pinned · 2 excluded", "Last run: today …" with Undo. English admin, desktop width, no prices.

When you're happy, you write to Atlas Records. We haven't contacted them.
