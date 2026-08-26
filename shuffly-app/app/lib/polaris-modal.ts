// Workaround for a real bug in Shopify's hosted `polaris.js`: `<s-modal>`'s
// `hideOverlay()` — and everything that calls it internally (the built-in
// ✕ button, a backdrop click, Escape) — checks for `window.shopify._internal`
// and, if present, awaits `window.shopify._internal.modal.hide(id)` INSTEAD
// of closing its own <dialog>. That `_internal` object is set up
// unconditionally the moment App Bridge's script loads (i.e. on every
// embedded app, always) but its `.modal.hide()` is a genuine no-op unless the
// app is running inside a native host that supplies a real `internalModal`
// bridge — which an ordinary embedded iframe (or a standalone dev-tunnel
// preview) never has. So the "hide" call resolves having done nothing, the
// underlying <dialog> never gets `.close()` called on it, and the modal is
// stuck open with every dismiss path (Cancel, ✕, backdrop, Escape) looking
// equally unresponsive — there's no thrown error because it's a deliberate,
// silent feature-detection branch, not a crash.
//
// `<s-modal>` renders with an *open* shadow root (`attachShadow({mode:
// "open"})`), so we can reach the real <dialog> ourselves and close it
// directly, bypassing the broken delegation entirely.
//
// A correction to an earlier version of this comment: `.modal.show(id, r)`
// on open goes through that exact same `_internal`/`internalModal` gate —
// verified by reading Shopify's actual app-bridge.js — so it's JUST as much
// a no-op in a plain embedded iframe as `.hide()` is. Neither call reaches
// Admin at all here. That means Admin dimming and staying stuck dimmed
// after a modal closes is NOT this bridge — something else is causing it,
// still unconfirmed. `notifyAdminClosed()` below is kept only because it's
// harmless (a no-op guarded in a try/catch) and might matter in some other
// host (Shopify's mobile app, POS) that actually supplies `internalModal` —
// but don't trust it to be *the* fix for admin-dimming bugs; it isn't one
// in the environment this app actually runs in.

import { useEffect, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the imperative s-modal instance isn't part of the typed public props
type ModalEl = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ref objects for s-modal are typed `any` throughout this app
type ModalRef = { current: ModalEl };

function findDialog(modalEl: ModalEl): HTMLDialogElement | null {
  return modalEl?.shadowRoot?.querySelector?.("dialog") ?? null;
}

/** Best-effort: tell Shopify Admin's own bridge this modal closed, so it
 * stops dimming its chrome around the iframe. Never lets a missing/broken
 * bridge (dev-tunnel preview, older Admin) throw — the real close above
 * already happened either way. */
function notifyAdminClosed(modalEl: ModalEl): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.shopify._internal is an undocumented App Bridge bridge, not in any type package
    const bridge = (window as any)?.shopify?._internal;
    void bridge?.modal?.hide?.(modalEl?.id ?? "");
  } catch {
    // best-effort only
  }
}

/** Close an `<s-modal>` directly, instead of calling its own `hideOverlay()`. */
export function closeModal(modalEl: ModalEl): void {
  const dialog = findDialog(modalEl);
  if (dialog?.open) dialog.close();
  notifyAdminClosed(modalEl);
}

/**
 * Makes the built-in ✕ button, a backdrop click, and the Escape key actually
 * close an `<s-modal>` — see the file header for why they don't by default.
 * `onAfterClose` (optional) fires whenever any of those three trigger a
 * close, so callers can mirror whatever their own Cancel button does.
 */
export function useModalDismissWorkaround(
  modalRef: ModalRef,
  onAfterClose?: () => void,
): void {
  const onAfterCloseRef = useRef(onAfterClose);
  onAfterCloseRef.current = onAfterClose;

  useEffect(() => {
    const modalEl = modalRef.current;
    if (!modalEl) return;

    const controller = new AbortController();
    const { signal } = controller;

    function forceClose(dialog: HTMLDialogElement) {
      if (dialog.open) dialog.close();
      notifyAdminClosed(modalRef.current);
      onAfterCloseRef.current?.();
    }

    function wire(dialog: HTMLDialogElement) {
      // Clicking the backdrop lands directly on the <dialog> itself (the
      // standard way to distinguish it from a click on its content).
      dialog.addEventListener(
        "click",
        (e) => {
          if (e.target === dialog) forceClose(dialog);
        },
        { signal },
      );
      dialog.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Escape") forceClose(dialog);
        },
        { signal },
      );
      const closeButton: HTMLElement | null =
        modalEl.shadowRoot?.querySelector(".close s-button") ?? null;
      closeButton?.addEventListener("click", () => forceClose(dialog), {
        signal,
      });
    }

    const existing = findDialog(modalEl);
    if (existing) {
      wire(existing);
    } else if (modalEl.shadowRoot) {
      // The shadow content can render a tick after connection — wait for it.
      const observer = new MutationObserver(() => {
        const dialog = findDialog(modalEl);
        if (dialog) {
          wire(dialog);
          observer.disconnect();
        }
      });
      observer.observe(modalEl.shadowRoot, { childList: true, subtree: true });
      signal.addEventListener("abort", () => observer.disconnect());
    }

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modalRef is a stable ref object; onAfterClose is read via onAfterCloseRef
  }, [modalRef]);
}
