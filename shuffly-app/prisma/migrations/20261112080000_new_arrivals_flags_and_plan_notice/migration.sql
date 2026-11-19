-- Update 2: Pro new-arrivals options per collection, and the plan-change notice.
ALTER TABLE "CollectionConfig" ADD COLUMN "reshuffleOnNew" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CollectionConfig" ADD COLUMN "keepNewOnTop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CollectionConfig" ADD COLUMN "newOnTopHours" INTEGER NOT NULL DEFAULT 48;
ALTER TABLE "ShopSettings" ADD COLUMN "planNotice" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "planNoticeDismissedAt" DATETIME;
