# Update 2 — QA results

Branch `update-2-unlimited-pro`, 12 Nov 2026.

## Summary

| Check | Result |
|---|---|
| Unit/integration tests (`npm test`) | ✅ **407 passed**, 33 files (baseline before this update: 274 passed, 20 files) |
| Typecheck (`tsc --noEmit`) | ✅ 0 errors |
| Production build (`npm run build`) | ✅ client + server bundles build |
| Lint (`eslint` on changed files) | ⏳ still running when this was written (see "Tooling on this machine") |
| §10 dev-store checklist | ⚠️ **Not run on a dev store.** Every item is covered by automated tests (below); the dev-store steps are written out for Arthur. |

**I did not run anything against a Shopify store.** You approved writing manual steps for the dev-store items (Q9), and I had no dev-store session in this environment. So each §10 item below says what the automated tests prove, what they **can't** prove, and the exact steps to confirm it on the dev store. "Pass" means the automated tests pass. It does not mean "verified on a store".

## Before testing on the dev store

1. Deploy the branch. Five migrations run on start (`prisma migrate deploy`); they only add columns and one table.
2. **Run `shopify app deploy`.** This update adds an `app_subscriptions/update` webhook subscription in `shopify.app.toml`. It needs no new scope, so merchants won't see a re-approval prompt. Without the deploy, downgrades are still caught, but only on the next page load or by the scheduler's hourly plan re-check.
3. Give the dev store a test **Pro** subscription through managed pricing.
4. Keep the server logs open (`docker logs -t -f`). Every item below names the log lines or Activity entries to look for.

---

## §10 checklist, item by item

### 1. Collection with 1,000+ products on "Every hour": runs finish, no overlap, no rate-limit errors
**Automated: ✅ pass**
- `reorder-diff.test.ts`: a 1,000-product shuffle goes out as chunks of ≤ 250 moves, in order. A fake Shopify only applies a chunk once its job is polled as done, and the test asserts each chunk waits for the previous job (the last one too) and that the final order is exactly the target. Moves are minimal (n − LIS).
- `run-lock.server.test.ts` and `shuffle-engine-lock.server.test.ts`: only one run per collection at a time. An overlapping scheduled run is skipped and logged "Skipped — previous run still in progress". The lock expires on its own after a crash.
- `schedule-interval.test.ts`: the hourly `next_run_at` maths, including across DST changes, and an outage leading to one run rather than a backlog.
- Rate limits: `admin-graphql.server.test.ts` (unchanged) covers THROTTLED/429 backoff. Reorder "busy" retries now log at info level.

**Not covered automatically:** real Shopify job timings and the real cost bucket on 1,000+ products.

**Dev-store steps**
1. Create or pick a collection with ≥ 1,000 products, on Manual sort. To bulk-create test products, import a 1,000-row product CSV in Shopify admin.
2. On its card choose **Every hour → Save**. The card shows "Next shuffle in 60 min".
3. Leave it 3 hours. In **Activity**, expect one "shuffled" entry per hour for that collection, each a few seconds to a minute long, and **no** "Skipped — previous run still in progress" lines.
4. In the logs, expect **no** `[cron] ... failed` or `Shopify was too busy` lines. `[reorder] ... busy at Shopify, retrying` at info level is routine.
5. While a run is in progress, click **Shuffle now** on the same card. Expect the toast "A shuffle is already running on this collection…".

### 2. Import 50 products at once into a collection with Feature B on → only one reshuffle after the 10-minute wait
**Automated: ✅ pass**
- `new-products.server.test.ts`: "50 products imported at once → exactly one reshuffle, after the 10-minute wait". The test runs the real poll and debounce code against a simulated collection: detected at the poll, nothing at minute 5, one run at minute 10, nothing on later polls. Also covered: an import spread over two polls still gives one run; at most one run an hour; no run when a scheduled run is due within 15 minutes; a swap with the same product count is detected by product ID; removals never trigger; a quiet collection costs one cheap probe per poll.

**Not covered automatically:** Shopify's real product-to-collection timing (smart collections can take a moment to include new products).

