-- CreateTable
CREATE TABLE "ProductExposure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "firstSeenPage1At" DATETIME,
    "lastSeenPage1At" DATETIME,
    "firstSeenTop20At" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductExposure_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PositionSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "soldOutTop20Count" INTEGER NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PositionSnapshot_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "pins" INTEGER NOT NULL DEFAULT 0,
    "pushSoldOutToEnd" BOOLEAN NOT NULL DEFAULT true,
    "boostNewArrivals" BOOLEAN NOT NULL DEFAULT true,
    "giveEveryoneATurn" BOOLEAN NOT NULL DEFAULT true,
    "newArrivalDays" INTEGER NOT NULL DEFAULT 14,
    "scheduleType" TEXT NOT NULL DEFAULT 'DAILY',
    "scheduleTime" TEXT NOT NULL DEFAULT '06:00',
    "scheduleWeekday" INTEGER,
    "lastRunAt" DATETIME,
    "lastSoldOutCount" INTEGER,
    "lastKnownOrder" TEXT,
    "nextRunAt" DATETIME,
    "turnCounts" TEXT NOT NULL DEFAULT '{}',
    "priorityBoostIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CollectionConfig" ("boostNewArrivals", "collectionGid", "createdAt", "giveEveryoneATurn", "id", "lastKnownOrder", "lastRunAt", "lastSoldOutCount", "newArrivalDays", "nextRunAt", "pins", "previousSortOrder", "productCount", "pushSoldOutToEnd", "scheduleTime", "scheduleType", "scheduleWeekday", "shop", "status", "title", "turnCounts", "updatedAt") SELECT "boostNewArrivals", "collectionGid", "createdAt", "giveEveryoneATurn", "id", "lastKnownOrder", "lastRunAt", "lastSoldOutCount", "newArrivalDays", "nextRunAt", "pins", "previousSortOrder", "productCount", "pushSoldOutToEnd", "scheduleTime", "scheduleType", "scheduleWeekday", "shop", "status", "title", "turnCounts", "updatedAt" FROM "CollectionConfig";
DROP TABLE "CollectionConfig";
ALTER TABLE "new_CollectionConfig" RENAME TO "CollectionConfig";
CREATE INDEX "CollectionConfig_shop_idx" ON "CollectionConfig"("shop");
CREATE INDEX "CollectionConfig_status_nextRunAt_idx" ON "CollectionConfig"("status", "nextRunAt");
CREATE UNIQUE INDEX "CollectionConfig_shop_collectionGid_key" ON "CollectionConfig"("shop", "collectionGid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProductExposure_shop_collectionId_idx" ON "ProductExposure"("shop", "collectionId");

-- CreateIndex
CREATE INDEX "ProductExposure_shop_lastSeenPage1At_idx" ON "ProductExposure"("shop", "lastSeenPage1At");

-- CreateIndex
CREATE UNIQUE INDEX "ProductExposure_shop_collectionId_productGid_key" ON "ProductExposure"("shop", "collectionId", "productGid");

-- CreateIndex
CREATE INDEX "PositionSnapshot_shop_dateKey_idx" ON "PositionSnapshot"("shop", "dateKey");

-- CreateIndex
CREATE INDEX "PositionSnapshot_shop_capturedAt_idx" ON "PositionSnapshot"("shop", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PositionSnapshot_shop_collectionId_dateKey_key" ON "PositionSnapshot"("shop", "collectionId", "dateKey");
