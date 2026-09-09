import { forwardRef, useEffect, useMemo, useState } from "react";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { nextRunFor, type ScheduleType, type SlotSchedule } from "../lib/schedule-core";
import { defaultSecondSlot, normalizeHhMm, timeOptionsIncluding } from "../lib/time-slots";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What the modal was opened for. One component, four entry points: the
 * Schedule cell, the row's "···" menu, the table's bulk selection, and the
 * Settings page's shop default. The differences are all in here rather than
 * in four near-identical modals that would drift apart. */
export type ScheduleTarget =
  | { mode: "collection"; id: string; title: string; schedule: SlotSchedule; isCustom: boolean }
  | { mode: "bulk"; count: number; schedule: SlotSchedule }
  | { mode: "shop-default"; schedule: SlotSchedule };

interface ScheduleModalProps {
  target: ScheduleTarget | null;
  /** The shop's current default — what "Use shop default" resets to, and
   * what the preview shows while that option is selected. */
  shopDefault: SlotSchedule;
  timezone: string;
  /** From timeSlots(planId), NOT from a plan-name comparison. */
  slots: number;
  busy: boolean;
  /** `schedule: null` means "follow the shop default" (collection and bulk
   * modes only — the shop default itself has nothing to inherit from). */
  onConfirm: (schedule: SlotSchedule | null) => void;
  onCancel: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
export const ScheduleModal = forwardRef<any, ScheduleModalProps>(function ScheduleModal(
  { target, shopDefault, timezone, slots, busy, onConfirm, onCancel },
  ref,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
  useModalDismissWorkaround(ref as { current: any }, onCancel);

  const canPickSecondSlot = slots >= 2;
  const isShopDefault = target?.mode === "shop-default";

  const [useDefault, setUseDefault] = useState(false);
  const [time, setTime] = useState("06:00");
  const [time2, setTime2] = useState("18:00");
  const [weekday, setWeekday] = useState(1);

  // Re-seed every time a different target is opened, so the modal never shows
  // the previous collection's values for a moment.
  useEffect(() => {
    if (!target) return;
    const s = target.schedule;
    setTime(normalizeHhMm(s.scheduleTime));
    setTime2(normalizeHhMm(s.scheduleTime2 ?? defaultSecondSlot(s.scheduleTime)));
    setWeekday(s.scheduleWeekday ?? 1);
    // A collection already following the default opens on "Use shop default";
    // bulk always opens on an explicit set, since resetting is the deliberate
    // secondary choice there.
    setUseDefault(target.mode === "collection" ? !target.isCustom : false);
  }, [target]);

  // Cadence is a plan entitlement, not a per-collection choice, so it is
  // carried through untouched and only shown as context. Turning the second
  // slot on is the one thing that changes it, because "twice daily" IS the
  // cadence that has two slots.
  const baseCadence = (target?.schedule.scheduleType ?? "WEEKLY") as ScheduleType;
  const wantsSecondSlot = canPickSecondSlot && baseCadence === "TWICE_DAILY";
  const cadence: ScheduleType = baseCadence;

  const edited: SlotSchedule = useMemo(
    () => ({
      scheduleType: cadence,
      scheduleTime: time,
      scheduleTime2: wantsSecondSlot ? time2 : null,
      scheduleWeekday: cadence === "WEEKLY" ? weekday : null,
    }),
    [cadence, time, time2, weekday, wantsSecondSlot],
  );

  // The schedule the preview describes: whatever is about to be saved.
  const effective = useDefault ? shopDefault : edited;

  // Recomputed in the browser from the controlled state, using the very same
  // nextRunFor the sweep uses — so what the merchant is promised here is what
  // actually happens. This is the whole reason the preview exists: it answers
  // "when will this run?" before saving, not after.
  const preview = useMemo(() => {
    const next = nextRunFor(new Date(), timezone, effective);
    if (!next) return "Only when you press Shuffle";
    const label = next.toLocaleString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
      hour12: false,
    });
    const ms = next.getTime() - Date.now();
    const mins = Math.max(0, Math.round(ms / 60_000));
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    const away = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    return `${label} (in ${away})`;
  }, [effective, timezone]);

  const heading = !target
    ? "Schedule"
    : target.mode === "shop-default"
      ? "Default schedule for all collections"
      : target.mode === "bulk"
        ? `Schedule for ${target.count} collection${target.count === 1 ? "" : "s"}`
        : `Schedule for ${target.title}`;

