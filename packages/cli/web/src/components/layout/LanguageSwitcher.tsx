import { type Locale, SUPPORTED_LOCALES, useLocale, useT } from '@/i18n';
import { cn } from '@/lib/utils';

interface LanguageSwitcherProps {
  className?: string;
  /**
   * `pill` — inline segmented control (default), fits the sidebar footer strip.
   * `compact` — icon-sized single button for the collapsed rail.
   */
  variant?: 'pill' | 'compact';
}

const LABEL_KEYS: Record<Locale, 'sidebar.language.en' | 'sidebar.language.zh'> = {
  en: 'sidebar.language.en',
  zh: 'sidebar.language.zh',
};

/**
 * Two-option segmented control for switching UI locale (EN / 中).
 * — Kept intentionally small: no dropdown for two options is faster to hit.
 * — Persists via `setLocale` (localStorage under the hood).
 */
export function LanguageSwitcher({
  className,
  variant = 'pill',
}: LanguageSwitcherProps) {
  const { locale, setLocale } = useLocale();
  const t = useT();

  if (variant === 'compact') {
    // Cycle through supported locales on click.
    const next: Locale = locale === 'en' ? 'zh' : 'en';
    return (
      <button
        type="button"
        onClick={() => setLocale(next)}
        aria-label={t('sidebar.language.aria')}
        title={t('sidebar.language.label')}
        className={cn(
          'flex justify-center items-center w-10 h-10 font-mono font-medium rounded-md transition-colors text-[11px] text-[hsl(var(--deck-ink-faint))] hover:bg-[hsl(var(--deck-surface))] hover:text-[hsl(var(--deck-ink))]',
          className
        )}
      >
        {t(LABEL_KEYS[locale])}
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('sidebar.language.aria')}
      className={cn(
        'inline-flex h-8 items-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] p-[2px] font-mono text-[11px]',
        className
      )}
    >
      {SUPPORTED_LOCALES.map((option) => {
        const active = option === locale;
        return (
          <button
            key={option}
            type="button"
            onClick={() => setLocale(option)}
            aria-pressed={active}
            className={cn(
              'flex justify-center items-center px-2 h-full transition-colors min-w-[28px] rounded-[4px]',
              active
                ? 'bg-[hsl(var(--deck-ink))] text-[hsl(var(--deck-canvas))]'
                : 'text-[hsl(var(--deck-ink-muted))] hover:text-[hsl(var(--deck-ink))]'
            )}
          >
            {t(LABEL_KEYS[option])}
          </button>
        );
      })}
    </div>
  );
}
