import { Component, type ReactNode } from "react";

interface ModalErrorBoundaryProps {
  children: ReactNode;
  /** Same handler the modal's own Cancel button uses — clicking Close here
   * should behave identically. */
  onClose: () => void;
}

interface ModalErrorBoundaryState {
  error: Error | null;
}

/**
 * A crash while rendering a modal's content used to leave the merchant
 * behind a dimmed, unclosable overlay — the dialog itself (backdrop, Cancel
 * button, Escape handling) lives in `<s-modal>`'s own shadow DOM, entirely
 * separate from the light-DOM children we pass it, so those children
 * throwing doesn't touch the dialog's ability to close. But an uncaught
 * error still bubbles past this content and can take down more than
 * intended. This boundary catches it locally: a short message and a real,
 * working Close button, instead of whatever half-rendered mess the crash
 * left behind.
 *
 * State resets naturally — a boundary that's caught an error unmounts and
 * remounts fresh the next time its parent modal opens again, so one bad
 * render doesn't permanently disable the dialog.
 */
export class ModalErrorBoundary extends Component<
  ModalErrorBoundaryProps,
  ModalErrorBoundaryState
> {
  state: ModalErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error(
      "[ModalErrorBoundary] modal content crashed:",
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <s-stack direction="block" gap="base" alignItems="start">
          <s-text tone="critical">
            Something went wrong showing this. Try again in a moment.
          </s-text>
          <s-button onClick={this.props.onClose}>Close</s-button>
        </s-stack>
      );
    }
    return this.props.children;
  }
}
