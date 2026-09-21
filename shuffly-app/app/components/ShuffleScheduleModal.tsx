import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useModalDismissWorkaround } from "../lib/polaris-modal";
import { nextRuns, formatRunAt, relativeDayLabel, PREVIEW_COUNT } from "../lib/next-runs";
import { CADENCES, cadenceSummary } from "../lib/schedule-cadences";
import { cheapestPlanWith, isScheduleAllowed } from "../lib/plans";
import { type ScheduleType, type SlotSchedule } from "../lib/schedule-core";
import { defaultSecondSlot, normalizeHhMm } from "../lib/time-slots";
import { DayOfWeekPicker, TimePicker } from "./TimePicker";

/** Where a merchant changes a shuffle schedule — all of them.
 *
 * One component, five entry points: the Collections table's Schedule cell,
 * that row's "···" menu, the table's bulk selection, the collection
 * Workspace's Schedule row, and the Settings page's shop default. The
 * differences between them are all in here rather than in five near-identical
 * forms, which is how the Workspace's version came to be four dropdowns while
 * the modal was a read-only cadence label.
 *
 * Frequency-first, not a settings form: the first thing on screen is what a
 * merchant is actually choosing (how often), described by its real-world
 * result ("1 run a day") rather than by its enum name. The time, the day and
 * the preview all follow from that choice.
 */
export type ScheduleTarget =
  | {
      mode: "collection";
      id: string;
      title: string;
      /** For the subtitle's "· 267 products". Omitted where the caller
       * genuinely doesn't have it; the subtitle then shows the name alone. */
      productCount?: number;
      schedule: SlotSchedule;
      isCustom: boolean;
    }
  | { mode: "bulk"; count: number; schedule: SlotSchedule }
  | { mode: "shop-default"; schedule: SlotSchedule };

interface ShuffleScheduleModalProps {
  target: ScheduleTarget | null;
  /** The shop's current default — what "Use shop default" resets to, and
   * what the form shows, read-only, while that option is selected. */
  shopDefault: SlotSchedule;
  /** The shop's own IANA timezone, from the shop record. Every time in this
   * modal is a wall clock in it, which is why it is named under the time row
   * rather than left for the merchant to assume. */
  timezone: string;
  /** From timeSlots(planId), NOT from a plan-name comparison. Gates the
   * second time input. */
  slots: number;
  /** The shop's plan id. The frequency grid reads its locks from
   * PLANS[].allowedSchedules via this — the same field the scheduler
   * enforces — so no card can offer a cadence a save would reject. */
  planId: string;
  busy: boolean;
  /** `schedule: null` means "follow the shop default" (collection and bulk
   * modes only — the shop default itself has nothing to inherit from). */
  onConfirm: (schedule: SlotSchedule | null) => void;
  onCancel: () => void;
  /** Where a locked card sends the merchant. Defaults to the plan page,
   * which is the app's only upgrade flow. */
  onUpgrade?: () => void;
}

