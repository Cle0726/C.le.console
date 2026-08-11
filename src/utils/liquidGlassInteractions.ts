/**
 * Ambient light field position.
 *
 * This used to follow the pointer: every pointermove scheduled a frame that
 * rewrote --lg26-pointer-x/y on the root element, and two full-viewport
 * radial-gradient layers repainted as a result. On a wide window that is a
 * full-screen repaint per mouse move, which was one of the largest sources of
 * interface stutter.
 *
 * The light field is now fixed. The gradients that read these variables keep
 * working unchanged — they simply stop chasing the cursor, so the compositor
 * can promote them once and leave them alone.
 */
export function initializeLiquidGlassInteractions(): void {
  if (typeof window === "undefined" || document.documentElement.dataset.lg26Ready === "true") {
    return;
  }

  document.documentElement.dataset.lg26Ready = "true";

  const root = document.documentElement;
  root.style.setProperty("--lg26-pointer-x", "34vw");
  root.style.setProperty("--lg26-pointer-y", "22vh");
}
