export const FRAME_GOVERNOR_EVENT = 'cle:frame-governor';

export type FrameTier = 'native' | 'balanced' | 'performance';

export interface FrameGovernorSnapshot {
  tier: FrameTier;
  frameTimeMs: number;
  targetFrameTimeMs: number;
  fps: number;
  targetFps: number;
  interacting: boolean;
  pixelRatioCap: number;
  longTasks: number;
}

declare global {
  interface Window {
    __CLE_FRAME_GOVERNOR__?: FrameGovernorSnapshot;
    __CLE_FRAME_GOVERNOR_STARTED__?: boolean;
  }
}

const FULL_PIXEL_RATIO_CAP: Record<FrameTier, number> = {
  native: 2,
  balanced: 1.72,
  performance: 1.48,
};

const LITE_PIXEL_RATIO_CAP: Record<FrameTier, number> = {
  native: 1.35,
  balanced: 1.2,
  performance: 1,
};

function nextLowerTier(tier: FrameTier): FrameTier {
  if (tier === 'native') return 'balanced';
  return 'performance';
}

function nextHigherTier(tier: FrameTier): FrameTier {
  if (tier === 'performance') return 'balanced';
  return 'native';
}

function createSnapshot(
  tier: FrameTier,
  frameTimeMs: number,
  targetFrameTimeMs: number,
  interacting: boolean,
  longTasks: number,
): FrameGovernorSnapshot {
  const liteMode = document.documentElement.dataset.performanceMode === 'lite';
  const tierCap = (liteMode ? LITE_PIXEL_RATIO_CAP : FULL_PIXEL_RATIO_CAP)[tier];
  // Full mode deliberately keeps a larger drawing buffer during pointer
  // interaction. Modern discrete GPUs handle this better than repeatedly
  // reallocating a low-resolution buffer while the user moves the mouse.
  const interactionCap = interacting
    ? (liteMode ? 1.15 : 1.78)
    : Number.POSITIVE_INFINITY;
  return {
    tier,
    frameTimeMs: Number(frameTimeMs.toFixed(2)),
    targetFrameTimeMs: Number(targetFrameTimeMs.toFixed(2)),
    fps: Number((1000 / Math.max(frameTimeMs, 1)).toFixed(1)),
    targetFps: Number((1000 / Math.max(targetFrameTimeMs, 1)).toFixed(1)),
    interacting,
    pixelRatioCap: Math.min(tierCap, interactionCap),
    longTasks,
  };
}

function publish(snapshot: FrameGovernorSnapshot): void {
  window.__CLE_FRAME_GOVERNOR__ = snapshot;
  document.documentElement.dataset.frameTier = snapshot.tier;
  document.documentElement.dataset.frameInteracting = snapshot.interacting ? 'true' : 'false';
  window.dispatchEvent(new CustomEvent<FrameGovernorSnapshot>(FRAME_GOVERNOR_EVENT, {
    detail: snapshot,
  }));
}

export function readFrameGovernorSnapshot(): FrameGovernorSnapshot {
  return window.__CLE_FRAME_GOVERNOR__
    ?? createSnapshot('native', 16.67, 16.67, false, 0);
}

/**
 * Small adaptive render governor inspired by real-time engines:
 * visual effects remain enabled, while GPU drawing-buffer resolution is
 * adjusted only when the measured frame budget is consistently missed.
 */
export function initializeFrameGovernor(): void {
  if (window.__CLE_FRAME_GOVERNOR_STARTED__) return;
  window.__CLE_FRAME_GOVERNOR_STARTED__ = true;

  let tier: FrameTier = 'native';
  let frameTimeMs = 16.67;
  let targetFrameTimeMs = 16.67;
  const refreshSamples: number[] = [];
  let lastFrameAt = performance.now();
  let lastEvaluationAt = lastFrameAt;
  let recoveryWindows = 0;
  let overloadWindows = 0;
  let longTasks = 0;
  let frame = 0;
  let interactionTimer = 0;
  let interactionUntil = 0;
  let interacting = false;

  const publishCurrent = () => publish(createSnapshot(
    tier,
    frameTimeMs,
    targetFrameTimeMs,
    interacting,
    longTasks,
  ));

  const finishInteraction = () => {
    const remaining = interactionUntil - performance.now();
    if (remaining > 0) {
      interactionTimer = window.setTimeout(finishInteraction, remaining);
      return;
    }
    interactionTimer = 0;
    interacting = false;
    publishCurrent();
  };

  const setInteracting = () => {
    interactionUntil = performance.now() + 180;
    if (!interacting) {
      interacting = true;
      publishCurrent();
    }
    if (!interactionTimer) {
      interactionTimer = window.setTimeout(finishInteraction, 180);
    }
  };

  const evaluate = (now: number) => {
    const overBudget = frameTimeMs > targetFrameTimeMs * 1.35 || longTasks >= 2;
    const comfortablyWithinBudget = frameTimeMs < targetFrameTimeMs * 1.12 && longTasks === 0;

    overloadWindows = overBudget ? overloadWindows + 1 : 0;
    recoveryWindows = comfortablyWithinBudget ? recoveryWindows + 1 : 0;

    if (overloadWindows >= 2 && tier !== 'performance') {
      tier = nextLowerTier(tier);
      overloadWindows = 0;
      recoveryWindows = 0;
    } else if (recoveryWindows >= 5 && tier !== 'native') {
      tier = nextHigherTier(tier);
      overloadWindows = 0;
      recoveryWindows = 0;
    }

    publishCurrent();
    longTasks = 0;
    lastEvaluationAt = now;
  };

  const tick = (now: number) => {
    const delta = now - lastFrameAt;
    lastFrameAt = now;
    if (delta > 0 && delta < 120) {
      if (refreshSamples.length < 90 && delta <= 24) {
        refreshSamples.push(delta);
        if (refreshSamples.length === 90) {
          const sorted = [...refreshSamples].sort((a, b) => a - b);
          const percentile20 = sorted[Math.floor(sorted.length * 0.2)] ?? 16.67;
          targetFrameTimeMs = Math.min(16.67, Math.max(6.5, percentile20));
        }
      }
      frameTimeMs += (delta - frameTimeMs) * 0.08;
    }
    if (now - lastEvaluationAt >= 1000) evaluate(now);
    frame = window.requestAnimationFrame(tick);
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    lastFrameAt = performance.now();
    lastEvaluationAt = lastFrameAt;
    if (!frame) frame = window.requestAnimationFrame(tick);
  };

  let longTaskObserver: PerformanceObserver | null = null;
  if ('PerformanceObserver' in window) {
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        longTasks += list.getEntries().filter((entry) => entry.duration >= 50).length;
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      longTaskObserver = null;
    }
  }

  window.addEventListener('pointerdown', setInteracting, { passive: true });
  window.addEventListener('pointermove', setInteracting, { passive: true });
  window.addEventListener('wheel', setInteracting, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);
  publishCurrent();
  frame = window.requestAnimationFrame(tick);

  window.addEventListener('pagehide', () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.clearTimeout(interactionTimer);
    longTaskObserver?.disconnect();
  }, { once: true });
}