const UPGRADE_PAGE = "/app/plan";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- showOverlay/hideOverlay aren't on the typed public props
export const ShuffleScheduleModal = forwardRef<any, ShuffleScheduleModalProps>(
  function ShuffleScheduleModal(
    { target, shopDefault, timezone, slots, planId, busy, onConfirm, onCancel, onUpgrade },
    ref,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref is always a useRef object at every call site in this app
    useModalDismissWorkaround(ref as { current: any }, onCancel);
    const navigate = useNavigate();
    const howOftenId = `freq-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

    const isShopDefault = target?.mode === "shop-default";
    const canPickSecondSlot = slots >= 2;

    const [useDefault, setUseDefault] = useState(false);
    const [cadence, setCadence] = useState<ScheduleType>("DAILY");
    const [time, setTime] = useState("06:00");
    const [time2, setTime2] = useState("18:00");
    const [weekday, setWeekday] = useState(1);

    // What the modal opened on. Save stays disabled until the form differs
    // from this — "Save schedule" on an untouched form writes a row, stamps
    // scheduleUpdatedAt and logs an activity entry for no change at all.
    const initial = useRef<{
      useDefault: boolean;
      cadence: ScheduleType;
      time: string;
      time2: string;
      weekday: number;
    } | null>(null);

    // Re-seed every time a different target is opened, so the modal never
    // shows the previous collection's values for a moment.
    useEffect(() => {
      if (!target) return;
      const s = target.schedule;
      const seedCadence = (s.scheduleType ?? "DAILY") as ScheduleType;
      const seedTime = normalizeHhMm(s.scheduleTime);
      const seedTime2 = normalizeHhMm(s.scheduleTime2 ?? defaultSecondSlot(s.scheduleTime));
      const seedWeekday = s.scheduleWeekday ?? 1;
      // A collection already following the default opens on "Use shop
      // default"; bulk always opens on an explicit set, since resetting is
      // the deliberate secondary choice there.
      const seedUseDefault = target.mode === "collection" ? !target.isCustom : false;
      setCadence(seedCadence);
      setTime(seedTime);
      setTime2(seedTime2);
      setWeekday(seedWeekday);
      setUseDefault(seedUseDefault);
      initial.current = {
        useDefault: seedUseDefault,
        cadence: seedCadence,
        time: seedTime,
        time2: seedTime2,
        weekday: seedWeekday,
      };
    }, [target]);

    const edited: SlotSchedule = useMemo(
      () => ({
        scheduleType: cadence,
        scheduleTime: time,
        scheduleTime2: cadence === "TWICE_DAILY" ? time2 : null,
        scheduleWeekday: cadence === "WEEKLY" ? weekday : null,
      }),
      [cadence, time, time2, weekday],
    );

    // The schedule everything below describes: whatever is about to be saved.
    // While "Use shop default" is selected that is the inherited schedule,
    // shown read-only — so the merchant can see what they'd get before
    // choosing it.
    const effective = useDefault ? shopDefault : edited;
    const readOnly = useDefault;

    // Read off the schedule actually on screen, not off the edit state:
    // while inheriting, those two disagree the moment a merchant tries a
    // cadence, switches back to "Use shop default", and the inherited
    // schedule is twice-daily. Driving the second input from `cadence` there
    // showed a twice-daily card with one time under it.
    const wantsSecondSlot = effective.scheduleType === "TWICE_DAILY";

    // Switching to "Custom for this collection" seeds from whatever is on
    // screen, which while inheriting is the shop default — so the custom form
    // starts from the inherited schedule rather than from an arbitrary state.
    function chooseCustom() {
      if (!useDefault) return;
      setCadence((shopDefault.scheduleType ?? "DAILY") as ScheduleType);
      setTime(normalizeHhMm(shopDefault.scheduleTime));
      setTime2(normalizeHhMm(shopDefault.scheduleTime2 ?? defaultSecondSlot(shopDefault.scheduleTime)));
      setWeekday(shopDefault.scheduleWeekday ?? 1);
      setUseDefault(false);
    }

    // Whether there is anything to save. Two collections' worth of subtlety:
    // going back to "Use shop default" when it was already the default saves
    // nothing however much the custom form was fiddled with in between, and
    // the second time only counts while the cadence actually has two slots.
    const seed = initial.current;
    const dirty = !seed
      ? false
      : useDefault !== seed.useDefault
        ? true
        : useDefault
          ? false
          : cadence !== seed.cadence ||
            time !== seed.time ||
            (cadence === "WEEKLY" && weekday !== seed.weekday) ||
            (cadence === "TWICE_DAILY" && time2 !== seed.time2);

    // Recomputed in the browser from the controlled state, using the very
    // same nextRunFor the sweep uses — so what the merchant is promised here
    // is what actually happens. This is the whole reason the preview exists:
    // it answers "when will this run?" BEFORE saving, not after.
    const runs = useMemo(
      () => nextRuns(new Date(), timezone, effective, PREVIEW_COUNT),
      [effective, timezone],
    );

    const slotsClash =
      wantsSecondSlot && !readOnly && Math.abs(toMinutes(time) - toMinutes(time2)) < 60;

    const subtitle = !target
      ? ""
      : target.mode === "shop-default"
        ? "Default for all collections"
        : target.mode === "bulk"
          ? `${target.count} collection${target.count === 1 ? "" : "s"}`
          : target.productCount == null
            ? target.title
            : `${target.title} · ${target.productCount} product${target.productCount === 1 ? "" : "s"}`;

    function upgrade() {
      onCancel();
      if (onUpgrade) onUpgrade();
      else navigate(UPGRADE_PAGE);
    }

    return (
      <s-modal id="schedule-modal" ref={ref} heading="Shuffle schedule">
        <div className="shuffly-sched">
          <div className="shuffly-sched-subtitle">
            <s-text color="subdued">{subtitle}</s-text>
          </div>

          {/* The scope choice. Present for a collection and for bulk;
              meaningless for the shop default, which is the thing being
              inherited FROM. */}
          {!isShopDefault && (
            <div
              className="shuffly-sched-scope"
              role="radiogroup"
              aria-label="Which schedule this collection follows"
            >
              <button
                type="button"
                role="radio"
                aria-checked={useDefault}
                className="shuffly-sched-scope-cell"
                onClick={() => setUseDefault(true)}
              >
                Use shop default
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!useDefault}
                className="shuffly-sched-scope-cell"
                onClick={chooseCustom}
              >
                {target?.mode === "bulk" ? "Custom for these collections" : "Custom for this collection"}
              </button>
            </div>
          )}

          <FrequencyGrid
            id={howOftenId}
            value={effective.scheduleType}
            planId={planId}
            readOnly={readOnly}
            onChange={setCadence}
            onUpgrade={upgrade}
          />

          {/* Weekly is the only cadence with a day to pick, so the picker is
              absent rather than disabled for every other one — a permanently
              greyed control is noise the merchant has to re-read each time. */}
          {effective.scheduleType === "WEEKLY" && (
            <div className={readOnly ? "shuffly-sched-readonly" : undefined}>
              <DayOfWeekPicker
                value={readOnly ? (shopDefault.scheduleWeekday ?? 1) : weekday}
                onChange={setWeekday}
                disabled={readOnly}
              />
            </div>
          )}

          {effective.scheduleType !== "MANUAL" && (
            <div className={`shuffly-sched-times${readOnly ? " shuffly-sched-readonly" : ""}`}>
              <div className="shuffly-sched-timerow">
                <s-text>{wantsSecondSlot ? "Morning" : "At"}</s-text>
                <TimePicker
                  label={wantsSecondSlot ? "Morning shuffle" : "Shuffle at"}
                  hideLabel
                  details={null}
                  value={readOnly ? normalizeHhMm(shopDefault.scheduleTime) : time}
                  timezone={timezone}
                  disabled={readOnly}
                  onChange={setTime}
                />
              </div>

              {/* Twice a day has two real slots, so it gets two real inputs.
                  This replaces a permanently-disabled "Second shuffle at"
                  field that was visible on every other cadence. */}
              {wantsSecondSlot && (
                <div className="shuffly-sched-timerow">
                  <s-text>Evening</s-text>
                  <TimePicker
                    label="Evening shuffle"
                    hideLabel
                    details={null}
                    value={
                      readOnly
                        ? normalizeHhMm(
                            shopDefault.scheduleTime2 ?? defaultSecondSlot(shopDefault.scheduleTime),
                          )
                        : time2
                    }
                    timezone={timezone}
                    disabled={readOnly || !canPickSecondSlot}
                    onChange={setTime2}
                  />
                </div>
              )}

              {/* Named once for the whole group, not under each input — and
                  read from the shop record, so two shops never see the same
                  timezone. */}
              <div className="shuffly-sched-tz">
                <s-text color="subdued">Times in {timezone}</s-text>
              </div>
            </div>
          )}

          {slotsClash && (
            <s-paragraph>
              <s-text tone="critical">Keep the two shuffle times at least an hour apart.</s-text>
            </s-paragraph>
          )}

          <NextRuns runs={runs} timezone={timezone} cadence={effective.scheduleType} />
        </div>

        <s-button slot="secondary-actions" onClick={onCancel}>
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={busy || slotsClash || !dirty || undefined}
          onClick={() => onConfirm(useDefault && !isShopDefault ? null : edited)}
        >
          {busy ? "Saving…" : "Save schedule"}
        </s-button>

        <ScheduleModalStyles />
      </s-modal>
    );
  },
);

/** "How often?" — a radiogroup of cards, one per cadence, each describing
 * what the merchant actually gets rather than naming the setting.
 *
 * Cards the plan doesn't include stay IN the grid, greyed and badged with
 * the tier that unlocks them. Hiding them would make the ceiling invisible;
 * a separate upsell block below would make it a second thing to read. The
 * badge names the real tier (daily is *Starter*, not Pro) because it comes
 * from PLANS, not from a hardcoded string.
 */
function FrequencyGrid({
  id,
  value,
  planId,
  readOnly,
  onChange,
  onUpgrade,
}: {
  id: string;
  value: ScheduleType;
  planId: string;
  readOnly: boolean;
  onChange: (next: ScheduleType) => void;
  onUpgrade: () => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);

  const cards = useMemo(
    () =>
      CADENCES.map((c) => ({
        ...c,
        locked: !isScheduleAllowed(planId, c.type),
        unlockedBy: cheapestPlanWith(c.type),
      })),
    [planId],
  );

  const selectable = cards.filter((c) => !c.locked);

  // Arrow keys move between cards and select as they go, which is what a
  // radiogroup does. Locked cards are skipped: they are not choices, and
  // stopping on one would offer a selection that can't be made.
  // Attached to each card rather than to the group: with a roving tabindex
  // the focused element IS a card, and hanging a key handler on a container
  // that is never itself focusable is the thing jsx-a11y rightly objects to.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (readOnly) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step == null) return;
      e.preventDefault();
      const from = selectable.findIndex((c) => c.type === value);
      // Wraps, so the group is a loop rather than a line with two dead ends.
      const to = (from + step + selectable.length) % selectable.length;
      const next = selectable[to];
      if (!next) return;
      onChange(next.type);
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-cadence="${next.type}"]`)
        ?.focus();
    },
    [onChange, readOnly, selectable, value],
  );

  // One tab stop for the whole group: the selected card, or the first
  // selectable one when the current value is locked (which a downgrade can
  // leave behind).
  const tabStop = selectable.some((c) => c.type === value) ? value : selectable[0]?.type;

  return (
    <div>
      <div className="shuffly-sched-label" id={id}>
        <s-text type="strong">How often?</s-text>
      </div>
      <div
        ref={gridRef}
        role="radiogroup"
        aria-labelledby={id}
        aria-disabled={readOnly || undefined}
        className={`shuffly-freq-grid${readOnly ? " shuffly-sched-readonly" : ""}`}
      >
        {cards.map((c) => {
          const selected = c.type === value;
          // aria-disabled, not `disabled`: a locked card is still reachable
          // and still announced ("unavailable"), and clicking it is how the
          // merchant gets to the upgrade — a `disabled` button would swallow
          // that click and say nothing.
          const unavailable = c.locked || readOnly;
          return (
            <button
              key={c.type}
              type="button"
              role="radio"
              data-cadence={c.type}
              aria-checked={selected}
              aria-disabled={unavailable || undefined}
              tabIndex={readOnly || c.type !== tabStop ? -1 : 0}
              className="shuffly-freq-card"
              onKeyDown={onKeyDown}
              onClick={() => {
                if (readOnly) return;
                if (c.locked) onUpgrade();
                else onChange(c.type);
              }}
            >
              <span className="shuffly-freq-title">{c.title}</span>
              <span className="shuffly-freq-sub">{c.subtitle}</span>
              {c.locked && c.unlockedBy && (
                <span className="shuffly-freq-badge">
                  <s-badge tone="neutral">{c.unlockedBy.name}</s-badge>
                </span>
              )}
              {!c.locked && c.recommended && (
                <span className="shuffly-freq-badge">
                  <s-badge tone="success">Best</s-badge>
                </span>
              )}
            </button>
          );
        })}
      </div>
      {readOnly && (
        <div className="shuffly-sched-tz">
          <s-text color="subdued">
            Inherited from the shop default. Choose &quot;Custom&quot; to change it.
          </s-text>
        </div>
      )}
    </div>
  );
}

