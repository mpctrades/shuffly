-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ProcessedWebhook_receivedAt_idx" ON "ProcessedWebhook"("receivedAt");

-- CreateIndex
CREATE INDEX "ProcessedWebhook_shop_idx" ON "ProcessedWebhook"("shop");
