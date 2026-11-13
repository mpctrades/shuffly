-- Drop ShopSettings.defaultRunTime.
--
-- It was the copy-forward seed: a time stamped onto each collection as it was
-- added. Nothing seeds a new collection any more — one starts with a null
-- schedule and inherits the shop default live — so the column had no reader
-- left. The plan-downgrade clamp, its last consumer, now uses
-- defaultScheduleTime, which is the time the merchant actually chose.
--
-- Written by hand rather than generated: `prisma migrate dev` needs an
-- interactive confirmation to drop a column holding values, and this is a
-- deliberate drop of a field whose data is genuinely dead.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
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
INSERT INTO "new_ShopSettings" ("activeSubscriptionId", "autoSwitchToManual", "createdAt", "defaultScheduleTime", "defaultScheduleTime2", "defaultScheduleType", "defaultScheduleWeekday", "emailMonthlySummary", "emailMorningRun", "emailOnFailure", "id", "language", "neverMoveTags", "onboardedAt", "pageSize", "plan", "planUpdatedAt", "shop", "timezone", "updatedAt") SELECT "activeSubscriptionId", "autoSwitchToManual", "createdAt", "defaultScheduleTime", "defaultScheduleTime2", "defaultScheduleType", "defaultScheduleWeekday", "emailMonthlySummary", "emailMorningRun", "emailOnFailure", "id", "language", "neverMoveTags", "onboardedAt", "pageSize", "plan", "planUpdatedAt", "shop", "timezone", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
