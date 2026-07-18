import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

let openPortalCount = 0;

type ModalPortalProps = {
  children: ReactNode;
};

/**
 * Render dialogs outside page scroll and perspective containers.
 *
 * Account workspaces deliberately use their own scrolling surface. A fixed
 * overlay nested below that surface is still constrained when an ancestor
 * establishes a 3D containing block, so fullscreen dialogs must live under
 * `document.body` instead.
 */
export function ModalPortal({ children }: ModalPortalProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    openPortalCount += 1;
    document.documentElement.classList.add('modal-portal-open');
    document.body.classList.add('modal-portal-open');

    const focusTimer = window.setTimeout(() => {
      const focusTarget = layerRef.current?.querySelector<HTMLElement>(
        '[autofocus], button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      focusTarget?.focus({ preventScroll: true });
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      openPortalCount = Math.max(0, openPortalCount - 1);
      if (openPortalCount === 0) {
        document.documentElement.classList.remove('modal-portal-open');
        document.body.classList.remove('modal-portal-open');
      }
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div ref={layerRef} className="modal-portal-layer" data-modal-portal-root="true">
      {children}
    </div>,
    document.body,
  );
}
