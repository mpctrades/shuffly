-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CollectionConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "previousSortOrder" TEXT,
    "originalOrder" TEXT,
    "originalOrderAt" DATETIME,
    "pins" INTEGER NOT NULL DEFAULT 0,
    "pushSoldOutToEnd" BOOLEAN NOT NULL DEFAULT true,
    "boostNewArrivals" BOOLEAN NOT NULL DEFAULT true,
    "giveEveryoneATurn" BOOLEAN NOT NULL DEFAULT true,
    "newArrivalDays" INTEGER NOT NULL DEFAULT 14,
    "scheduleType" TEXT,
    "scheduleTime" TEXT,
    "scheduleTime2" TEXT,
    "scheduleWeekday" INTEGER,
    "scheduleUpdatedAt" DATETIME,
    "sortOrderIssueAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastSoldOutCount" INTEGER,
    "lastKnownOrder" TEXT,
    "nextRunAt" DATETIME,
    "turnCounts" TEXT NOT NULL DEFAULT '{}',
    "priorityBoostIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CollectionConfig" ("boostNewArrivals", "collectionGid", "createdAt", "giveEveryoneATurn", "id", "lastKnownOrder", "lastRunAt", "lastSoldOutCount", "newArrivalDays", "nextRunAt", "originalOrder", "originalOrderAt", "pins", "previousSortOrder", "priorityBoostIds", "productCount", "pushSoldOutToEnd", "scheduleTime", "scheduleTime2", "scheduleType", "scheduleUpdatedAt", "scheduleWeekday", "shop", "sortOrderIssueAt", "status", "title", "turnCounts", "updatedAt") SELECT "boostNewArrivals", "collectionGid", "createdAt", "giveEveryoneATurn", "id", "lastKnownOrder", "lastRunAt", "lastSoldOutCount", "newArrivalDays", "nextRunAt", "originalOrder", "originalOrderAt", "pins", "previousSortOrder", "priorityBoostIds", "productCount", "pushSoldOutToEnd", "scheduleTime", "scheduleTime2", "scheduleType", "scheduleUpdatedAt", "scheduleWeekday", "shop", "sortOrderIssueAt", "status", "title", "turnCounts", "updatedAt" FROM "CollectionConfig";
DROP TABLE "CollectionConfig";
ALTER TABLE "new_CollectionConfig" RENAME TO "CollectionConfig";
CREATE INDEX "CollectionConfig_shop_idx" ON "CollectionConfig"("shop");
CREATE INDEX "CollectionConfig_status_nextRunAt_idx" ON "CollectionConfig"("status", "nextRunAt");
CREATE UNIQUE INDEX "CollectionConfig_shop_collectionGid_key" ON "CollectionConfig"("shop", "collectionGid");
CREATE TABLE "new_ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "defaultRunTime" TEXT NOT NULL DEFAULT '06:00',
    "defaultScheduleType" TEXT NOT NULL DEFAULT 'WEEKLY',
    "defaultScheduleTime" TEXT NOT NULL DEFAULT '06:00',
    "defaultScheduleTime2" TEXT,
    "defaultScheduleWeekday" INTEGER DEFAULT 1,
    "language" TEXT NOT NULL DEFAULT 'en',
    "neverMoveTags" TEXT NOT NULL DEFAULT 'gift-card,preorder,bundle',
    "emailOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "emailMonthlySummary" BOOLEAN NOT NULL DEFAULT true,
    "emailMorningRun" BOOLEAN NOT NULL DEFAULT false,
    "autoSwitchToManual" BOOLEAN NOT NULL DEFAULT false,
    "onboardedAt" DATETIME,
    "pageSize" INTEGER NOT NULL DEFAULT 24,
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "planUpdatedAt" DATETIME,
    "activeSubscriptionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("activeSubscriptionId", "autoSwitchToManual", "createdAt", "defaultRunTime", "emailMonthlySummary", "emailMorningRun", "emailOnFailure", "id", "language", "neverMoveTags", "onboardedAt", "pageSize", "plan", "planUpdatedAt", "shop", "timezone", "updatedAt") SELECT "activeSubscriptionId", "autoSwitchToManual", "createdAt", "defaultRunTime", "emailMonthlySummary", "emailMorningRun", "emailOnFailure", "id", "language", "neverMoveTags", "onboardedAt", "pageSize", "plan", "planUpdatedAt", "shop", "timezone", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- Data migration: turn today's copied-per-collection schedules into a shop
