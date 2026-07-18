export const PERFORMANCE_MODE_STORAGE_KEY = 'cle.performance-mode';
export const PERFORMANCE_MODE_ATTRIBUTE = 'data-performance-mode';

export type PerformanceMode = 'full' | 'lite';

export function readPerformanceMode(): PerformanceMode {
  try {
    return window.localStorage.getItem(PERFORMANCE_MODE_STORAGE_KEY) === 'lite'
      ? 'lite'
      : 'full';
  } catch {
    return 'full';
  }
}

export function applyPerformanceMode(mode: PerformanceMode): void {
  document.documentElement.setAttribute(PERFORMANCE_MODE_ATTRIBUTE, mode);
}

export function savePerformanceMode(mode: PerformanceMode): void {
  try {
    window.localStorage.setItem(PERFORMANCE_MODE_STORAGE_KEY, mode);
  } catch {
    // The current session can still switch even if storage is unavailable.
  }
  applyPerformanceMode(mode);
}

export function initializePerformanceMode(): PerformanceMode {
  const mode = readPerformanceMode();
  applyPerformanceMode(mode);
  return mode;
}
