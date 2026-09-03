import { useT } from '@/i18n';
import type { HistorySurfaceError, SessionSurfaceSelection } from '@/store/session';

interface SessionHistoryBannerProps {
  selection: SessionSurfaceSelection;
  loadState: 'idle' | 'loading' | 'loading-older' | 'forking' | 'ready' | 'error';
  error: HistorySurfaceError | null;
  recoveryCode:
    | 'session_surface_cursor_invalid'
    | 'session_surface_snapshot_changed'
    | null;
  truncated: boolean;
}

export function SessionHistoryBanner({
  selection,
  loadState,
  error,
  recoveryCode,
  truncated,
}: SessionHistoryBannerProps) {
  const t = useT();
  const connection = t(
    selection.capabilities.connection === 'local'
      ? 'history.connection.local'
      : selection.capabilities.connection === 'offline'
        ? 'history.connection.offline'
        : 'history.connection.online'
  );
  const recovery =
    recoveryCode === 'session_surface_cursor_invalid'
      ? t('history.recovery.cursor')
      : recoveryCode === 'session_surface_snapshot_changed'
        ? t('history.recovery.snapshot')
        : null;
  const errorMessage = error
    ? error.code === 'session_surface_unavailable'
      ? t('history.error.unavailable')
      : error.code === 'session_surface_state_invalid'
        ? t('history.error.invalid')
        : t('history.error.generic')
    : null;

  return (
    <section
      className="rounded-xl border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas-veil))] p-4"
      aria-label={t('history.banner.aria')}
    >
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
        <span className="rounded-full border border-[hsl(var(--deck-border))] px-2 py-1">
          {t('history.badge.remote')}
        </span>
        <span className="rounded-full border border-[hsl(var(--deck-border))] px-2 py-1">
          {connection}
        </span>
        <span className="rounded-full border border-[hsl(var(--deck-accent))] bg-[hsl(var(--deck-accent-soft))] px-2 py-1 text-[hsl(var(--deck-accent))]">
          {t('history.badge.historyOnly')}
        </span>
      </div>

      <div className="mt-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[hsl(var(--deck-ink-faint))]">
          {t('history.location.label')}
        </div>
        <div className="mt-1 break-all font-mono text-[12px] text-[hsl(var(--deck-ink))]">
          {selection.displayCwd}
        </div>
      </div>

      <div className="mt-4 grid gap-2 text-[12px] text-[hsl(var(--deck-ink-muted))]">
        <div>{t('history.unavailable.prompt')}</div>
        <div>{t('history.unavailable.files')}</div>
        <div>{t('history.unavailable.terminal')}</div>
      </div>

      {loadState === 'loading' && (
        <div className="mt-4 rounded-lg bg-[hsl(var(--deck-surface))] px-3 py-2 text-[12px] text-[hsl(var(--deck-ink-muted))]">
          {t('history.loading')}
        </div>
      )}

      {recovery && (
        <div className="mt-4 rounded-lg bg-[hsl(var(--deck-accent-soft))] px-3 py-2 text-[12px] text-[hsl(var(--deck-accent))]">
          {recovery}
        </div>
      )}

      {truncated && (
        <div className="mt-4 rounded-lg bg-[hsl(var(--deck-surface))] px-3 py-2 text-[12px] text-[hsl(var(--deck-ink-muted))]">
          {t('history.bounded')}
        </div>
      )}

      {error && (
        <div
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700"
          role="alert"
        >
          {errorMessage}
        </div>
      )}
    </section>
  );
}