**Dev-store steps**
1. On a **Weekly** collection (so no scheduled run interferes), tick **Reshuffle when new products are added → Save**.
2. Wait up to 15 minutes for the first poll. It records a baseline, so nothing runs.
3. Import 50 new products that land in this collection, for example a CSV whose products carry the collection's tag.
4. Within 10–25 minutes, Activity shows exactly **one** entry: "<Collection> — Triggered by new products (50 added)". The collection's new products are part of the new order.
5. Import 5 more within the next hour. **No** second run within the hour: it runs once the hour since the last trigger is up.

### 3. New products stay on top for the chosen window, then join the rotation
**Automated: ✅ pass**
- `ordering-update2.test.ts`: live new arrivals come right after the pins, newest first, on every random seed. The window is checked at 47 h (new) vs 49 h (not new) for 48 h. Products already present when tracking started fall back to their `createdAt`. A new arrival's time on top doesn't use up its rotation turn. When its window ends, it joins rotation at the current minimum turn count, so it doesn't take the top for several hourly runs in a row.

**Not covered automatically:** the real window passing on a store.

**Dev-store steps**
1. Choose **Keep new products on top for 24 h → Save**, on a collection with **Every hour**.
2. Add 3 new products to the collection. After the next hourly run they are positions 1–3 (after any pins), newest first, in the storefront collection page and in Shopify admin's manual order.
3. Run **Shuffle now** a few times: they stay on top.
4. After 24 h, the next run puts them back into normal rotation.

### 4. Pinned products never move; sold-out always last; excluded products untouched
**Automated: ✅ pass**
- `ordering-update2.test.ts` "produces the documented order on every seed": on 50 random seeds the pins stay in place, a never-move-tagged product keeps its exact index, and sold-out products (including a sold-out new arrival) are last. The existing `shuffle-algorithm.server.test.ts` also still passes.

**Dev-store steps**
1. In the Workspace (card → **Edit**), pin 3. In Settings, add a never-move tag (e.g. `gift-card`) and tag 2 products in the collection. Mark 2 products as out of stock.
2. The card shows "3 pinned · 2 excluded" after the next run.
3. Shuffle now 3 times. The first 3 products never change, the 2 tagged products keep their positions, and the 2 sold-out products are always last.

### 5. Undo works after an hourly run
**Automated: ✅ pass**
- `undo-storage.test.ts`: the compact snapshot round-trips exactly and old JSON snapshots still restore. Size: 9.7 KB per run for 1,000 products, so 6.8 MB per collection for 30 days of hourly runs (was 26.1 MB).
- `activity-update2.server.test.ts`: new-products runs offer Restore.

**Not covered automatically:** the restore write against Shopify. It uses the same `undoRun` as before, now also taking the run lock.

