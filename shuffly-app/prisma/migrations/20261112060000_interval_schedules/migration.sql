-- Update 2, Feature A: "every N hours" schedules (Pro).
ALTER TABLE "CollectionConfig" ADD COLUMN "intervalHours" INTEGER;
ALTER TABLE "CollectionConfig" ADD COLUMN "intervalAnchorAt" DATETIME;
ALTER TABLE "ShopSettings" ADD COLUMN "defaultIntervalHours" INTEGER;
ALTER TABLE "ShopSettings" ADD COLUMN "defaultIntervalAnchorAt" DATETIME;
