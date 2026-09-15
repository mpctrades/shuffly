// Replaces the two native <select> controls in the schedule modal.
//
// The time field was a 48-option native select. A native select renders an
// OS-level dropdown: it escaped the modal, covered most of the page, painted
// its selected row as a full-width orange bar heavier than anything else in
// the app, and could not be scanned. It also ate the next click — while an
// OS dropdown is open the browser spends the following click dismissing it
// rather than delivering it, which is why "Save" appeared to do nothing the
// first time.
//
// Both replacements are ordinary DOM: an s-popover, which Polaris anchors
// inside the modal's own stacking context, and button groups carrying
// aria-pressed. Nothing here is an OS widget, so dismissal is a normal DOM
// click and the click that dismisses is not swallowed.
import { useEffect, useId, useRef } from "react";
import { normalizeHhMm, parseHhMm } from "../lib/time-slots";

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = ["00", "30"];

/** Mon-first, which is how a merchant reads a week — the stored value is
 * still 0=Sunday, so the mapping lives here and nowhere else. */
const DAYS: Array<{ value: number; short: string; full: string }> = [
  { value: 1, short: "Mon", full: "Monday" },
  { value: 2, short: "Tue", full: "Tuesday" },
  { value: 3, short: "Wed", full: "Wednesday" },
  { value: 4, short: "Thu", full: "Thursday" },
  { value: 5, short: "Fri", full: "Friday" },
  { value: 6, short: "Sat", full: "Saturday" },
  { value: 0, short: "Sun", full: "Sunday" },
];

/** Shared by both pickers. Layout plus Polaris colour tokens — the selected
 * state is Polaris's own selected/emphasis pair, deliberately not a brand
 * orange fill. */
function PickerStyles() {
  return (
    <style>{`
      .shuffly-seg {
        display: flex;
        flex-wrap: wrap;
        gap: var(--p-space-100, 4px);
      }
      .shuffly-seg-cell,
      .shuffly-hour-cell {
        appearance: none;
        font: inherit;
        font-size: var(--p-font-size-325, 13px);
        font-weight: 600;
        color: var(--p-color-text, #131110);
        background: var(--p-color-bg-surface, #ffffff);
        border: 1px solid var(--p-color-border, #e3e3e3);
        border-radius: var(--p-border-radius-200, 8px);
        padding: var(--p-space-200, 8px) var(--p-space-300, 12px);
        min-height: 32px;
        cursor: pointer;
      }
      .shuffly-seg-cell:hover:not(:disabled),
      .shuffly-hour-cell:hover:not(:disabled) {
        background: var(--p-color-bg-surface-hover, #f7f7f7);
      }
      .shuffly-seg-cell[aria-pressed="true"],
      .shuffly-hour-cell[aria-pressed="true"] {
        background: var(--p-color-bg-surface-selected, #f0f0f0);
        border-color: var(--p-color-border-emphasis, #4a4a4a);
      }
      .shuffly-seg-cell:disabled,
      .shuffly-hour-cell:disabled { opacity: 0.5; cursor: default; }
      .shuffly-seg-cell:focus-visible,
      .shuffly-hour-cell:focus-visible {
        outline: 2px solid var(--p-color-border-focus, #005bd3);
        outline-offset: 1px;
      }
      /* Six per row puts all 24 hours in one glance, four rows deep, with no
         scrolling and nothing overflowing the modal. */
      .shuffly-hour-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--p-space-100, 4px);
      }
      .shuffly-hour-cell { padding: var(--p-space-200, 8px) 0; text-align: center; }
    `}</style>
  );
}

export function DayOfWeekPicker({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div style={{ marginBottom: "var(--p-space-100, 4px)" }}>
        <s-text>Day of week</s-text>
      </div>
      {/* Seven options always fit inline, so there is nothing to put in a
          dropdown — and one click instead of two. */}
      <div className="shuffly-seg" role="group" aria-label="Day of week">
        {DAYS.map((d) => (
          <button
            key={d.value}
            type="button"
            className="shuffly-seg-cell"
            aria-pressed={value === d.value}
            aria-label={d.full}
            disabled={disabled}
            onClick={() => onChange(d.value)}
          >
            {d.short}
          </button>
        ))}
      </div>
      <PickerStyles />
    </div>
  );
}

export function TimePicker({
  label,
  value,
  timezone,
  onChange,
  disabled,
  details,
}: {
  label: string;
  value: string;
  timezone: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Replaces the default "HH:MM · timezone" line when the caller has
   * something more useful to say, e.g. why the field is locked. */
  details?: string;
}) {
  const popoverId = `time-popover-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const gridRef = useRef<HTMLDivElement>(null);
  const current = normalizeHhMm(value);
  const { hour, minute } = parseHhMm(current);
  const selectedHour = String(hour).padStart(2, "0");
  const selectedMinute = minute >= 30 ? "30" : "00";

  // Arrow keys walk the grid, six per row. Enter and Space are the button's
  // own behaviour, so they need no handling here.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    function onKeyDown(e: KeyboardEvent) {
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[e.key];
      if (step == null) return;
      const cells = Array.from(grid!.querySelectorAll<HTMLButtonElement>(".shuffly-hour-cell"));
      const from = cells.indexOf(document.activeElement as HTMLButtonElement);
      if (from === -1) return;
      const to = from + step;
      if (to < 0 || to >= cells.length) return;
      e.preventDefault();
      cells[to].focus();
    }
    grid.addEventListener("keydown", onKeyDown);
    return () => grid.removeEventListener("keydown", onKeyDown);
  }, []);

  function pick(h: string, m: string) {
    onChange(`${h}:${m}`);
  }

  return (
    <div>
      <div style={{ marginBottom: "var(--p-space-100, 4px)" }}>
        <s-text>{label}</s-text>
      </div>
      {/* The trigger announces the value it holds, so a screen reader hears
          "Time, 06:00" rather than just "Time". */}
      <s-button
        commandFor={popoverId}
        disabled={disabled || undefined}
        accessibilityLabel={`${label}: ${current} ${timezone}. Choose a time`}
      >
        {current}
      </s-button>
      <div style={{ marginTop: "var(--p-space-100, 4px)" }}>
        <s-text color="subdued">{details ?? `${current} · ${timezone}`}</s-text>
      </div>

      <s-popover id={popoverId} inlineSize="280px">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <div ref={gridRef}>
              <div style={{ marginBottom: "var(--p-space-100, 4px)" }}>
                <s-text color="subdued">Hour</s-text>
              </div>
              <div className="shuffly-hour-grid" role="group" aria-label="Hour">
                {HOURS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="shuffly-hour-cell"
                    aria-pressed={h === selectedHour}
                    aria-label={`${h}:${selectedMinute}`}
                    onClick={() => pick(h, selectedMinute)}
                  >
                    {h}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div style={{ marginBottom: "var(--p-space-100, 4px)" }}>
                <s-text color="subdued">Minutes</s-text>
              </div>
              <div className="shuffly-seg" role="group" aria-label="Minutes">
                {MINUTES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="shuffly-seg-cell"
                    aria-pressed={m === selectedMinute}
                    aria-label={`${selectedHour}:${m}`}
                    onClick={() => pick(selectedHour, m)}
                  >
                    :{m}
                  </button>
                ))}
              </div>
            </div>

            {/* An explicit way out that also returns focus to the trigger,
                rather than relying on the merchant clicking elsewhere. */}
            <s-button commandFor={popoverId} command="--hide">
              Done
            </s-button>
          </s-stack>
        </s-box>
      </s-popover>
      <PickerStyles />
    </div>
  );
}
