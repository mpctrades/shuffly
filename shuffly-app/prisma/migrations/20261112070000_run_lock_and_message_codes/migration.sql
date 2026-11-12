-- Update 2: per-collection run lock, and structured (translatable) activity messages.
ALTER TABLE "CollectionConfig" ADD COLUMN "runLockedUntil" DATETIME;
ALTER TABLE "CollectionConfig" ADD COLUMN "runLockToken" TEXT;
ALTER TABLE "ShuffleRun" ADD COLUMN "messageCode" TEXT;
ALTER TABLE "ShuffleRun" ADD COLUMN "messageParams" TEXT;
