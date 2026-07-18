import { lazy, Suspense, useEffect, useState } from 'react';
import type { WebGLGeometricCoreProps } from './WebGLGeometricCoreRuntime';
import { PERFORMANCE_MODE_ATTRIBUTE } from '../utils/performanceMode';
import { useStartupPerformanceReady } from '../contexts/StartupPerformanceContext';
import { ModelGeometricEmblem } from './ModelGeometricEmblem';
import './WebGLGeometricCore.css';

export type {
  WebGLLightMode,
  WebGLModelMode,
  WebGLGeometricCoreProps,
} from './WebGLGeometricCoreRuntime';
export type { WebGLModelVariant } from '../types/modelGeometry';

const RuntimeCore = lazy(() =>
  import('./WebGLGeometricCoreRuntime').then((module) => ({
    default: module.WebGLGeometricCore,
  })),
);

function isLiteMode() {
  return document.documentElement.getAttribute(PERFORMANCE_MODE_ATTRIBUTE) === 'lite';
}

function StaticDrawingCore({
  className = '',
  ariaLabel = '静态几何模型 / Static geometric drawing',
  variant = 'gpt',
}: WebGLGeometricCoreProps) {
  return (
    <div
      className={`webgl-geometric-core is-fallback is-lite webgl-variant-${variant} ${className}`.trim()}
      role="img"
      aria-label={ariaLabel}
    >
      <svg
        className="webgl-core-fallback webgl-core-fallback-frame"
        viewBox="0 0 440 440"
        aria-hidden="true"
      >
        <g className="webgl-fallback-orbits">
          <ellipse cx="220" cy="221" rx="202" ry="124" />
          <ellipse cx="220" cy="220" rx="186" ry="82" transform="rotate(-34 220 220)" />
          <ellipse cx="220" cy="220" rx="180" ry="72" transform="rotate(43 220 220)" />
        </g>
        <g className="webgl-fallback-cage">
          <path d="M220 24 343 95 414 220 343 345 220 416 97 345 26 220 97 95Z" />
          <path d="M220 24 414 220 220 416 26 220 220 24 343 345 97 345 343 95 97 95Z" />
        </g>
      </svg>
      <span className="webgl-core-fallback-model" aria-hidden="true">
        <ModelGeometricEmblem kind={variant} />
      </span>
    </div>
  );
}

export function WebGLGeometricCore(props: WebGLGeometricCoreProps) {
  const [liteMode, setLiteMode] = useState(isLiteMode);
  const startupReady = useStartupPerformanceReady();

  useEffect(() => {
    const observer = new MutationObserver(() => setLiteMode(isLiteMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [PERFORMANCE_MODE_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, []);

  // The high-quality SVG is shown immediately while the opening sequence is
  // running. Three.js is not even imported until that sequence has completed,
  // which removes shader compilation and WebGL context creation from boot.
  if (liteMode || !startupReady) return <StaticDrawingCore {...props} />;

  return (
    <Suspense fallback={<StaticDrawingCore {...props} />}>
      <RuntimeCore {...props} />
    </Suspense>
  );
}
