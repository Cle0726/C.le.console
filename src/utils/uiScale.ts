export type UiScaleBand = 'compact' | 'normal' | 'large' | 'xlarge';

export function normalizeUiScale(rawScale: unknown): number {
  const scale = typeof rawScale === 'number'
    ? rawScale
    : typeof rawScale === 'string'
      ? Number.parseFloat(rawScale)
      : 1;
  return Number.isFinite(scale) ? Math.min(2, Math.max(0.8, scale)) : 1;
}

export function getUiScaleBand(scale: number): UiScaleBand {
  if (scale >= 1.55) return 'xlarge';
  if (scale >= 1.2) return 'large';
  if (scale <= 0.9) return 'compact';
  return 'normal';
}

/**
 * WebView zoom does not consistently participate in CSS media queries on
 * Windows. Reflecting the configured zoom onto the root gives responsive
 * styles a deterministic signal and prevents high zoom levels from clipping
 * navigation, action rows and data grids.
 */
export function reflectUiScale(scale: number): void {
  const normalized = normalizeUiScale(scale);
  const root = document.documentElement;
  root.dataset.uiScale = normalized.toFixed(2);
  root.dataset.uiScaleBand = getUiScaleBand(normalized);
  root.style.setProperty('--app-ui-scale', String(normalized));
}