  const slotsClash =
    wantsSecondSlot && !useDefault && Math.abs(toMinutes(time) - toMinutes(time2)) < 60;

  return (
    <s-modal id="schedule-modal" ref={ref} heading={heading}>
      <s-stack direction="block" gap="base">
        {isShopDefault && (
          <s-paragraph>
            <s-text color="subdued">
              All collections use this unless you set a different time on the collection itself.
            </s-text>
          </s-paragraph>
        )}

        {/* The reset. Present for a collection and for bulk; meaningless for
            the shop default, which is the thing being inherited FROM. */}
        {!isShopDefault && (
          <s-choice-list
            label="Schedule"
            name="scheduleMode"
            values={[useDefault ? "default" : "custom"]}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.values isn't in the typed event map
            onChange={(e: any) => setUseDefault((e.currentTarget?.values ?? [])[0] === "default")}
          >
            <s-choice value="default">Use shop default</s-choice>
            <s-choice value="custom">Set a specific time</s-choice>
          </s-choice-list>
        )}

        {/* Read-only context: cadence comes from the plan, not from here. */}
        <s-box padding="small-200" background="subdued" borderRadius="base">
          <s-text color="subdued">
            Cadence: {cadenceWords(cadence)} — set by your plan.
          </s-text>
        </s-box>

        {cadence === "WEEKLY" && (
          <s-select
            label="Day of week"
            value={String(weekday)}
            disabled={useDefault || undefined}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
            onChange={(e: any) => setWeekday(Number(e.currentTarget?.value ?? 1))}
          >
            {WEEKDAY_NAMES.map((name, i) => (
              <s-option key={name} value={String(i)}>
                {name}
              </s-option>
            ))}
          </s-select>
        )}

        {/* The timezone is named out loud next to the time. Without it
            merchants read "18:00" as UTC and file a bug. */}
        <s-select
          label="Time"
          value={time}
          disabled={useDefault || undefined}
          details={`${time} · ${timezone} (your store's timezone)`}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
          onChange={(e: any) => setTime(e.currentTarget?.value ?? "06:00")}
        >
          {timeOptionsIncluding(time).map((t) => (
            <s-option key={t} value={t}>
              {t}
            </s-option>
          ))}
        </s-select>

        {/* Slot two is always visible so the upgrade is discoverable, but
            disabled below the entitlement. */}
        <s-select
          label="Second shuffle at"
          value={time2}
          disabled={!canPickSecondSlot || !wantsSecondSlot || useDefault || undefined}
          details={
            !canPickSecondSlot
              ? "Two shuffles a day is a Pro feature."
              : !wantsSecondSlot
                ? "Your plan's cadence runs once a day."
                : `${time2} · ${timezone}`
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- currentTarget.value isn't in the typed event map
          onChange={(e: any) => setTime2(e.currentTarget?.value ?? "18:00")}
        >
          {timeOptionsIncluding(time2).map((t) => (
            <s-option key={t} value={t}>
              {t}
            </s-option>
          ))}
        </s-select>
        {!canPickSecondSlot && (
          <s-paragraph>
            <s-text color="subdued">Shuffle twice a day on Pro. </s-text>
            <s-link href="/app/plan">Upgrade to Pro</s-link>
          </s-paragraph>
        )}

        {slotsClash && (
          <s-paragraph>
            <s-text tone="critical">Keep the two shuffle times at least an hour apart.</s-text>
          </s-paragraph>
        )}

        <s-box padding="small-200" background="subdued" borderRadius="base">
          <s-text type="strong">Next run: </s-text>
          <s-text>{preview}</s-text>
        </s-box>
      </s-stack>

      <s-button slot="secondary-actions" onClick={onCancel}>
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={busy || slotsClash || undefined}
        onClick={() => onConfirm(useDefault && !isShopDefault ? null : edited)}
      >
        {busy ? "Saving…" : "Save schedule"}
      </s-button>
    </s-modal>
  );
});

function toMinutes(hhmm: string): number {
  const [h, m] = normalizeHhMm(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function cadenceWords(type: ScheduleType): string {
  if (type === "TWICE_DAILY") return "twice a day";
  if (type === "DAILY") return "once a day";
  if (type === "WEEKLY") return "once a week";
  return "only when you press Shuffle";
}
