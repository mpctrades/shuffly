-- AlterTable
ALTER TABLE "CollectionConfig" ADD COLUMN "scheduleTime2" TEXT;

-- CreateTable
CREATE TABLE "ShuffleSlotClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "claimedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShuffleSlotClaim_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShuffleSlotClaim_shop_claimedAt_idx" ON "ShuffleSlotClaim"("shop", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShuffleSlotClaim_collectionId_dateKey_slot_key" ON "ShuffleSlotClaim"("collectionId", "dateKey", "slot");

-- Backfill: before merchants could pick the second slot, TWICE_DAILY derived
-- it as scheduleTime + 12 hours (see the old computeNextRun). Persist exactly
-- that value so no existing merchant's second run moves when the sweep starts
-- reading scheduleTime2 instead of deriving it.
UPDATE "CollectionConfig"
SET "scheduleTime2" = printf(
      '%02d:%s',
      (CAST(substr("scheduleTime", 1, 2) AS INTEGER) + 12) % 24,
      substr("scheduleTime", 4, 2)
    )
WHERE "scheduleType" = 'TWICE_DAILY'
  AND "scheduleTime2" IS NULL
  AND "scheduleTime" LIKE '__:__';
