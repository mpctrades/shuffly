-- AlterTable
ALTER TABLE "CollectionConfig" ADD COLUMN "sortOrderIssueAt" DATETIME;

-- AlterTable
ALTER TABLE "ShuffleRun" ADD COLUMN "noMoveReason" TEXT;
