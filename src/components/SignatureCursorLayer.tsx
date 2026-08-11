import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const ACTION_SELECTOR = [
  'a',
  'button',
  'select',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[data-cursor="action"]',
].join(',');

const TEXT_SELECTOR = [
  'input:not([type="button"]):not([type="submit"]):not([type="reset"])',
  'textarea',
  '[contenteditable="true"]',
  '[data-cursor="text"]',
].join(',');

const DISABLED_SELECTOR = [
  'button:disabled',
  'input:disabled',
  'select:disabled',
  'textarea:disabled',
  '[aria-disabled="true"]',
  '[data-cursor="disabled"]',
].join(',');

const DRAG_SELECTOR = [
  '[draggable="true"]',
  '[data-cursor="drag"]',
  '[data-cursor="grab"]',
  '.drag-handle',
  '.canvas-node',
].join(',');

const RESIZE_SELECTOR = [
  '[data-cursor="resize"]',
  '.resize-handle',
  '[class*="resize-handle"]',
].join(',');

const BUSY_SELECTOR = [
  '[aria-busy="true"]',
  '[data-loading="true"]',
  '[data-cursor="wait"]',
  '.is-loading',
].join(',');

type CursorMode = 'default' | 'action' | 'text' | 'drag' | 'dragging' | 'resize' | 'busy' | 'disabled';
type CursorMotion = 'idle' | 'cruise' | 'dart';

function cursorMode(target: EventTarget | null): CursorMode {
  if (!(target instanceof Element)) return 'default';
  if (target.closest(DISABLED_SELECTOR)) return 'disabled';
  if (target.closest(BUSY_SELECTOR)) return 'busy';
  if (target.closest(RESIZE_SELECTOR)) return 'resize';
  if (target.closest(DRAG_SELECTOR)) return 'drag';
  if (target.closest(TEXT_SELECTOR)) return 'text';
  if (target.closest(ACTION_SELECTOR)) return 'action';
  return 'default';
}

