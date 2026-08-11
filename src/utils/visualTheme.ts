export const VISUAL_THEME_STORAGE_KEY = 'cle.visual-theme';
export const VISUAL_THEME_ATTRIBUTE = 'data-visual-theme';

export type VisualTheme = 'day' | 'night';

/**
 * Night is the default canvas. The grey-blue liquid-glass material is authored
 * against the graphite palette, so a first launch that lands on the light day
 * canvas shows the interface in a finish it was not tuned for.
 *
 * An explicitly saved 'day' is still honoured — only the absent/unrecognised
 * case changed, so users who already picked day keep it.
 */
export function readVisualTheme(): VisualTheme {
  try {
    return window.localStorage.getItem(VISUAL_THEME_STORAGE_KEY) === 'day'
      ? 'day'
      : 'night';
  } catch {
    return 'night';
  }
}

export function applyVisualTheme(theme: VisualTheme): void {
  const root = document.documentElement;
  const legacyTheme = theme === 'night' ? 'dark' : 'light';

  // Keep the legacy theme attribute in sync. A number of older page styles still
  // read data-theme, so updating only data-visual-theme leaves the switch looking
  // changed while the application remains visually dark.
  root.setAttribute(VISUAL_THEME_ATTRIBUTE, theme);
  root.setAttribute('data-theme', legacyTheme);
  root.style.colorScheme = legacyTheme;
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
