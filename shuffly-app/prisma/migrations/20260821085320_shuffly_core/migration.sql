-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "defaultRunTime" TEXT NOT NULL DEFAULT '06:00',
    "language" TEXT NOT NULL DEFAULT 'en',
    "neverMoveTags" TEXT NOT NULL DEFAULT 'gift-card,preorder,bundle',
    "emailOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "emailMonthlySummary" BOOLEAN NOT NULL DEFAULT true,
    "emailMorningRun" BOOLEAN NOT NULL DEFAULT false,
    "onboardedAt" DATETIME,
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "planUpdatedAt" DATETIME,
    "activeSubscriptionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CollectionConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "pins" INTEGER NOT NULL DEFAULT 0,
    "pushSoldOutToEnd" BOOLEAN NOT NULL DEFAULT true,
    "boostNewArrivals" BOOLEAN NOT NULL DEFAULT true,
    "giveEveryoneATurn" BOOLEAN NOT NULL DEFAULT true,
    "newArrivalDays" INTEGER NOT NULL DEFAULT 14,
    "scheduleType" TEXT NOT NULL DEFAULT 'DAILY',
    "scheduleTime" TEXT NOT NULL DEFAULT '06:00',
    "scheduleWeekday" INTEGER,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "turnCounts" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShuffleRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "movedCount" INTEGER NOT NULL DEFAULT 0,
    "pinnedCount" INTEGER NOT NULL DEFAULT 0,
    "soldOutCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "previousOrder" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShuffleRun_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "CollectionConfig_shop_idx" ON "CollectionConfig"("shop");

-- CreateIndex
CREATE INDEX "CollectionConfig_status_nextRunAt_idx" ON "CollectionConfig"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionConfig_shop_collectionGid_key" ON "CollectionConfig"("shop", "collectionGid");

-- CreateIndex
CREATE INDEX "ShuffleRun_shop_createdAt_idx" ON "ShuffleRun"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ShuffleRun_collectionId_createdAt_idx" ON "ShuffleRun"("collectionId", "createdAt");