export function SignatureCursorLayer({ enabled = true }: { enabled?: boolean }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const mark = markRef.current;
    if (!layer || !mark) return;

    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    let available = false;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    let pointerMode: CursorMode = 'default';
    let pointerMotion: CursorMotion = 'idle';
    let dragging = false;
    let idleTimer = 0;
    let lastPointerX = 0;
    let lastPointerY = 0;
    let lastMoveAt = performance.now();
    let lastModeTarget: EventTarget | null = null;

    const paintCursor = () => {
      frame = 0;
      mark.style.transform = `translate3d(${pointerX}px, ${pointerY}px, 0)`;
      layer.dataset.mode = dragging ? 'dragging' : pointerMode;
      layer.dataset.motion = pointerMotion;
      layer.classList.add('is-visible');
    };

    const syncAvailability = () => {
      available = enabled
        && finePointer.matches;
      document.documentElement.classList.toggle('has-signature-cursor', available);
      layer.classList.toggle('is-enabled', available);
      if (!available) {
        layer.classList.remove('is-visible', 'is-pressed', 'is-dragging');
        if (frame) window.cancelAnimationFrame(frame);
        if (idleTimer) window.clearTimeout(idleTimer);
        frame = 0;
        idleTimer = 0;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!available || event.pointerType === 'touch') return;
      const now = performance.now();
      const elapsed = Math.max(1, now - lastMoveAt);
      const deltaX = event.clientX - lastPointerX;
      const deltaY = event.clientY - lastPointerY;
      const speed = Math.hypot(deltaX, deltaY) / elapsed;
      pointerX = event.clientX;
      pointerY = event.clientY;
      lastPointerX = pointerX;
      lastPointerY = pointerY;
      lastMoveAt = now;
      pointerMotion = speed > 1.05 ? 'dart' : speed > 0.16 ? 'cruise' : 'idle';
      const turn = Math.max(-10, Math.min(10, deltaY * 0.42));
      mark.style.setProperty('--fish-turn', `${turn}deg`);
      if (event.target !== lastModeTarget) {
        lastModeTarget = event.target;
        pointerMode = cursorMode(event.target);
      }
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        pointerMotion = 'idle';
        mark.style.setProperty('--fish-turn', '0deg');
        if (!frame) frame = window.requestAnimationFrame(paintCursor);
      }, 92);
      if (!frame) frame = window.requestAnimationFrame(paintCursor);
    };

    const createClickBurst = (event: PointerEvent) => {
      if (!available || event.pointerType === 'touch') return;
      const burst = document.createElement('i');
      burst.className = [
        'signature-click-burst',
        event.button === 2 ? 'is-secondary' : '',
        pointerMode === 'action' ? 'is-action' : '',
        event.detail > 1 ? 'is-emphasis' : '',
      ].filter(Boolean).join(' ');
      burst.style.left = `${event.clientX}px`;
      burst.style.top = `${event.clientY}px`;
      /* Two nodes, not fourteen. A ripple ring and a contact bloom read as the
         surface responding; a radial spray of rays reads as a firework. */
      burst.innerHTML = '<i class="sig-ripple"></i><i class="sig-bloom"></i>';
      layer.appendChild(burst);
      burst.addEventListener('animationend', () => burst.remove(), { once: true });
      window.setTimeout(() => burst.remove(), 900);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!available) return;
      pointerMode = cursorMode(event.target);
      if (pointerMode === 'disabled' || pointerMode === 'busy') return;
      dragging = pointerMode === 'drag';
      layer.classList.add('is-pressed');
      layer.classList.toggle('is-dragging', dragging);
      if (!frame) frame = window.requestAnimationFrame(paintCursor);
      createClickBurst(event);
    };
    const onPointerUp = () => {
      dragging = false;
      layer.classList.remove('is-pressed', 'is-dragging');
      if (!frame) frame = window.requestAnimationFrame(paintCursor);
    };
    const onPointerLeave = (event: PointerEvent) => {
      if (event.relatedTarget == null) {
        dragging = false;
        layer.classList.remove('is-visible', 'is-pressed', 'is-dragging');
      }
    };

    finePointer.addEventListener('change', syncAvailability);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true, capture: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true });
    document.documentElement.addEventListener('pointerout', onPointerLeave);
    syncAvailability();

    return () => {
      finePointer.removeEventListener('change', syncAvailability);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp);
      document.documentElement.removeEventListener('pointerout', onPointerLeave);
      document.documentElement.classList.remove('has-signature-cursor');
      if (frame) window.cancelAnimationFrame(frame);
      if (idleTimer) window.clearTimeout(idleTimer);
    };
  }, [enabled]);

  if (typeof document === 'undefined') return null;

  return createPortal((
    <div ref={layerRef} className="signature-cursor-layer" data-mode="default" aria-hidden="true">
      <div ref={markRef} className="signature-cursor-mark">
        <span className="signature-fish-wake">
          <i />
          <i />
          <i />
        </span>
        <span className="signature-fish-bow-foam">
          <i />
          <i />
        </span>
        <svg viewBox="0 0 38 26" focusable="false">
          <path className="signature-fish-tail" d="M28.1 12.8 36 5.9l-1 7 1 7-7.9-6.5Z" />
          <path className="signature-fish-body" d="M1.7 12.85C6.1 5.1 15.8 2.75 24.2 6.4c3.5 1.5 6 4.05 7.4 6.45-1.4 2.4-3.9 4.95-7.4 6.45-8.4 3.65-18.1 1.3-22.5-6.45Z" />
          <path className="signature-fish-fin" d="m17.2 6.05 4.3-4.2 1.7 5.45M17.2 19.65l4.3 4.15 1.7-5.4" />
          <path className="signature-fish-gill" d="M8.2 9.2c-1.25 2.05-1.25 5.25 0 7.3" />
          <circle className="signature-fish-eye" cx="6.35" cy="11.15" r="1.25" />
          <path className="signature-fish-mouth" d="M1.9 13.45h2.5" />
        </svg>
      </div>
    </div>
  ), document.body);
}
