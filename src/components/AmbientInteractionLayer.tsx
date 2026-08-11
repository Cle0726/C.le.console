import { useEffect, useState } from 'react';
import { PERFORMANCE_MODE_ATTRIBUTE } from '../utils/performanceMode';

const TILT_SELECTOR = [
  '.spatial-command-hero',
  '.main-card',
  '.stat-card',
  '.account-card',
  '.codex-account-card',
  '.settings-card',
  '.settings-group',
  '.codex-api-service-panel',
  '.codex-api-service-summary-card',
  '.mm-api-hero',
  '.mm-api-summary-card',
  '.mm-api-panel',
  '.folder-inline-card',
  '.model-gallery-card',
  '.jimeng-hero',
  '.jimeng-stat-grid article',
  '.jimeng-panel',
  '.jimeng-studio',
].join(',');

const BUTTON_SELECTOR = 'button:not(:disabled), .btn:not(:disabled), [role="button"]:not([aria-disabled="true"])';

export function AmbientInteractionLayer({ enabled = true }: { enabled?: boolean }) {
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
    if (!enabled) return;
    let frame = 0;
    let clientX = window.innerWidth / 2;
    let clientY = window.innerHeight / 2;
    let activeTarget: HTMLElement | null = null;
    let pendingTarget: HTMLElement | null = null;
    let activeButton: HTMLElement | null = null;
    let pendingButton: HTMLElement | null = null;
    let pressedButton: HTMLElement | null = null;
    let reboundTimer = 0;
    let lastRenderAt = 0;
    let lastEventTarget: EventTarget | null = null;
    let activeTargetRect: DOMRect | null = null;
    let activeButtonRect: DOMRect | null = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionScale = liteMode ? 0.52 : 1;

    const render = (now = performance.now()) => {
      const performanceTier = document.documentElement.dataset.frameTier === 'performance';
      const minimumFrameMs = liteMode
        ? 1000 / 30
        : performanceTier
          ? 1000 / 40
          : 0;
      if (now - lastRenderAt < minimumFrameMs) {
        frame = window.requestAnimationFrame(render);
        return;
      }
      frame = 0;
      lastRenderAt = now;
      const root = document.documentElement;
      const viewportWidth = Math.max(window.innerWidth, 1);
      const viewportHeight = Math.max(window.innerHeight, 1);
      const normalizedX = clientX / viewportWidth;
      const normalizedY = clientY / viewportHeight;
      root.style.setProperty('--pointer-x', `${Math.round(clientX)}px`);
      root.style.setProperty('--pointer-y', `${Math.round(clientY)}px`);
      root.style.setProperty('--pointer-nx', normalizedX.toFixed(4));
      root.style.setProperty('--pointer-ny', normalizedY.toFixed(4));
      root.style.setProperty(
        '--ambient-parallax-x',
        `${((normalizedX - 0.5) * -16 * motionScale).toFixed(2)}px`,
      );
      root.style.setProperty(
        '--ambient-parallax-y',
        `${((normalizedY - 0.5) * -12 * motionScale).toFixed(2)}px`,
      );
      if (activeTarget !== pendingTarget) {
        activeTarget?.classList.remove('is-pointer-active');
        activeTarget = pendingTarget;
        activeTargetRect = activeTarget?.getBoundingClientRect() ?? null;
      }
      if (activeButton !== pendingButton) {
        activeButton?.classList.remove('is-pointer-lit');
        activeButton = pendingButton;
        activeButtonRect = activeButton?.getBoundingClientRect() ?? null;
      }

      if (activeTarget) {
        const rect = activeTargetRect ?? activeTarget.getBoundingClientRect();
        activeTargetRect = rect;
        const x = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
        const y = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(rect.height, 1)));
        activeTarget.style.setProperty('--card-x', `${x * 100}%`);
        activeTarget.style.setProperty('--card-y', `${y * 100}%`);
        activeTarget.style.setProperty('--tilt-x', `${(0.5 - y) * 0.6 * motionScale}deg`);
        activeTarget.style.setProperty('--tilt-y', `${(x - 0.5) * 0.8 * motionScale}deg`);
        activeTarget.classList.add('is-pointer-active');
      }

      if (activeButton) {
        const rect = activeButtonRect ?? activeButton.getBoundingClientRect();
        activeButtonRect = rect;
        const x = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(rect.width, 1)));
        const y = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(rect.height, 1)));
        activeButton.style.setProperty('--button-glow-x', `${x * 100}%`);
        activeButton.style.setProperty('--button-glow-y', `${y * 100}%`);
        activeButton.style.setProperty('--button-origin-x', `${x * 100}%`);
        activeButton.style.setProperty('--button-origin-y', `${y * 100}%`);
        activeButton.style.setProperty('--button-shift-x', `${(x - 0.5) * 3.4 * motionScale}px`);
        activeButton.style.setProperty('--button-shift-y', `${(y - 0.5) * 2.2 * motionScale}px`);
        activeButton.style.setProperty('--button-tilt-x', `${(0.5 - y) * 8 * motionScale}deg`);
        activeButton.style.setProperty('--button-tilt-y', `${(x - 0.5) * 10 * motionScale}deg`);
        activeButton.style.setProperty('--button-depth', `${7 * motionScale}px`);
        activeButton.classList.add('is-pointer-lit');
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion.matches || event.pointerType === 'touch') return;
      clientX = event.clientX;
      clientY = event.clientY;
      document.documentElement.classList.add('has-pointer-motion');
      if (event.target !== lastEventTarget) {
        lastEventTarget = event.target;
        pendingTarget = event.target instanceof Element
          ? event.target.closest<HTMLElement>(TILT_SELECTOR)
          : null;
        pendingButton = event.target instanceof Element
          ? event.target.closest<HTMLElement>(BUTTON_SELECTOR)
          : null;
      }

      if (!frame) frame = window.requestAnimationFrame(render);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0 || !(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>(BUTTON_SELECTOR);
      if (!button) return;
      if (reboundTimer) window.clearTimeout(reboundTimer);
      pressedButton?.classList.remove('is-glass-pressed', 'is-glass-rebound');
      pressedButton = button;
      pressedButton.classList.remove('is-glass-rebound');
      pressedButton.classList.add('is-glass-pressed');
    };

    const releasePressedButton = () => {
      if (!pressedButton) return;
      const releasedButton = pressedButton;
      releasedButton.classList.remove('is-glass-pressed');
      releasedButton.classList.add('is-glass-rebound');
      pressedButton = null;
      reboundTimer = window.setTimeout(() => {
        releasedButton.classList.remove('is-glass-rebound');
        reboundTimer = 0;
      }, liteMode ? 260 : 420);
    };

    const onPointerLeave = () => {
      document.documentElement.classList.remove('has-pointer-motion');
      activeTarget?.classList.remove('is-pointer-active');
      activeButton?.classList.remove('is-pointer-lit');
      pressedButton?.classList.remove('is-glass-pressed');
      activeTarget = null;
      pendingTarget = null;
      activeButton = null;
      pendingButton = null;
      pressedButton = null;
    };

    const invalidateGeometry = () => {
      activeTargetRect = null;
      activeButtonRect = null;
      if (!document.hidden && !frame) frame = window.requestAnimationFrame(render);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      invalidateGeometry();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
    window.addEventListener('pointerup', releasePressedButton, { passive: true, capture: true });
    window.addEventListener('pointercancel', releasePressedButton, { passive: true });
    window.addEventListener('resize', invalidateGeometry, { passive: true });
    window.addEventListener('scroll', invalidateGeometry, { passive: true, capture: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);
    render(performance.now());
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', releasePressedButton, true);
      window.removeEventListener('pointercancel', releasePressedButton);
      window.removeEventListener('resize', invalidateGeometry);
      window.removeEventListener('scroll', invalidateGeometry, true);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      activeTarget?.classList.remove('is-pointer-active');
      activeButton?.classList.remove('is-pointer-lit');
      pressedButton?.classList.remove('is-glass-pressed');
      if (reboundTimer) window.clearTimeout(reboundTimer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled, liteMode]);

  if (!enabled) return null;

  return (
    <div className="ambient-interaction-layer" aria-hidden="true">
      {/*
       * Shared SVG refraction kernels. A translucent pseudo-surface first
       * captures the real backdrop, then these filters bend it like a shallow
       * water lens. Keeping two shared kernels avoids per-control canvases and
       * additional WebGL contexts while WebView2 can still composite the
       * result on the GPU.
       */}
      <svg
        className="liquid-water-filter-defs"
        width="0"
        height="0"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <filter
            id="cle-water-panel-refraction"
            x="-12%"
            y="-12%"
            width="124%"
            height="124%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.007 0.021"
              numOctaves="2"
              seed="17"
              result="panelWaterNoise"
            />
            <feGaussianBlur
              in="panelWaterNoise"
              stdDeviation="0.42"
              result="panelWaterSoft"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="panelWaterSoft"
              scale="7.5"
              xChannelSelector="R"
              yChannelSelector="G"
              result="panelWaterBent"
            />
            <feSpecularLighting
              in="panelWaterSoft"
              surfaceScale="1.8"
              specularConstant="0.34"
              specularExponent="24"
              lightingColor="#dcecf7"
              result="panelWaterLight"
            >
              <feDistantLight azimuth="218" elevation="54" />
            </feSpecularLighting>
            <feComposite
              in="panelWaterLight"
              in2="SourceAlpha"
              operator="in"
              result="panelWaterMaskedLight"
            />
            <feBlend
              in="panelWaterBent"
              in2="panelWaterMaskedLight"
              mode="screen"
            />
          </filter>

          <filter
            id="cle-water-control-refraction"
            x="-18%"
            y="-28%"
            width="136%"
            height="156%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.018 0.052"
              numOctaves="2"
              seed="29"
              result="controlWaterNoise"
            />
            <feGaussianBlur
              in="controlWaterNoise"
              stdDeviation="0.32"
              result="controlWaterSoft"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="controlWaterSoft"
              scale="4.8"
              xChannelSelector="R"
              yChannelSelector="G"
              result="controlWaterBent"
            />
            <feSpecularLighting
              in="controlWaterSoft"
              surfaceScale="2.2"
              specularConstant="0.42"
              specularExponent="28"
              lightingColor="#e8f4fb"
              result="controlWaterLight"
            >
              <feDistantLight azimuth="224" elevation="58" />
            </feSpecularLighting>
            <feComposite
              in="controlWaterLight"
              in2="SourceAlpha"
              operator="in"
              result="controlWaterMaskedLight"
            />
            <feBlend
              in="controlWaterBent"
              in2="controlWaterMaskedLight"
              mode="screen"
            />
          </filter>
        </defs>
      </svg>
      <div className="ambient-depth">
        <div className="ambient-grid" />
        <div className="ambient-caustic" />
        <div className="ambient-prism ambient-prism-a" />
        <div className="ambient-prism ambient-prism-b" />
        <div className="ambient-beam ambient-beam-a" />
        <div className="ambient-beam ambient-beam-b" />
        <div className="ambient-beam ambient-beam-c" />
        <div className="ambient-specks" />
      </div>
      <div className="ambient-grain" />
    </div>
  );
}
