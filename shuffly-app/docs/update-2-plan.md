# Update 2 — Unlimited Pro: implementation plan

Status: **draft, waiting for approval.** No code has been changed.
Source of truth: `docs/update-2-brief.pdf` (11 Nov 2026). This plan follows the brief plus the decisions in the kickoff prompt. Every place where they disagree with the code is listed in §4. The questions I need answered are in §5.

---

## 1. What exists today

### Stack
- **React Router 7** app, based on Shopify's template (`@shopify/shopify-app-react-router`). It is embedded with App Bridge 4 and uses **Polaris web components** (`<s-page>`, `<s-section>`, `<s-select>`…). It does not use Polaris React.
- **Prisma 6 + SQLite** (`prisma/schema.prisma`, DB file at `prisma/data/dev.sqlite`). Production is one Docker container on the Hostinger VPS, with only `prisma/data` on a volume.
- **No queue system.** `app/lib/scheduler.server.ts` runs a `setInterval` every 60 s inside the app process and calls `runDueShuffles()` in `app/lib/cron.server.ts`. If a sweep is still running, the next tick is skipped. There is also an HTTP fallback at `app/routes/api.cron.run-shuffles.tsx`. Background work and graceful shutdown (50 s drain) are in `app/lib/background.server.ts`.
- Tests: **Vitest**, `npm test`, run on `app/**/*.test.ts`. Most tests cover pure logic, and some mock the DB. Typecheck: `npm run typecheck`. Lint: `npm run lint`.

### How the scheduler fires runs
- The schedule types are `DAILY | TWICE_DAILY | WEEKLY | MANUAL` (`app/lib/schedule-core.ts`). Each one is a local wall-clock time in the shop's timezone, and the DST handling is explicit (`resolveLocalTime`).
- A collection with `scheduleType = null` **inherits the shop default** (`ShopSettings.defaultSchedule*`). This is resolved live in `app/lib/schedule-resolve.ts`.
- What is due is decided by `dueSlots()` against the schedule stored right now. It has a 2 h grace window and uses `scheduleUpdatedAt` so a run doesn't fire for a slot the merchant just moved into the past. **`nextRunAt` is advisory only.** It is used as a prefilter and for the countdown.
- `ShuffleSlotClaim` (unique on `collectionId, dateKey, slot`) means each slot fires only once. The claim is inserted before the run starts.
- The sweep goes through shops and collections **one at a time**.

