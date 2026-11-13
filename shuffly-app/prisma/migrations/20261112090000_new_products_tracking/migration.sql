-- Update 2, Features B + C: first-seen tracking and new-products polling state.
ALTER TABLE "CollectionConfig" ADD COLUMN "newTrackingSince" DATETIME;
ALTER TABLE "CollectionConfig" ADD COLUMN "newCheckLastAt" DATETIME;
ALTER TABLE "CollectionConfig" ADD COLUMN "newCheckCount" INTEGER;
ALTER TABLE "CollectionConfig" ADD COLUMN "newFullScanAt" DATETIME;
ALTER TABLE "CollectionConfig" ADD COLUMN "newPendingSince" DATETIME;
ALTER TABLE "CollectionConfig" ADD COLUMN "newPendingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CollectionConfig" ADD COLUMN "lastNewTriggerAt" DATETIME;

CREATE TABLE "ProductSeen" (
    "collectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "productCreatedAt" DATETIME,

    PRIMARY KEY ("collectionId", "productId"),
    CONSTRAINT "ProductSeen_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CollectionConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
