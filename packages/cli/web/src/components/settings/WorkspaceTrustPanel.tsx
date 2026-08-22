import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TranslationKey, useT } from '@/i18n';
import { requestJson } from '@/lib/http';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session';

type WorkspaceTrustState = 'not_required' | 'trusted' | 'untrusted' | 'error';

interface WorkspaceTrustEffect {
  kind: string;
  name: string;
  target?: string;
}

interface WorkspaceTrustSource {
  path: string;
  kind: string;
  keys: string[];
  effects: WorkspaceTrustEffect[];
  warning?: string;
}

interface WorkspaceTrustStatus {
  projectPath: string;
  trustRoot: string;
  state: WorkspaceTrustState;
  sensitiveSources: number;
  sources: WorkspaceTrustSource[];
  decision: string;
  decidedAt?: string;
  inheritedFrom?: string;
  error?: string;
  reloadRequired?: boolean;
}

const STATE_LABEL_KEYS: Record<WorkspaceTrustState, TranslationKey> = {
  not_required: 'settings.trust.state.notRequired',
  trusted: 'settings.trust.state.trusted',
  untrusted: 'settings.trust.state.review',
  error: 'settings.trust.state.error',
};

export function WorkspaceTrustPanel() {
  const t = useT();
  const sessionProjectPath = useSessionStore(
    (state) => state.currentSessionRef?.projectPath
  );
  const projectPath = useMemo(
    () =>
      sessionProjectPath ??
      new URLSearchParams(window.location.search).get('project') ??
      '',
    [sessionProjectPath]
  );
  const [status, setStatus] = useState<WorkspaceTrustStatus | null>(null);
  const [loadedProjectPath, setLoadedProjectPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<'trust' | 'revoke' | null>(null);
  const [pendingAction, setPendingAction] = useState<'trust' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const loadGeneration = useRef(0);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const activeStatus = loadedProjectPath === projectPath ? status : null;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (!projectPath) {
      setStatus(null);
      setLoadedProjectPath('');
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await requestJson<WorkspaceTrustStatus>(
        `/workspace-trust?projectPath=${encodeURIComponent(projectPath)}`
      );
      if (generation !== loadGeneration.current) return;
      setStatus(nextStatus);
      setLoadedProjectPath(projectPath);
    } catch (loadError) {
      if (generation !== loadGeneration.current) return;
      setError(
        loadError instanceof Error ? loadError.message : t('settings.trust.loadFailed')
      );
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [projectPath, t]);

  useEffect(() => {
    setPendingAction(null);
    setRestartRequired(false);
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  const submit = async (nextAction: 'trust' | 'revoke') => {
    if (!activeStatus) return;
    const actionProjectPath = projectPath;
    setAction(nextAction);
    setError(null);
    try {
      const nextStatus = await requestJson<WorkspaceTrustStatus>('/workspace-trust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: actionProjectPath,
          action: nextAction,
        }),
      });
      if (projectPathRef.current === actionProjectPath) {
        setStatus(nextStatus);
        setLoadedProjectPath(actionProjectPath);
        setPendingAction(null);
        setRestartRequired(nextStatus.reloadRequired === true);
      }
    } catch (actionError) {
      if (projectPathRef.current === actionProjectPath) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : t('settings.trust.updateFailed')
        );
      }
    } finally {
      setAction(null);
    }
  };

  if (!projectPath) {
    return (
      <div className="font-mono text-[12px] text-[#6B7280] dark:text-[#a1a1aa]">
        {t('settings.trust.selectSession')}
      </div>
    );
  }

  const trusted = activeStatus?.state === 'trusted';
  const needsReview = activeStatus?.state === 'untrusted';

  return (
    <div className="flex flex-col gap-3 min-h-0 font-mono">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-[#E5E7EB] bg-[#F9FAFB] p-3 dark:border-[#27272a] dark:bg-[#111113]">
        <div className="min-w-0">
          <div className="flex gap-2 items-center">
            {trusted ? (
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
            ) : (
              <AlertTriangle
                className={cn(
                  'h-4 w-4',
                  needsReview ? 'text-amber-600' : 'text-[#71717a]'
                )}
              />
            )}
            <span className="text-[13px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
              {activeStatus
                ? t(STATE_LABEL_KEYS[activeStatus.state])
                : t('settings.trust.heading')}
            </span>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>
          <p className="mt-1 break-all text-[10.5px] text-[#71717a]">{projectPath}</p>
          {activeStatus && (
            <p className="mt-1 break-all text-[10px] text-[#9CA3AF]">
              {activeStatus.decision}
              {activeStatus.inheritedFrom
                ? t('settings.trust.inheritedFrom', {
                    source: activeStatus.inheritedFrom,
                  })
                : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || action !== null}
            aria-label={t('settings.trust.reloadAria')}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[#E5E7EB] px-2 text-[11px] text-[#6B7280] disabled:opacity-50 dark:border-[#3f3f46] dark:text-[#a1a1aa]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('settings.common.reload')}
          </button>
          {trusted ? (
            <button
              type="button"
              onClick={() => setPendingAction('revoke')}
              disabled={action !== null}
              className="h-8 rounded-md border border-red-200 px-2.5 text-[11px] text-red-600 disabled:opacity-50 dark:border-red-900 dark:text-red-400"
            >
              {t('settings.trust.revoke')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPendingAction('trust')}
              disabled={
                action !== null ||
                activeStatus?.state === 'error' ||
                !activeStatus ||
                activeStatus.sensitiveSources === 0
              }
              className="h-8 rounded-md bg-emerald-600 px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {t('settings.trust.trustWorkspace')}
            </button>
          )}
        </div>
      </div>

      {(error || activeStatus?.error) && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {error || activeStatus?.error}
        </div>
      )}

      {restartRequired && (
        <div
          role="status"
          className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300"
        >
          {t('settings.trust.restartNotice')}
        </div>
      )}

      {pendingAction && activeStatus && (
        <div
          role="alertdialog"
          aria-label={
            pendingAction === 'trust'
              ? t('settings.trust.trustWorkspace')
              : t('settings.trust.revokeAria')
          }
          className="flex flex-wrap gap-3 justify-between items-center px-3 py-2 bg-amber-50 rounded-md border border-amber-300 dark:border-amber-900/70 dark:bg-amber-950/30"
        >
          <span className="max-w-[620px] text-[11px] text-amber-900 dark:text-amber-200">
            {pendingAction === 'trust'
              ? t('settings.trust.confirmTrust', {
                  count: activeStatus.sensitiveSources,
                })
              : t('settings.trust.confirmRevoke')}
          </span>
          <div className="flex gap-2 items-center">
            <button
              type="button"
              onClick={() => setPendingAction(null)}
              className="h-7 rounded px-2 text-[11px] text-[#6B7280] dark:text-[#a1a1aa]"
            >
              {t('settings.common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void submit(pendingAction)}
              disabled={action !== null}
              className={cn(
                'h-7 rounded px-2.5 text-[11px] font-semibold text-white disabled:opacity-50',
                pendingAction === 'trust' ? 'bg-emerald-600' : 'bg-red-600'
              )}
            >
              {action
                ? t('settings.trust.saving')
                : pendingAction === 'trust'
                  ? t('settings.trust.trustReviewed')
                  : t('settings.trust.revokeTrust')}
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 overflow-y-auto rounded-md border border-[#E5E7EB] dark:border-[#27272a]">
        {(activeStatus?.sources ?? []).map((source) => (
          <div
            key={`${source.kind}-${source.path}`}
            className="border-b border-[#E5E7EB] px-3 py-2 last:border-b-0 dark:border-[#27272a]"
          >
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-[#111827] dark:text-[#E5E5E5]">
                {source.path}
              </span>
              <span className="rounded bg-[#E5E7EB] px-1.5 py-0.5 text-[9px] uppercase text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]">
                {source.kind}
              </span>
            </div>
            {source.warning && (
              <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                {source.warning}
              </p>
            )}
            <div className="mt-1.5 flex flex-col gap-1">
              {source.effects.map((effect, index) => (
                <div
                  key={`${effect.kind}-${effect.name}-${index}`}
                  className="break-all text-[10.5px] text-[#374151] dark:text-[#d4d4d8]"
                >
                  <span className="text-[#9CA3AF]">{effect.kind}</span>
                  {' · '}
                  {effect.name}
                  {effect.target ? ` → ${effect.target}` : ''}
                </div>
              ))}
            </div>
          </div>
        ))}
        {activeStatus && activeStatus.sources.length === 0 && (
          <div className="px-3 py-8 text-center text-[11px] text-[#9CA3AF]">
            {t('settings.trust.empty')}
          </div>
        )}
      </div>
    </div>
  );
}