/** The next three occurrences, recomputed live. Three rather than one
 * because one line can only prove the next run is right — three show the
 * rhythm, which is the thing the cadence cards are actually selling. */
function NextRuns({
  runs,
  timezone,
  cadence,
}: {
  runs: Date[];
  timezone: string;
  cadence: ScheduleType;
}) {
  const now = new Date();
  return (
    <div>
      <div className="shuffly-sched-nexthead">
        <s-text type="strong">Next runs</s-text>
        <s-text color="subdued">{cadenceSummary(cadence)}</s-text>
      </div>
      {runs.length === 0 ? (
        <div className="shuffly-sched-emptyruns">
          <s-text color="subdued">
            Nothing is scheduled — this collection shuffles only when you press Shuffle.
          </s-text>
        </div>
      ) : (
        <ul className="shuffly-sched-runs">
          {runs.map((run, i) => (
            <li key={run.toISOString()} className="shuffly-sched-run">
              {/* The dot carries no information a screen reader needs: the
                  order of the rows already says which is imminent. */}
              <span
                aria-hidden="true"
                className={`shuffly-sched-dot${i === 0 ? " shuffly-sched-dot--now" : ""}`}
              />
              <span className="shuffly-sched-runwhen">{formatRunAt(run, timezone)}</span>
              <span className="shuffly-sched-runrel">
                <s-text color="subdued">{relativeDayLabel(run, now, timezone)}</s-text>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function toMinutes(hhmm: string): number {
  const [h, m] = normalizeHhMm(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/** Layout and Polaris tokens only. The selection accent is the
 * critical/warning pair the Collections table already uses for a selected
 * row, so a selected card here and a selected row there are the same colour;
 * no hex is invented, and every token carries a same-hue fallback that is
 * never the source of truth. */
function ScheduleModalStyles() {
  return (
    <style>{`
      .shuffly-sched {
        display: flex;
        flex-direction: column;
        gap: var(--p-space-500, 20px);
      }
      .shuffly-sched-subtitle { margin-top: calc(-1 * var(--p-space-300, 12px)); }
      .shuffly-sched-label { margin-bottom: var(--p-space-200, 8px); }
      /* Inherited values are legible, not hidden: dimmed enough to read as
         "not yours to edit right now", not so far that the merchant can't
         see what they would get. */
      .shuffly-sched-readonly { opacity: 0.55; }

      /* --- scope toggle --- */
      .shuffly-sched-scope {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--p-space-100, 4px);
        padding: 3px;
        border: 1px solid var(--p-color-border, #e3e3e3);
        border-radius: var(--p-border-radius-300, 12px);
        background: var(--p-color-bg-surface-secondary, #f6f6f7);
      }
      .shuffly-sched-scope-cell {
        appearance: none;
        font: inherit;
        font-size: var(--p-font-size-350, 14px);
        font-weight: 600;
        color: var(--p-color-text-secondary, #6b6b6b);
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--p-border-radius-200, 8px);
        padding: var(--p-space-200, 8px) var(--p-space-300, 12px);
        min-height: 36px;
        cursor: pointer;
      }
      .shuffly-sched-scope-cell[aria-checked="true"] {
        background: var(--p-color-bg-surface, #ffffff);
        border-color: var(--p-color-border, #e3e3e3);
        color: var(--p-color-text, #131110);
      }
      .shuffly-sched-scope-cell:focus-visible {
        outline: 2px solid var(--p-color-border-focus, #005bd3);
        outline-offset: 1px;
      }

      /* --- frequency grid --- */
      /* Three across, then two, then one. Sized so a card never has to
         hyphenate its title. */
      .shuffly-freq-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--p-space-200, 8px);
      }
      @media (max-width: 640px) {
        .shuffly-freq-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 420px) {
        .shuffly-freq-grid { grid-template-columns: minmax(0, 1fr); }
        .shuffly-sched-scope { grid-template-columns: minmax(0, 1fr); }
      }
      .shuffly-freq-card {
        position: relative;
        appearance: none;
        font: inherit;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: var(--p-space-050, 2px);
        background: var(--p-color-bg-surface, #ffffff);
        border: 1px solid var(--p-color-border, #e3e3e3);
        border-radius: var(--p-border-radius-300, 12px);
        padding: var(--p-space-300, 12px) var(--p-space-350, 14px);
        /* Room for the badge in the top-right corner. */
        padding-right: var(--p-space-1000, 40px);
        min-height: 64px;
        cursor: pointer;
      }
      .shuffly-freq-card:hover[aria-checked="false"]:not([aria-disabled="true"]) {
        background: var(--p-color-bg-surface-hover, #f7f7f7);
      }
      .shuffly-freq-card[aria-checked="true"] {
        border-color: var(--p-color-border-critical, #D82C0D);
        background: var(--p-color-bg-fill-critical-secondary, #FEE9E8);
        box-shadow: inset 0 0 0 1px var(--p-color-border-critical, #D82C0D);
      }
      .shuffly-freq-card[aria-disabled="true"] {
        cursor: default;
        color: var(--p-color-text-disabled, #b5b5b5);
        background: var(--p-color-bg-surface-disabled, #fafafa);
      }
      .shuffly-freq-card[aria-disabled="true"] .shuffly-freq-title,
      .shuffly-freq-card[aria-disabled="true"] .shuffly-freq-sub {
        color: var(--p-color-text-disabled, #b5b5b5);
      }
      .shuffly-freq-card:focus-visible {
        outline: 2px solid var(--p-color-border-focus, #005bd3);
        outline-offset: 2px;
      }
      .shuffly-freq-title {
        font-size: var(--p-font-size-350, 14px);
        font-weight: 650;
        color: var(--p-color-text, #131110);
      }
      .shuffly-freq-sub {
        font-size: var(--p-font-size-325, 13px);
        color: var(--p-color-text-secondary, #6b6b6b);
      }
      .shuffly-freq-badge {
        position: absolute;
        top: var(--p-space-200, 8px);
        right: var(--p-space-200, 8px);
      }

      /* --- time row --- */
      .shuffly-sched-times {
        border: 1px solid var(--p-color-border, #e3e3e3);
        border-radius: var(--p-border-radius-300, 12px);
        padding: var(--p-space-300, 12px) var(--p-space-400, 16px);
        display: flex;
        flex-direction: column;
        gap: var(--p-space-200, 8px);
      }
      .shuffly-sched-timerow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--p-space-400, 16px);
        min-height: 40px;
      }
      .shuffly-sched-tz { margin-top: var(--p-space-100, 4px); }

      /* --- next runs --- */
      .shuffly-sched-nexthead {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--p-space-400, 16px);
        margin-bottom: var(--p-space-200, 8px);
      }
      .shuffly-sched-runs {
        list-style: none;
        margin: 0;
        padding: 0;
        border: 1px solid var(--p-color-border, #e3e3e3);
        border-radius: var(--p-border-radius-300, 12px);
        overflow: hidden;
      }
      .shuffly-sched-run {
        display: flex;
        align-items: center;
        gap: var(--p-space-300, 12px);
        padding: var(--p-space-300, 12px) var(--p-space-400, 16px);
        border-top: 1px solid var(--p-color-border, #e3e3e3);
      }
      .shuffly-sched-run:first-child {
        border-top: none;
        background: var(--p-color-bg-fill-critical-secondary, #FEE9E8);
      }
      .shuffly-sched-dot {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--p-color-icon-disabled, #c9c9c9);
      }
      .shuffly-sched-dot--now { background: var(--p-color-icon-critical, #D82C0D); }
      .shuffly-sched-runwhen {
        font-size: var(--p-font-size-350, 14px);
        color: var(--p-color-text, #131110);
      }
      .shuffly-sched-runrel { margin-left: auto; }
      .shuffly-sched-emptyruns {
        border: 1px solid var(--p-color-border, #e3e3e3);
        border-radius: var(--p-border-radius-300, 12px);
        padding: var(--p-space-300, 12px) var(--p-space-400, 16px);
      }
    `}</style>
  );
}
