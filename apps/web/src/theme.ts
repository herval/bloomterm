import { useEffect, useState } from 'react';

// Light or dark. Light is the default; "system" follows the OS. The choice is this browser's
// (localStorage), so it applies before anything loads from bloomd. Colors live in styles.css
// as tokens; charts read the same tokens.

export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const KEY = 'bloomterm.theme';
const EVENT = 'bloomterm:theme';
const dark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

export const resolveTheme = (pref: ThemePref): Theme => (pref === 'system' ? (dark() ? 'dark' : 'light') : pref);

/** Puts the theme on <html>, and tells charts to repaint. */
export function applyTheme(pref = themePref()): Theme {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1014' : '#fbfbfc');
  window.dispatchEvent(new Event(EVENT));
  return theme;
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // private window: it lasts until reload
  }
  applyTheme(pref);
}

/** Applies the theme now and follows the OS when the choice is "system". Call once, before rendering. */
export function initTheme(): void {
  applyTheme();
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (themePref() === 'system') applyTheme('system');
    });
  }
}

export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const [state, setState] = useState(() => ({ pref: themePref(), theme: (document.documentElement.dataset.theme as Theme) ?? resolveTheme(themePref()) }));
  useEffect(() => {
    const on = () => setState({ pref: themePref(), theme: document.documentElement.dataset.theme as Theme });
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return { ...state, setPref: setThemePref };
}

/** A color token's current value, e.g. token('--up'). */
export const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** #rrggbb at some opacity. */
export function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${a})` : hex;
}
