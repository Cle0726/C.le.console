import { useEffect, useRef, useState } from 'react';
import { PERFORMANCE_MODE_ATTRIBUTE } from '../utils/performanceMode';

const TILT_SELECTOR = [
  '.spatial-command-hero',
  '.main-card',
  '.stat-card',
  '.account-card',
  '.settings-card',
  '.codex-api-service-panel',
].join(',');

export function AmbientInteractionLayer({ enabled = true }: { enabled?: boolean }) {
  const cursorRef = useRef<HTMLDivElement>(null);
  const [liteMode, setLiteMode] = useState(
    () => document.documentElement.getAttribute(PERFORMANCE_MODE_ATTRIBUTE) === 'lite',
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setLiteMode(document.documentElement.getAttribute(PERFORMANCE_MODE_ATTRIBUTE) === 'lite');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [PERFORMANCE_MODE_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (liteMode || !enabled) return;
    let frame = 0;
    let clientX = window.innerWidth / 2;
    let clientY = window.innerHeight / 2;

    const render = () => {
      frame = 0;
      const root = document.documentElement;
      root.style.setProperty('--pointer-x', `${clientX}px`);
      root.style.setProperty('--pointer-y', `${clientY}px`);
      root.style.setProperty('--pointer-nx', `${clientX / Math.max(window.innerWidth, 1)}`);
      root.style.setProperty('--pointer-ny', `${clientY / Math.max(window.innerHeight, 1)}`);
      if (cursorRef.current) {
        cursorRef.current.style.transform = `translate3d(${clientX}px, ${clientY}px, 0)`;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      clientX = event.clientX;
      clientY = event.clientY;
      document.documentElement.classList.add('has-pointer-motion');

      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(TILT_SELECTOR) : null;
      document.querySelectorAll<HTMLElement>('.is-pointer-active')
        .forEach((item) => {
          if (item !== target) item.classList.remove('is-pointer-active');
        });

      if (target) {
        const rect = target.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1)));
        const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(rect.height, 1)));
        target.style.setProperty('--card-x', `${x * 100}%`);
        target.style.setProperty('--card-y', `${y * 100}%`);
        target.style.setProperty('--tilt-x', `${(0.5 - y) * 2.4}deg`);
        target.style.setProperty('--tilt-y', `${(x - 0.5) * 3.2}deg`);
        target.classList.add('is-pointer-active');
      }

      if (!frame) frame = window.requestAnimationFrame(render);
    };

    const onPointerLeave = () => {
      document.documentElement.classList.remove('has-pointer-motion');
      document.querySelectorAll<HTMLElement>('.is-pointer-active').forEach((item) => {
        item.classList.remove('is-pointer-active');
      });
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    render();
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled, liteMode]);

  if (liteMode || !enabled) return null;

  return (
    <div className="ambient-interaction-layer" aria-hidden="true">
      <div className="ambient-grid" />
      <div className="ambient-beam ambient-beam-a" />
      <div className="ambient-beam ambient-beam-b" />
      <div className="cursor-aura" ref={cursorRef} />
      <div className="ambient-grain" />
    </div>
  );
}
