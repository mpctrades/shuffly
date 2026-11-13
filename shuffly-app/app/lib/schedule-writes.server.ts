// DB-side helpers shared by every action that changes a schedule.
import db from "../db.server";
import { nextRunFor } from "./schedule-core";
import { resolveSchedule, type ShopScheduleDefault } from "./schedule-resolve";

/**
 * The shop default just changed, so every collection inheriting it has a
 * new effective schedule. Nothing is copied onto those rows; only their
 * advisory countdown and scheduleUpdatedAt move. Resolved per collection
 * (not once for the shop) because an interval default gives each inheriting
 * collection its own offset.
 */
export async function repairInheritingCountdowns(
  shop: string,
  settings: ShopScheduleDefault & { timezone: string },
  now: Date,
): Promise<number> {
  const inheriting = await db.collectionConfig.findMany({
    where: { shop, scheduleType: null },
    select: {
      id: true,
      status: true,
      scheduleType: true,
      scheduleTime: true,
      scheduleTime2: true,
      scheduleWeekday: true,
      intervalHours: true,
      intervalAnchorAt: true,
    },
  });
  if (inheriting.length === 0) return 0;
  await db.$transaction(
    inheriting.map((c) =>
      db.collectionConfig.update({
        where: { id: c.id },
        data: {
          scheduleUpdatedAt: now,
          nextRunAt: c.status === "RUNNING" ? nextRunFor(now, settings.timezone, resolveSchedule(c, settings)) : null,
        },
      }),
    ),
  );
  return inheriting.length;
}
