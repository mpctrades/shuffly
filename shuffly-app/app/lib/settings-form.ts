// The Settings page's save path, as pure functions.
//
// These used to be inline in the component, which meant the only way to check
// that editing a tag or flipping the toggle actually produced the right
// submission was to click through the page in a browser. Three sessions in a
// row the browser automation failed to deliver those clicks, so the save path
// went unverified while the page "looked right" — the one failure mode a
// screenshot cannot catch.
//
// Pulling the logic out here makes both halves testable without a browser:
// these functions build exactly what the form submits, and the route's action
// consumes exactly that shape (see app.settings.test.ts, which feeds the
// output of `settingsSubmission` straight into the action).

/** "gift-card, preorder" -> ["gift-card", "preorder"]. Tolerates the stray
 * whitespace and trailing commas a hand-edited CSV column accumulates. */
export function parseTags(csv: string): string[] {
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Back to the stored CSV shape. */
export function serializeTags(tags: string[]): string {
  return tags.join(",");
}

/** Adds a tag, trimmed, if it isn't already there. Case-insensitive on the
 * duplicate check because "Gift-Card" and "gift-card" are the same tag to
 * Shopify, and adding both would silently do nothing on the second one. */
export function addTag(tags: string[], raw: string): string[] {
  const tag = raw.trim();
  if (!tag) return tags;
  if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return tags;
  return [...tags, tag];
}

/** Removes an exact tag. Exact, not case-insensitive: the chip the merchant
 * clicked carries the stored spelling, so that is the one to drop. */
export function removeTag(tags: string[], tag: string): string[] {
  return tags.filter((t) => t !== tag);
}

export interface SettingsFormState {
  tags: string[];
  autoSwitchToManual: boolean;
}

/** Exactly what the save bar submits. `autoSwitchToManual` is "on" or empty
 * because that is what the action tests for — a checkbox-style value rather
 * than "true"/"false", which would both read as truthy strings. */
export function settingsSubmission(state: SettingsFormState): Record<string, string> {
  return {
    neverMoveTags: serializeTags(state.tags),
    autoSwitchToManual: state.autoSwitchToManual ? "on" : "",
  };
}