-- default plus genuine overrides, WITHOUT changing when anything runs.
--
-- Step 1 seeds each shop's default from the schedule most of its collections
-- already use (ties broken by the oldest collection, so the result is
-- deterministic). Step 2 then nulls out only the collections that match that
-- default, which is what makes them inherit. A collection whose schedule
-- genuinely differs keeps its explicit values and becomes a real override.
--
-- Blanket-nulling every collection would have been simpler, but on any shop
-- with non-uniform schedules it would silently re-time the ones that differ.
-- ---------------------------------------------------------------------------

UPDATE "ShopSettings" SET
  "defaultScheduleType" = COALESCE((
    SELECT c."scheduleType" FROM "CollectionConfig" c WHERE c."shop" = "ShopSettings"."shop"
    GROUP BY c."scheduleType", c."scheduleTime", IFNULL(c."scheduleTime2",''), IFNULL(c."scheduleWeekday",-1)
    ORDER BY COUNT(*) DESC, MIN(c."createdAt") ASC LIMIT 1), 'WEEKLY'),
  "defaultScheduleTime" = COALESCE((
    SELECT c."scheduleTime" FROM "CollectionConfig" c WHERE c."shop" = "ShopSettings"."shop"
    GROUP BY c."scheduleType", c."scheduleTime", IFNULL(c."scheduleTime2",''), IFNULL(c."scheduleWeekday",-1)
    ORDER BY COUNT(*) DESC, MIN(c."createdAt") ASC LIMIT 1), '06:00'),
  "defaultScheduleTime2" = (
    SELECT c."scheduleTime2" FROM "CollectionConfig" c WHERE c."shop" = "ShopSettings"."shop"
    GROUP BY c."scheduleType", c."scheduleTime", IFNULL(c."scheduleTime2",''), IFNULL(c."scheduleWeekday",-1)
    ORDER BY COUNT(*) DESC, MIN(c."createdAt") ASC LIMIT 1),
  "defaultScheduleWeekday" = COALESCE((
    SELECT c."scheduleWeekday" FROM "CollectionConfig" c WHERE c."shop" = "ShopSettings"."shop"
    GROUP BY c."scheduleType", c."scheduleTime", IFNULL(c."scheduleTime2",''), IFNULL(c."scheduleWeekday",-1)
    ORDER BY COUNT(*) DESC, MIN(c."createdAt") ASC LIMIT 1), 1)
WHERE EXISTS (SELECT 1 FROM "CollectionConfig" c WHERE c."shop" = "ShopSettings"."shop");

UPDATE "CollectionConfig" SET
  "scheduleType" = NULL, "scheduleTime" = NULL, "scheduleTime2" = NULL, "scheduleWeekday" = NULL
WHERE EXISTS (
  SELECT 1 FROM "ShopSettings" s
  WHERE s."shop" = "CollectionConfig"."shop"
    AND s."defaultScheduleType" = "CollectionConfig"."scheduleType"
    AND s."defaultScheduleTime" = "CollectionConfig"."scheduleTime"
    AND IFNULL(s."defaultScheduleTime2",'') = IFNULL("CollectionConfig"."scheduleTime2",'')
    AND IFNULL(s."defaultScheduleWeekday",-1) = IFNULL("CollectionConfig"."scheduleWeekday",-1)
);
