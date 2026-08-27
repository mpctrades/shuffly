-- CreateTable
CREATE TABLE "ProductPosition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "availableForSale" BOOLEAN NOT NULL,
    "dateKey" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductPosition_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShopSettings" (
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
    "pageSize" INTEGER NOT NULL DEFAULT 24,
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "planUpdatedAt" DATETIME,
    "activeSubscriptionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShopSettings" ("activeSubscriptionId", "createdAt", "defaultRunTime", "emailMonthlySummary", "emailMorningRun", "emailOnFailure", "id", "language", "neverMoveTags", "onboardedAt", "plan", "planUpdatedAt", "shop", "timezone", "updatedAt") SELECT "activeSubscriptionId", "createdAt", "defaultRunTime", "emailMonthlySummary", "emailMorningRun", "emailOnFailure", "id", "language", "neverMoveTags", "onboardedAt", "plan", "planUpdatedAt", "shop", "timezone", "updatedAt" FROM "ShopSettings";
DROP TABLE "ShopSettings";
ALTER TABLE "new_ShopSettings" RENAME TO "ShopSettings";
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProductPosition_shop_collectionId_dateKey_idx" ON "ProductPosition"("shop", "collectionId", "dateKey");

-- CreateIndex
CREATE INDEX "ProductPosition_shop_dateKey_idx" ON "ProductPosition"("shop", "dateKey");

-- CreateIndex
CREATE INDEX "ProductPosition_shop_productGid_dateKey_idx" ON "ProductPosition"("shop", "productGid", "dateKey");
