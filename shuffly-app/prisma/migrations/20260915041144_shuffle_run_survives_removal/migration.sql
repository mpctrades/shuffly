-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShuffleRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT,
    "collectionTitle" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "movedCount" INTEGER NOT NULL DEFAULT 0,
    "pinnedCount" INTEGER NOT NULL DEFAULT 0,
    "soldOutCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "noMoveReason" TEXT,
    "previousOrder" TEXT,
    "batchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShuffleRun_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionConfig" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ShuffleRun" ("batchId", "collectionId", "createdAt", "durationMs", "id", "message", "movedCount", "noMoveReason", "pinnedCount", "previousOrder", "shop", "soldOutCount", "status", "trigger") SELECT "batchId", "collectionId", "createdAt", "durationMs", "id", "message", "movedCount", "noMoveReason", "pinnedCount", "previousOrder", "shop", "soldOutCount", "status", "trigger" FROM "ShuffleRun";
DROP TABLE "ShuffleRun";
ALTER TABLE "new_ShuffleRun" RENAME TO "ShuffleRun";
CREATE INDEX "ShuffleRun_shop_createdAt_idx" ON "ShuffleRun"("shop", "createdAt");
CREATE INDEX "ShuffleRun_shop_batchId_idx" ON "ShuffleRun"("shop", "batchId");
CREATE INDEX "ShuffleRun_collectionId_createdAt_idx" ON "ShuffleRun"("collectionId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
