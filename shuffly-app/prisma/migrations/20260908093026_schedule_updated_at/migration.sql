-- AlterTable
ALTER TABLE "CollectionConfig" ADD COLUMN "scheduleUpdatedAt" DATETIME;

-- Backfill: treat every existing collection's schedule as last changed when
-- the row was last touched. Anything already in the past is therefore older
-- than any slot due from now on, so the grace window behaves exactly as it
-- did for existing collections and nothing back-fires on first deploy.
UPDATE "CollectionConfig" SET "scheduleUpdatedAt" = "updatedAt" WHERE "scheduleUpdatedAt" IS NULL;