**Dev-store steps**
1. After an hourly run, note the first 5 products, then click **Undo** in the card footer.
2. Expect the toast "Undone — <title> is paused so it doesn't reshuffle straight away". The order goes back to what it was before that run, and the card says Paused (existing behaviour, so the next hourly run doesn't immediately undo the undo).
3. **Resume** from the card's ⋯ menu.

### 6. Starter merchant cannot select Pro frequencies (UI and API)
**Automated: ✅ pass**
- UI: `card-model.test.ts`. On Starter the hourly options are disabled and read "Every hour — Pro"; on Free, Daily reads "Daily — Starter". The card also refuses a disabled value if one is ever emitted.
- API: `schedule-api-enforcement.server.test.ts` sends hand-made POSTs from a Starter shop to **every** route action that writes a schedule (collections list, bulk, shop default, Workspace, Settings). Each returns **403 with nothing written**. `card-actions.server.test.ts` does the same for the new card save and for the Pro new-arrivals options. Anything faster than hourly is a 400 even on Pro.

**Dev-store steps**
1. Switch the dev store to **Starter**.
2. On a card, open **Frequency**. Every hourly option is greyed with "— Pro", and "Unlock with Pro" links to the plan page. Daily and Weekly are selectable.
3. The two new-arrivals checkboxes are disabled with a PRO badge.
4. The API half isn't practical to check by hand: requests need the embedded app's session token. `schedule-api-enforcement.server.test.ts` sends the hand-made POSTs against the real route actions, and that is the check of record.

### 7. Downgrade Pro → Starter: collections fall back to Daily, notice shown
**Automated: ✅ pass**
- `plan-downgrade.server.test.ts`: hourly → Daily at the local time its interval was anchored; legacy twice-daily → Daily at its first time; an hourly shop default is clamped and inheriting collections' countdowns are repaired; Free → Weekly. Both new-arrivals options are turned off, and a notice plus Activity rows are written. Collection caps are untouched, and an upgrade clears the notice.
- `plan-sync.server.test.ts`: the webhook/scheduler path (`syncPlanFromAdmin`) applies a downgrade it finds, and ignores frozen or cancelled subscriptions.

**Dev-store steps**
1. On Pro, set one collection to **Every 2 hours** with both new-arrivals options on.
2. Downgrade to **Starter** on Shopify's plan page.
3. Within seconds (webhook), or at the latest on the next page load or the scheduler's hourly re-check, the Collections page shows the **"Your plan changed to Starter"** notice. It lists "<title>: every 2 hours → daily at HH:MM" and the new-arrivals options turned off.
4. The card shows **Daily**, unticked options, and "Next shuffle in …" pointing at that time tomorrow or today.
5. Dismiss the notice. It doesn't come back after a reload.

### 8. Merchant switches sort order back to "Best selling" → shuffle pauses + warning
**Automated: ✅ pass**
- `sort-pause.server.test.ts`: the run records "Paused — sort order changed" (code `PAUSED_SORT`) and stamps the collection. The scheduler and the new-products poll skip collections in that state. Maintenance resumes the collection once Shopify reports Manual again, and leaves it paused while it isn't.

**Dev-store steps**
1. In Shopify admin, set a tracked collection's sort to **Best selling**.
2. At its next scheduled run (or Shuffle now), the card turns red. The badge reads "Paused — sort changed", with "Shopify has this collection on "Best selling" …" and a **Switch to Manual** button. Activity shows "Paused — sort order changed". No more runs or failures pile up each hour.
3. Click **Switch to Manual**. The warning clears and the schedule resumes.
4. Alternative: set it back to Manual in Shopify admin. Within 15 minutes Activity shows "Resumed — sort order is Manual again".

### 9. App screen readable in English and French
**Automated: ✅ pass for what's translated**
- `card-model.test.ts`: French has every English key, the same placeholders, French plural rules (0 and 1 singular), and French durations and schedule lines.

**Partial by design (approved scope, Q1b):** translated are the Collections page (title, toolbar, bulk bar, footer, banners), the collection card, the "New arrivals" setup, the plan-change notice, the new Activity messages, and the app menu. **Still English:** the plan bar and status cards at the top of Collections, the filter bar, all dialogs (including the schedule dialog), the Workspace, Activity's older messages, Insights, Plan, Settings, Help and Onboarding.

**Dev-store steps**
1. Shopify admin → your profile → **Language: Français**. Reload the app.
2. The menu reads Collections / Activité / Statistiques / Forfait / Paramètres / Aide. Cards read "Fréquence", "Prochain mélange dans … min", "Nouveautés", "Mélanger maintenant", and the save bar reads "Enregistrer / Ignorer".
3. Check nothing overflows. Longer French strings wrap inside the card, and below 560 px the card stacks to one column.
4. Switch back to English: everything reverts.

---

## Other things to know

- **Screenshot for the listing:** the new collection card. The spec is in `docs/update-2-listing-copy.md` §5. It needs the dev store, so I haven't taken it.
- **Web Vitals:** cards have a fixed footprint and skeletons of the same size (CLS), there's one 30-second shared clock instead of a timer per card, and the list stays paginated at 25 (INP). I haven't measured real INP/CLS. To check, use Shopify admin → Apps → Shuffly → Web Vitals after deploy.
- **Tooling on this machine:** the project is on the iCloud-synced Desktop. Cold reads of `node_modules` take seconds per file, so `prisma migrate dev`, `react-router typegen` and ESLint can take 10+ minutes or appear to hang (background jobs are throttled further). Tests, `tsc` and the build ran fine in the foreground.
