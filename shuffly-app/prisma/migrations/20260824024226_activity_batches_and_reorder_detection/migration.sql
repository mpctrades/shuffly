-- AlterTable
ALTER TABLE "CollectionConfig" ADD COLUMN "lastKnownOrder" TEXT;

-- AlterTable
ALTER TABLE "ShuffleRun" ADD COLUMN "batchId" TEXT;

-- CreateIndex
CREATE INDEX "ShuffleRun_shop_batchId_idx" ON "ShuffleRun"("shop", "batchId");
