import db from "../db.server";

/** Shopify stops retrying a delivery within a day or two; a week is margin. */
const RETENTION_MS = 7 * 86_400_000;

/**
 * Record that we're acting on this delivery. Returns true when the same
 * X-Shopify-Webhook-Id was already recorded — a retry or a duplicate — so the
 * caller acknowledges it and does nothing more.
 *
 * Fails open: if the insert itself errors (anything but the duplicate key),
 * the delivery is processed as before. A double reaction is a smaller harm
 * than a dropped one.
 */
export async function isDuplicateDelivery(webhookId: string | undefined, shop: string, topic: string): Promise<boolean> {
  if (!webhookId) return false;
  try {
    await db.processedWebhook.create({ data: { id: webhookId, shop, topic } });
    return false;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return true;
    console.error(`[webhook-dedupe] couldn't record ${topic} ${webhookId}:`, err);
    return false;
  }
}

export async function pruneProcessedWebhooks(now = new Date()): Promise<number> {
  const result = await db.processedWebhook.deleteMany({
    where: { receivedAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  });
  return result.count;
}
