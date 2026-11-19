/** Why a run finished without moving anything.
 *
 * Stored on ShuffleRun.noMoveReason as one of these codes, never as English —
 * the copy below is the only place the merchant-facing wording lives, so it
 * can be reworded without touching a single stored row. Deliberately a plain
 * `.ts` (not `.server.ts`): the engine writes these codes and the Collections
 * table and Activity feed both render them, so client and server share one
 * definition rather than two that can drift.
 */
export type NoMoveReason =
  | "BALANCED"
  | "ALL_SOLD_OUT"
  | "NONE_ELIGIBLE"
  | "TOO_FEW"
  | "NOT_MANUAL"
  | "FAILED";

const LABELS: Record<NoMoveReason, string> = {
  BALANCED: "order already balanced",
  ALL_SOLD_OUT: "every product is sold out",
  NONE_ELIGIBLE: "nothing eligible after exclusions",
  TOO_FEW: "too few products to rotate",
  NOT_MANUAL: "not on Manual sort",
  FAILED: "run failed",
};

/** The clause that follows "0 moved — ", or null for a run we have no reason
 * for (every run written before this column existed). Callers fall back to a
 * bare count in that case rather than inventing a reason they don't know. */
export function noMoveReasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return LABELS[code as NoMoveReason] ?? null;
}

/** Picks the reason for a run that completed successfully but moved nothing.
 * Order matters — the checks run most-specific first, so "every product is
 * sold out" wins over the "too few to rotate" that a fully sold-out
 * collection would also satisfy.
 *
 * `shuffledCount` is the movable pool minus sold-out items (see
 * computeShuffledOrder), i.e. how many products were genuinely available to
 * reposition after pins and never-move tags were taken out. */
export function resolveNoMoveReason(args: {
  productCount: number;
  soldOutCount: number;
  shuffledCount: number;
}): NoMoveReason {
  const { productCount, soldOutCount, shuffledCount } = args;
  if (productCount === 0) return "TOO_FEW";
  if (soldOutCount >= productCount) return "ALL_SOLD_OUT";
  // Pins and never-move tags took everything; nothing was left to rotate.
  if (shuffledCount === 0) return "NONE_ELIGIBLE";
  // One movable product can't change places with anything.
  if (shuffledCount === 1) return "TOO_FEW";
  return "BALANCED";
}

/** True when Shopify rejected a reorder because the collection isn't on
 * Manual sort. Matched on the message because the Admin API returns this as
 * a userError string, not a typed code. */
export function isNotManualSortError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /manually sorted|manual sort/i.test(error);
}