### Ordering logic
- `app/lib/shuffle-algorithm.server.ts` (pure): `computeShuffledOrder` + `bumpTurnCounts`.
  - **Pins are "the first N"** (`CollectionConfig.pins`, an integer). There is no per-product pin list.
  - **"Exclusions" are "never move" tags.** They are shop-wide (`ShopSettings.neverMoveTags`), and a tagged product stays frozen at its current index. Exclusions by type or vendor don't exist.
  - Sold-out to the end (`pushSoldOutToEnd`), a one-time `priorityBoostIds` (from Insights' "Put these first tomorrow"), and **`boostNewArrivals` already exists**. It puts products *created* within `newArrivalDays` (default 14) first in the shuffled pool. It is on by default and available on every plan.
  - Fair rotation means sorting by `turnCounts` (stored as JSON on the collection), with random tie-break. After each run, the first 4 non-pinned slots get +1.
- `app/lib/shuffle-engine.server.ts`: `runShuffleForCollection` does fetch → sort check → compute → diff → reorder → record. It also has undo and restore-on-remove.
- `app/lib/shuffle-preview.server.ts` repeats the input building for the onboarding preview.

### `collectionReorderProducts`
- `app/lib/collections.server.ts`:
  - `getCollectionProductsInOrder` pages 100 at a time and **stops at 2,000 products**.
  - `diffToMoves` simulates "remove then insert", applied in sequence.
  - `reorderCollectionProducts` sends chunks of 250. It waits for each job (60 s for middle chunks, 15 s for the last one) and runs them one after another per collection using an in-memory promise chain. `TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS` is retried 3 times over about 11 s.
- `app/lib/admin-graphql.server.ts`: every call goes through `adminGraphql`, which retries `THROTTLED` (based on the cost bucket), HTTP 429, and dropped connections on queries.

### Plans and billing
- `app/lib/plans.ts` (`PLANS`, `allowedSchedules`, `isScheduleAllowed`, `cheapestPlanWith`, `timeSlots`, `cadenceLabel`) and `app/lib/plans.server.ts` (`enforcePlanCollectionCap`, `enforcePlanEntitlements`, undo pruning).
- **Managed pricing.** The local copy of the plan is `ShopSettings.plan`. `syncPlanIfStale` (`app/lib/billing.server.ts`) calls `billing.check()` from the `app.tsx` layout loader when the cached plan is more than 15 minutes old. That loader is the only path that runs the downgrade clamps. **No `app_subscriptions/update` webhook is subscribed**, and the cron sweep never re-checks the plan.
- Server-side checks with `isScheduleAllowed` are already in `app.collections.tsx` (2 actions), `app.collections.$id.tsx` and `app.settings.tsx`.
- The upgrade screen is `/app/plan`. It links to Shopify's managed pricing page.

### Undo and snapshots
- `ShuffleRun.previousOrder` stores the **full GIDs as a JSON array** before each run. `undoRun` restores it and then pauses the collection.
- Retention comes from `undoRetentionDays` (Free 1, Starter 7, Pro 30). `pruneExpiredUndoSnapshotsForAllShops` runs on every sweep and sets `previousOrder` to NULL.
- `CollectionConfig.originalOrder` (packed numeric ids, never pruned) is a different thing: it is the order before Shuffly was added.
- **`ProductPosition` (Insights history) is never pruned.** It gets about 24 rows per run.

### UI, activity log and i18n
- Collections list: `app/routes/app.collections.tsx` (2,926 lines). It is a **table** with filter bar, bulk actions and pagination of 25 rows. Rows come from `CollectionRow.tsx`, and the schedule is edited in `ShuffleScheduleModal.tsx` (a cadence grid with locked cards).
- Per-collection Workspace: `app.collections.$id.tsx` (pins, toggles, schedule, live order, undo, history). It uses the contextual save bar (`<ui-save-bar>`).
- Activity: `app.activity.tsx` + `app/lib/activity.server.ts`. **Messages are stored as English strings** in `ShuffleRun.message`. Triggers are free-form strings.
- **i18n: none.** `ShopSettings.language` exists (`"en" | "fr"`), but nothing reads it. There are no dictionaries and no FR strings anywhere. Every string is hard-coded English.

### Test baseline
- Vitest on `collections-toolbar` @ `c5c9aae`: **20 test files, 274 tests, all passing**.

---

## 2. Data model changes (one migration per feature commit)

```prisma
model CollectionConfig {
  // Feature A
  scheduleType      String?   // + "INTERVAL" (alongside DAILY | TWICE_DAILY | WEEKLY | MANUAL)
  intervalHours     Int?      // 1|2|3|4|6|12, only when scheduleType = INTERVAL
  intervalAnchorAt  DateTime? // the save moment; runs are anchor + k*interval
  // Run lock (§8)
  runLockedUntil    DateTime? // lease; NULL or < now means free
  runLockToken      String?
  // Sort pause (§8)
  pausedReason      String?   // NULL | "SORT_CHANGED"  (status stays RUNNING/PAUSED for merchant pauses)
  // Feature B
  reshuffleOnNew    Boolean   @default(false)
  newCheckLastAt    DateTime?
  newCheckCount     Int?      // productsCount at the last poll (cheap pre-check)
  newPendingSince   DateTime? // first detection of the current batch (start of the 10-min debounce)
  newPendingCount   Int       @default(0)
  lastNewTriggerAt  DateTime? // enforces the 1/hour limit
  // Feature C
  keepNewOnTop      Boolean   @default(false)
  newOnTopHours     Int       @default(48) // 24 | 48 | 72 | 168
  newTrackingSince  DateTime? // when C (or B) first baselined this collection

  productSeen ProductSeen[]
  undoSnapshots UndoSnapshot[]
}

model ProductSeen {            // first_seen_at per (collection, product)
  collectionId String
  productId    String          // numeric id, no gid prefix
  firstSeenAt  DateTime
  baseline     Boolean         // true = was already there when tracking started → use createdAt
  createdAt    DateTime        // product.createdAt, cached for the baseline fallback
  @@id([collectionId, productId])
}

model UndoSnapshot {           // compact undo; replaces ShuffleRun.previousOrder for new runs
  runId        String @id
  collectionId String
  shop         String
  order        Bytes           // deflate(packed numeric ids)
  createdAt    DateTime @default(now())
  @@index([shop, createdAt])
}

model ShopSettings {
  // + plan-change notice (dismissible)
  planNotice          String?   // JSON: { from, to, at, changes: [{collectionId, title, from, to, droppedB, droppedC}] }
  planNoticeDismissed Boolean @default(false)
  // + Atlas-style one-click preset needs nothing extra
}

model ShuffleRun {
  // + structured copy so EN/FR render from codes, not stored English
  messageCode   String?   // e.g. NEW_PRODUCTS, SKIPPED_IN_PROGRESS, PAUSED_SORT, PLAN_DOWNGRADE
  messageParams String?   // JSON, e.g. {"added":12}
}
```

Why `INTERVAL + intervalHours` and not six new enum strings: one cadence branch in `schedule-core`, one clamp rule, and `TWICE_DAILY` stays exactly as it is (the legacy value).

---

## 3. Plan by brief task

### Task 1 — Frequencies + `next_run_at`
- `schedule-core.ts`:
  - New `INTERVAL` type. `nextIntervalRun(anchor, hours, now)` = the smallest `anchor + k·h` greater than now, done in **UTC**, so hourly runs are exempt from DST by construction.
  - Daily and weekly keep `resolveLocalTime` (already DST-safe).
  - `TWICE_DAILY` is unchanged.
- **`nextRunAt` becomes the trigger for INTERVAL only.** The sweep runs it when `nextRunAt <= now`, then sets `nextRunAt = next slot after now`. Missed slots during downtime collapse into one run, up to the grace window. That matches today's "never fire backlog" rule.
- **DAILY/WEEKLY/TWICE_DAILY keep `dueSlots` + `ShuffleSlotClaim`.** The current design is deliberately built that way: a time change takes effect immediately, there is no back-firing, and DST fall-back can't fire twice. Rewriting it adds risk with no gain for Atlas. For INTERVAL, the claim key is `dateKey = UTC ISO of the slot instant` and `slot = 0`, so the existing unique constraint also protects interval runs.
- Shop default schedule: Pro can also choose an interval as the default. Inheriting collections use the **default's** anchor plus a per-collection offset (stable hash, 0–(h·60−1) min), so 300 inheriting collections don't all fire on the same minute. (Q3)
- `PLANS.PRO.allowedSchedules` adds `INTERVAL`. `PLANS.*.minIntervalHours`: Pro 1, the others are not allowed. One gate: `isScheduleAllowed(plan, type, intervalHours)`.
- `cadenceLabel(PRO)` → "Unlimited — as often as every hour".

### Task 2 — Scheduler worker, lock, skip logging
- **Per-collection lease lock in the DB.** It is taken with a conditional `updateMany where runLockedUntil IS NULL OR < now`, with a 15-minute lease that is extended between chunks. A crashed container can't leave a collection locked forever.
- Every run path takes the lock: scheduled, Shuffle now, Feature B, sold-out reaction, undo.
- If the lock is held when a **scheduled** run is due, the run is skipped and logged as `messageCode=SKIPPED_IN_PROGRESS` ("Skipped — previous run still in progress"), and `nextRunAt` is advanced. Shuffle now returns "A shuffle is already running on this collection".
- The sweep works through **shops concurrently, 4 at a time** (`p-limit`-style helper, no new dependency). Collections inside one shop stay sequential, because they share that shop's rate-limit bucket. Today one slow 2,000-product shop delays every other shop's hourly run.
- Load spreading: interval anchors already come from the moment of saving. The shop-default offset is covered above. Daily/weekly keep the time the merchant chose.
- Housekeeping (undo prune, `ProductSeen` cleanup, `ProductPosition` retention) moves to its own job **every 15 minutes** instead of every sweep.

### Task 3 — Diff-only reorder, 250 per call
- **Bug found:** `diffToMoves` is greedy left-to-right. Moving **one** product from the front to the back produces **n−1 moves**, for example a sold-out reaction on a 1,000-product collection sending 999 moves in 4 jobs. I'll replace it with a **longest-increasing-subsequence diff**: products on the LIS stay where they are, and only the others move (minimal = n − LIS). Each move's `newPosition` is still computed against the working array as it is after the earlier moves, so the "applied in sequence" semantics stay as they are.
- Chunks of ≤250, and **every chunk now waits for its job**, including the last one, because the next hourly run and Feature B depend on it. The wait time for the last chunk is raised to 60 s. A timeout is logged as routine, not as a failure.
- Tests: a property test applies the moves exactly as Shopify documents them (remove, then insert at `newPosition`, one after another, across chunk boundaries) and checks the result equals the target. There are also cases where the minimal count matters (one to the end, one to the front, swap, reverse), plus a 1,000-product random case. I'll confirm the exact `newPosition` semantics against the current Admin API docs with the Shopify AI Toolkit before writing the code.
- `TOO_MANY_ATTEMPTS_TO_REORDER_PRODUCTS` / THROTTLED: the backoff is already in place. The change is that retries are logged as `console.info` (routine), and only a final failure writes a FAILED run.
- **The 2,000-product cap is lifted** (see §4 #7). Products past position 2,000 are currently never shuffled.

### Task 4 — Server-side plan checks + downgrade
- Every write path (collections list actions, Workspace, Settings, the new card action, the preset, onboarding) validates with `isScheduleAllowed(plan, type, intervalHours)`, `canUseNewArrivals(plan)` and `canPin`. A Starter POST with `intervalHours=1` gets **403** and nothing is written. There will be one test per route action.
- The plan always comes from `ShopSettings.plan` as last reconciled from Shopify, never from the client.
- **Freshness on the run path:**
  - (a) Subscribe to **`app_subscriptions/update`** (it needs no scope). The handler re-syncs and clamps.
  - (b) Before a Pro-only run, if `planUpdatedAt` is older than 1 h, the sweep re-reads `currentAppInstallation.activeSubscriptions` with the admin session it already has, then reconciles. (Q2)
- Downgrade (in `enforcePlanEntitlements`, extended):
  - INTERVAL or TWICE_DAILY → Starter: DAILY, Free: WEEKLY. The collection keeps its `scheduleTime`. An interval collection has no time-of-day, so it uses its anchor's local time.
  - Feature B and C flags are turned off.
  - Pins follow the existing rule.
  - A `planNotice` is written. It shows as a dismissible `<s-banner>` on the Collections page listing each change.
  - Collection caps are unchanged.
- An upgrade only clears the notice. It never re-enables anything on its own.

### Task 5 — Feature B (new-products polling)
- A job runs every 15 minutes (a separate timer, also exposed through the cron route). It only looks at Pro collections where `reshuffleOnNew` is on and status is RUNNING, and goes through shops concurrently.
- **Query choice (cheapest reliable):**
  1. Pre-check `collection { productsCount { count } }` costs about 2 points.
  2. `products(first: 50, sortKey: CREATED, reverse: true) { nodes { id createdAt } }` costs about 52 points. It catches newly created products that join the collection, which is the import case.
  3. A **full ID scan** (`first: 250`, `id` only, about 252 points per page) runs only when the count changed, when step 2 found an unseen ID, or **once an hour** as a safety net for an old product moved into the collection where the count stays the same (swap). For a 1,000-product collection that is about 1k points per scan, half of the standard bucket, which refills in about 10 s. The full scan is what produces the real "N added" number.

  Why not CREATED alone: it misses old products newly added to the collection. Why not a full scan every 15 minutes: it costs 4× as much for every enabled collection, for no extra detection in the common case.
- Detection = IDs not in `ProductSeen`. Removals are ignored.
- Debounce:
  - First detection sets `newPendingSince`.
  - Later detections in the window add to `newPendingCount`, so a 50-product import that spans two polls still leads to **one** run.
  - The run fires at the first poll ≥10 min after `newPendingSince`. Polls happen every 15 minutes, so the effective wait is 10–25 min. If you want exactly 10 minutes, I'll schedule `nextRunAt`-style instead. (Q6)
  - Skip conditions: `lastNewTriggerAt` within 1 h, or a scheduled `nextRunAt` within 15 min. In both cases the pending flag is kept so the next eligible moment picks it up, and the scheduled run clears it.
- The run goes through the same engine and the same lock, with trigger `NEW_PRODUCTS` and `messageCode=NEW_PRODUCTS {added:N}`.
- Polling also upserts `ProductSeen`.

### Task 6 — Feature C (ordering)
- `ProductSeen.firstSeenAt` is written by every normal run (the engine already fetches the full list) and by Feature B polls.
- When B or C is first turned on, every current product is inserted with `baseline=true`. Baseline products count as "new" only if `product.createdAt` is inside the window.
- New ordering function in `shuffle-algorithm.server.ts`, still pure. `computeShuffledOrder` stays as one composable function:
  1. First N pinned products, in place.
  2. New arrivals (live, not excluded), newest first by `firstSeenAt` (or `createdAt` for baseline products).
  3. One-time priority boost (Q5).
  4. Fair rotation.
  5. Sold-out products, including sold-out new arrivals, if `pushSoldOutToEnd` is on.
  6. "Never move" products are frozen at their index throughout, as today.
- **Fairness fix:** `bumpTurnCounts` will count the first featured slots *after* pins **and after the new-arrivals block**, so time on top as a new arrival doesn't count as a turn. A product that joins rotation (window expired, or newly added) starts at the **current minimum** turn count of the pool, not 0. Otherwise a newcomer at 0 among products at 5 would hold the top 5 hourly runs in a row. Removed products' counts are pruned.
- When C is on, `boostNewArrivals` is ignored for that collection (Q4).
- `shuffle-preview.server.ts` and the engine share one input builder, so the preview matches the real run.

### Task 7 — Collection card
- A new `CollectionCard.tsx` built only from Polaris web components:
  - Header: title · count · status badge (Active / Paused / Sort changed / Over plan limit).
  - Frequency `<s-select>` + "Next shuffle in 42 min" (relative, refreshed every minute, client-side only, without re-rendering the list).
  - New arrivals: two `<s-checkbox>` with a PRO badge, plus a 24h/48h/72h/7d select.
  - Fixed products: "3 pinned · 2 excluded · Edit". Edit opens the existing Workspace. The excluded count comes from the shop tags matched during the last run (Q7).
  - Footer: last run · count · Undo, and **Shuffle now**.
- Edits are held locally and saved through **one `<ui-save-bar>`** for the page (the Workspace pattern). Every save goes through a single `update-card` action, which validates the plan.
- The cards replace the table rows on `/app/collections` (Q1). The filter bar, bulk actions and pagination of 25 stay. Fixed card heights and skeletons prevent CLS. The relative-time ticker uses one shared timer.

### Task 8 — Greyed options + upgrade
- `<s-select>` can't put badges on options, so locked options are rendered disabled, with the label suffix "— Pro" / "— Starter" from `cheapestPlanWith`.
- A small "Unlock hourly with Pro" link next to the select opens `/app/plan`. Disabled options can't be clicked inside a native select. If you want the brief's "click a greyed option → upgrade" literally, I'd build the dropdown as `<s-popover>` + `<s-choice-list>` instead (Q8).
- Either way the setting never changes.
- Legacy `TWICE_DAILY` shows as "Twice daily (current)" only while it is selected.

### Task 9 — New arrivals preset
- The banner appears if the title matches `/new|nouveau|arrival|latest/i`. Every other card gets a small link instead.
- One click sets INTERVAL 2 h, `reshuffleOnNew`, `keepNewOnTop`, and 48 h. It also baselines `ProductSeen`.
- On a non-Pro plan it opens `/app/plan`.
- The banner is dismissible per collection (stored in localStorage).

### Task 10 — Activity log
- New codes: `NEW_PRODUCTS` ("Triggered by new products (12 added)"), `SKIPPED_IN_PROGRESS`, `PAUSED_SORT` ("Paused — sort order changed"), `PLAN_DOWNGRADE`.
- Rendering (`activity.server.ts`, `ActivityRow.tsx`) prefers `messageCode` + params through the dictionary. If they are missing it falls back to the stored `message`, so old rows don't change.
- Retries are not logged as rows.

### Task 11 — Listing and pricing text
- `docs/update-2-listing-copy.md`, EN + FR: the Pro bullets, the main bullet, pricing-page plan descriptions (managed pricing text for the Partner Dashboard), and the in-app `/app/plan` copy.
- "Unlimited" always appears together with "as often as every hour".
- I don't publish anything to the Partner Dashboard. Arthur does that.

### Task 12 — QA
- `docs/update-2-qa.md` goes through §10 one item at a time. Items that need a real dev store (1,000-product hourly load, 50-product import, sort switch, FR screen) get exact manual steps.
- I'll script what can be scripted: seed products in bulk with `productCreate` on the dev store, but only if you give me a dev-store session (Q9).
- Then the handoff note for Arthur.

### Undo storage at hourly volume
For 1,000 products × 24 runs/day × 30 days = **720 snapshots per collection**:

| Format | Per snapshot | Per collection, 30 days |
|---|---|---|
| Today: JSON of full GIDs (`"gid://shopify/Product/8123456789012",`, 38 B/id) | ~38 KB | **~27 MB** |
| Packed numeric ids JSON (existing `packProductIds`, 16 B/id) | ~16 KB | ~11.5 MB |
| **Proposed: deflate(packed ids)** in `UndoSnapshot.order` (est. ~6 B/id, to be measured in a test) | ~6 KB | **~4–5 MB** |

- 20 hourly Pro collections of that size come to about 100 MB in steady state, which SQLite handles fine. Freed pages are reused, so the file doesn't keep growing.
- Cleanup is a real `DELETE` of `UndoSnapshot` rows older than the plan's window, run by the 15-minute housekeeping job.
- Old `ShuffleRun.previousOrder` rows still work for undo until they age out.
- **Also:** `ProductPosition` (Insights) currently has no retention, and hourly runs make it grow 24× faster (about 17k rows per collection per month). I'll add a 90-day retention, plus at most one recorded snapshot per local hour (Q10).

---

## 4. Brief vs code: disagreements and gaps

1. **No i18n exists.** The brief and the prompt assume EN + FR. The app has a `language` column and zero translations, and about 20k lines of hard-coded English. QA item "App screen readable in English and French" is not achievable without translating the screen. → Q1b.
2. **Pins are "first N", not chosen products.** The card's "3 pinned" works (N=3), but "Pin best sellers" in the brief suggests chosen products. I'm keeping first-N.
3. **Exclusions are shop-wide tags only, frozen in place.** The brief's §2 says "exclude by tag/type/vendor". Type and vendor don't exist. Nothing is per collection. I'm not adding them. The card shows the count matched by shop tags, and "Edit" goes to the Workspace and Settings.
4. **`boostNewArrivals` (all plans, createdAt ≤14 days) already exists** and overlaps Feature C. Free/Starter must not change, so it stays. C takes precedence when on. → Q4.
5. **Free undo is 1 day in code, but "—" in the brief.** I'm leaving it as is (Free unchanged). Listing copy should say "1 day" or keep "—". Arthur's call.
6. **`MANUAL` ("Only when I press Shuffle") exists and isn't in the brief's dropdown.** Removing it would start automatic shuffles for merchants who opted out. I'll keep it as the last option. → Q3.
7. **2,000-product fetch cap.** Larger collections (Atlas's "very large" one?) only ever shuffle their first 2,000. I'll remove the cap. Reading costs are about 1 page per 100 products today, so I'll raise the page size to 250.
8. **Greedy diff → n−1 moves for a single move to the end** (Task 3). This affects today's sold-out reactions too.
9. **Plan freshness:** no `app_subscriptions/update` webhook, and the cron never re-checks. A shop that downgrades in Shopify admin and doesn't open the app keeps its Pro cadence indefinitely. Adding the webhook is a new **subscription**, not a new scope. → Q2.
10. **The brief says "Downgrade → Daily". The prompt says Starter → Daily, Free → Weekly.** I'm following the prompt. The existing `defaultScheduleForPlan` already does exactly this.
11. **"Pause on sort change":** today a non-Manual sort only fails the run and stamps `sortOrderIssueAt`. It doesn't pause. Each hourly run would add another FAILED row. I'll add `pausedReason=SORT_CHANGED`: runs and Feature B stop, the card shows a warning with the existing one-click "Switch to Manual", and that switch clears the pause.
12. **Hourly runs and the run-history UI:** the Workspace history and Activity feed currently show one row per run. 24 runs a day will flood them. Activity already groups by `batchId` per sweep. I'll make interval runs for the same collection on the same day collapse into one expandable group.
13. **Brief: "Existing Pro merchants keep their current schedule".** TWICE_DAILY keeps running through the untouched slot path. ✔ No conflict.
14. **Brief: "Atlas should install, click once, done".** A brand-new Free install can't use the preset without upgrading first. The preset opens the plan page on Free. After subscribing, the merchant has to come back and click again. I can store a "pending preset" so it applies automatically after the plan becomes Pro (Q11).
15. **Branch base:** `collections-toolbar` is 50 commits ahead of `insights-rebuild-fairness` (the default PR base) and contains the deployed webhook fix. I'll branch `update-2-unlimited-pro` from `collections-toolbar` HEAD (`c5c9aae`).

---

## 5. Questions before I start

1. **(Q1) Card vs table, (Q1b) i18n scope.**
   - Card: should the cards **replace** the collections table, or sit in a new screen while the table stays as an admin view? I recommend replacing it, keeping filter, bulk actions and pagination.
   - i18n: I propose adding a small dictionary layer (`app/i18n/{en,fr}.ts`, chosen from `ShopSettings.language` and falling back to the admin locale), and translating **the Collections screen, the card, the preset, the plan notice and the new activity messages**. Translating the rest of the app (Workspace, Settings, Insights, Plan, Help, Onboarding, about 15k lines) would be a separate update. OK?
2. **(Q2)** Add the `app_subscriptions/update` webhook + the 1-hour plan re-check in the sweep? (No new scope.)
3. **(Q3)** Keep "Only when I press Shuffle" in the dropdown? Allow interval cadences as the shop-wide default?
4. **(Q4)** When Feature C is on, ignore `boostNewArrivals`? Recommendation: yes, and hide that toggle on the card when C is on.
5. **(Q5)** Where does the one-time Insights "Put these first" boost go relative to new arrivals? Recommendation: after new arrivals.
6. **(Q6)** Is a 10–25 min effective debounce OK, or should it be exactly 10 min?
7. **(Q7)** "2 excluded" = the count of products in this collection carrying a shop-wide never-move tag, as of the last run. OK?
8. **(Q8)** Native `<s-select>` with disabled options + an "Unlock with Pro" link, or a custom popover list where clicking a locked option opens the plan page (closer to the brief, more code, needs its own a11y handling)?
9. **(Q9)** For QA: do I get a dev store (and its session via `shopify app dev`) to seed 1,000 products and run the §10 checklist, or do I write the manual steps and you or Arthur run them?
10. **(Q10)** Should `ProductPosition` record at most once per local hour, with 90-day retention? This changes Insights only for history older than 90 days.
11. **(Q11)** Should a preset clicked on Free/Starter be applied automatically once the shop becomes Pro?

---

## 6. Decisions (approved 2026-11-12)

Approved with the recommended option on every question:

- **Q1** The cards replace the collections table. Filter, bulk actions and pagination of 25 stay.
- **Q1b** Add a small dictionary layer (`app/i18n`). Translate the Collections screen, the card, the preset, the plan notice and the new activity messages. The rest of the app is a later update.
- **Q2** Add the `app_subscriptions/update` webhook and the 1-hour plan re-check in the sweep.
- **Q3** Keep "Only when I press Shuffle" as the last option. Interval cadences are allowed as the Pro shop default, with a per-collection offset.
- **Q4** When Feature C is on, `boostNewArrivals` is ignored and its toggle is hidden on the card.
- **Q5** The one-time Insights boost goes after new arrivals.
- **Q6** The debounce runs on the 15-minute poll (effective 10–25 min).
- **Q7** "N excluded" = products carrying a shop never-move tag, as of the last run.
- **Q8** Native `<s-select>` with disabled options + an "Unlock with Pro" link.
- **Q9** No recommendation was given. Default: I run everything that can be automated and write exact manual steps for the dev-store items.
- **Q10** `ProductPosition`: at most one snapshot per local hour, 90-day retention.
- **Q11** A preset clicked on Free/Starter is stored and applied automatically once the shop is on Pro.
