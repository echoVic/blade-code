/**
 * Blade Web · lightweight i18n runtime.
 *
 * Design goals:
 * — Zero new dependency: React `useSyncExternalStore` only.
 * — Type-safe: `TranslationKey` is the union of all keys in the source (`en`)
 *   dictionary; other locales must satisfy the same shape.
 * — Cheap: `t()` is a plain lookup + `{param}` interpolation.
 * — Test-safe: default detector prefers `localStorage`, then `navigator.language`;
 *   in jsdom (test env) `navigator.language` is `en-US`, so the resolved locale
 *   is `en` and existing English text assertions continue to pass.
 */

import { useSyncExternalStore } from 'react';
import { type Dict, en, type TranslationKey } from './en';
import { zh } from './zh';

export type Locale = 'en' | 'zh';
export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh'];

const DICTIONARIES: Record<Locale, Dict> = { en, zh };

const STORAGE_KEY = 'blade-ui-locale';

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

function detectInitialLocale(): Locale {
  if (isBrowser) {
    try {
      const stored = window.localStorage?.getItem(STORAGE_KEY);
      if (stored === 'en' || stored === 'zh') return stored;
    } catch {
      // localStorage may throw in privacy modes — fall through to detection.
    }
    const nav =
      (typeof navigator !== 'undefined' &&
        (navigator.language || navigator.languages?.[0])) ||
      '';
    if (nav.toLowerCase().startsWith('zh')) return 'zh';
    return 'en';
  }
  return 'en';
}

// ── Module-level store (subscribable, works with useSyncExternalStore) ────────
let currentLocale: Locale = detectInitialLocale();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(next: Locale): void {
  if (next === currentLocale) return;
  currentLocale = next;
  if (isBrowser) {
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // ignore quota / disabled storage
    }
    // Reflect on <html lang="…"> for a11y + browser translation heuristics.
    if (document?.documentElement) {
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    }
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Interpolation ─────────────────────────────────────────────────────────────
export type Params = Record<string, string | number>;

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}

// ── Public translation function (imperative use) ──────────────────────────────
/**
 * Look up a translation for the current locale, falling back to English if a
 * key is missing (should be impossible thanks to `Dict` type-check, but we
 * keep the guard for hot-reload safety and future locales added incrementally).
 */
export function t<K extends TranslationKey>(key: K, params?: Params): string {
  const dict = DICTIONARIES[currentLocale] ?? DICTIONARIES.en;
  const raw = dict[key] ?? DICTIONARIES.en[key];
  return interpolate(raw, params);
}

// ── React hook ────────────────────────────────────────────────────────────────
/**
 * Returns a stable-per-locale translator. Re-renders when locale changes.
 *
 *   const t = useT();
 *   t('sidebar.action.newTask');
 *   t('capacity.title', { inFlight: 1, queued: 2, max: 3 });
 */
export function useT(): (key: TranslationKey, params?: Params) => string {
  useSyncExternalStore(
    subscribe,
    () => currentLocale,
    () => 'en' as Locale
  );
  return t;
}

/**
 * Hook variant that also returns the current locale + setter.
 * Used by <LanguageSwitcher/>.
 */
export function useLocale(): {
  locale: Locale;
  setLocale: (next: Locale) => void;
} {
  const locale = useSyncExternalStore(
    subscribe,
    () => currentLocale,
    () => 'en' as Locale
  );
  return { locale, setLocale };
}

// Ensure <html lang> reflects the detected locale on load (browser only).
if (isBrowser && document?.documentElement) {
  document.documentElement.lang = currentLocale === 'zh' ? 'zh-CN' : 'en';
}

export type { TranslationKey };
