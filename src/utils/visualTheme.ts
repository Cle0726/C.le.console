export const VISUAL_THEME_STORAGE_KEY = 'cle.visual-theme';
export const VISUAL_THEME_ATTRIBUTE = 'data-visual-theme';

export type VisualTheme = 'day' | 'night';

export function readVisualTheme(): VisualTheme {
  try {
    return window.localStorage.getItem(VISUAL_THEME_STORAGE_KEY) === 'night'
      ? 'night'
      : 'day';
  } catch {
    return 'day';
  }
}

export function applyVisualTheme(theme: VisualTheme): void {
  document.documentElement.setAttribute(VISUAL_THEME_ATTRIBUTE, theme);
}

export function saveVisualTheme(theme: VisualTheme): void {
  try {
    window.localStorage.setItem(VISUAL_THEME_STORAGE_KEY, theme);
  } catch {
    // The visual switch should still work when storage is unavailable.
  }

  applyVisualTheme(theme);
}

export function initializeVisualTheme(): VisualTheme {
  const theme = readVisualTheme();
  applyVisualTheme(theme);
  return theme;
}
