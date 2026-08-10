import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TranslationKey, useT } from '@/i18n';
import { requestJson } from '@/lib/http';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session';

type HookTrustState =
  | 'disabled'
  | 'not_required'
  | 'untrusted'
  | 'trusted'
  | 'modified'
  | 'error';

interface HookTrustDefinition {
  event: string;
  matcher?: string;
  name?: string;
  type: string;
  target: string;
  pluginName?: string;
  pluginSource?: 'cli' | 'project' | 'user';
}

interface HookTrustStatus {
  projectPath: string;
  trustRoot: string;
  state: HookTrustState;
  enabled: boolean;
  configuredHooks: number;
  currentDigest: string | null;
  trustedDigest?: string;
  trustedAt?: string;
  error?: string;
  definitions: HookTrustDefinition[];
}

interface HookSessionStatus {
  sessionId: string;
  projectPath: string;
  enabled: boolean;
  paused: boolean;
  configEnabled: boolean;
}

const STATE_LABEL_KEYS: Record<HookTrustState, TranslationKey> = {
  disabled: 'settings.hooks.state.disabled',
  not_required: 'settings.hooks.state.notRequired',
  untrusted: 'settings.hooks.state.review',
  trusted: 'settings.hooks.state.trusted',
  modified: 'settings.hooks.state.modified',
  error: 'settings.hooks.state.error',
};

export function HookTrustPanel() {
  const t = useT();
  const sessionRef = useSessionStore((state) => state.currentSessionRef);
  const sessionProjectPath = sessionRef?.projectPath;
  const sessionId = sessionRef?.sessionId;
  const projectPath = useMemo(
    () =>
      sessionProjectPath ??
      new URLSearchParams(window.location.search).get('project') ??
      '',
    [sessionProjectPath]
  );
  const [status, setStatus] = useState<HookTrustStatus | null>(null);
  const [sessionStatus, setSessionStatus] = useState<HookSessionStatus | null>(null);
  const [loadedProjectPath, setLoadedProjectPath] = useState('');
  const [loadedSessionKey, setLoadedSessionKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<'trust' | 'revoke' | 'session' | null>(null);
  const [pendingAction, setPendingAction] = useState<'trust' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const sessionKey = sessionId ? `${projectPath}\0${sessionId}` : '';
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const activeStatus = loadedProjectPath === projectPath ? status : null;
  const activeSessionStatus = loadedSessionKey === sessionKey ? sessionStatus : null;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (!projectPath) {
      setStatus(null);
      setSessionStatus(null);
      setLoadedProjectPath('');
      setLoadedSessionKey('');
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await requestJson<HookTrustStatus>(
        `/hooks/trust?projectPath=${encodeURIComponent(projectPath)}`
      );
      if (generation !== loadGeneration.current) return;
      const nextSessionStatus = sessionId
        ? await requestJson<HookSessionStatus>(
            `/hooks/session?projectPath=${encodeURIComponent(
              projectPath
            )}&sessionId=${encodeURIComponent(sessionId)}`
          )
        : null;
      if (generation !== loadGeneration.current) return;
      setStatus(nextStatus);
      setSessionStatus(nextSessionStatus);
      setLoadedProjectPath(projectPath);
      setLoadedSessionKey(nextSessionStatus ? sessionKey : '');
    } catch (loadError) {
      if (generation !== loadGeneration.current) return;
      setError(
        loadError instanceof Error ? loadError.message : t('settings.hooks.loadFailed')
      );
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [projectPath, sessionId, sessionKey, t]);

  useEffect(() => {
    setPendingAction(null);
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
      const nextStatus = await requestJson<HookTrustStatus>('/hooks/trust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          action: nextAction,
          ...(nextAction === 'trust' && activeStatus.currentDigest
            ? { expectedDigest: activeStatus.currentDigest }
            : {}),
        }),
      });
      if (projectPathRef.current === actionProjectPath) {
        setStatus(nextStatus);
        setLoadedProjectPath(actionProjectPath);
        setPendingAction(null);
      }
    } catch (actionError) {
      if (projectPathRef.current === actionProjectPath) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : t('settings.hooks.updateFailed')
        );
      }
    } finally {
      setAction(null);
    }
  };

  const setSessionEnabled = async (enabled: boolean) => {
    if (!sessionId || !activeSessionStatus) return;
    const actionSessionKey = sessionKey;
    setAction('session');
    setError(null);
    try {
      const nextStatus = await requestJson<HookSessionStatus>('/hooks/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          sessionId,
          enabled,
        }),
      });
      if (sessionKeyRef.current === actionSessionKey) {
        setSessionStatus(nextStatus);
        setLoadedSessionKey(actionSessionKey);
      }
    } catch (actionError) {
      if (sessionKeyRef.current === actionSessionKey) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : t('settings.hooks.sessionUpdateFailed')
        );
      }
    } finally {
      setAction(null);
    }
  };

  if (!projectPath) {
    return (
      <div className="font-mono text-[12px] text-[#6B7280] dark:text-[#a1a1aa]">
        {t('settings.hooks.selectSession')}
      </div>
    );
  }

  const trusted = activeStatus?.state === 'trusted';
  const needsReview =
    activeStatus?.state === 'untrusted' || activeStatus?.state === 'modified';
  const sessionPolicyUnavailable =
    activeSessionStatus !== null &&
    !activeSessionStatus.enabled &&
    !activeSessionStatus.paused;
  return (
    <div className="flex min-h-0 flex-col gap-3 font-mono">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-[#E5E7EB] bg-[#F9FAFB] p-3 dark:border-[#27272a] dark:bg-[#111113]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {trusted ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
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
                : t('settings.hooks.heading')}
            </span>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </div>
          <p className="mt-1 break-all text-[10.5px] text-[#71717a]">{projectPath}</p>
          {activeStatus?.currentDigest && (
            <p className="mt-1 text-[10px] text-[#9CA3AF]">
              {activeStatus.currentDigest}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || action !== null}
            aria-label={t('settings.hooks.reloadAria')}
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
              {t('settings.hooks.revoke')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setPendingAction('trust')}
              disabled={
                action !== null ||
                !activeStatus?.currentDigest ||
                activeStatus.state === 'error'
              }
              className="h-8 rounded-md bg-emerald-600 px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {t('settings.hooks.trustDigest')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#E5E7EB] px-3 py-2 dark:border-[#27272a]">
        <div>
          <div className="text-[11px] font-semibold text-[#111827] dark:text-[#E5E5E5]">
            {t('settings.hooks.currentSession')}
          </div>
          <div className="mt-0.5 text-[9.5px] text-[#9CA3AF]">
            {!sessionId
              ? t('settings.hooks.session.open')
              : !activeSessionStatus
                ? t('settings.hooks.session.loading')
                : activeSessionStatus.paused
                  ? t('settings.hooks.session.paused')
                  : activeSessionStatus.enabled
                    ? t('settings.hooks.session.active')
                    : !activeSessionStatus.configEnabled
                      ? t('settings.hooks.session.disabled')
                      : t('settings.hooks.session.unavailable')}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-label={
            activeSessionStatus?.paused
              ? t('settings.hooks.session.enableAria')
              : activeSessionStatus?.enabled
                ? t('settings.hooks.session.pauseAria')
                : t('settings.hooks.session.unavailableAria')
          }
          aria-checked={activeSessionStatus?.enabled ?? false}
          disabled={!activeSessionStatus || action !== null || sessionPolicyUnavailable}
          onClick={() => void setSessionEnabled(activeSessionStatus?.paused === true)}
          className={cn(
            'flex h-6 w-11 items-center rounded-full px-1 transition-colors disabled:opacity-40',
            activeSessionStatus?.enabled
              ? 'bg-emerald-500'
              : 'bg-[#E5E7EB] dark:bg-[#27272a]'
          )}
        >
          <span
            className={cn(
              'h-4 w-4 rounded-full bg-white transition-transform',
              activeSessionStatus?.enabled ? 'translate-x-5' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {pendingAction && activeStatus && (
        <div
          role="alertdialog"
          aria-label={
            pendingAction === 'trust'
              ? t('settings.hooks.confirmTrustAria')
              : t('settings.hooks.confirmRevokeAria')
          }
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/70 dark:bg-amber-950/30"
        >
          <span className="max-w-[620px] text-[11px] text-amber-900 dark:text-amber-200">
            {pendingAction === 'trust'
              ? t('settings.hooks.confirmTrust', {
                  count: activeStatus.configuredHooks,
                })
              : t('settings.hooks.confirmRevoke')}
          </span>
          <div className="flex items-center gap-2">
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
                ? t('settings.hooks.saving')
                : pendingAction === 'trust'
                  ? t('settings.hooks.trustReviewed')
                  : t('settings.hooks.revokeTrust')}
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 overflow-y-auto rounded-md border border-[#E5E7EB] dark:border-[#27272a]">
        {(activeStatus?.definitions ?? []).map((definition, index) => (
          <div
            key={`${definition.event}-${definition.type}-${index}`}
            className="border-b border-[#E5E7EB] px-3 py-2 last:border-b-0 dark:border-[#27272a]"
          >
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-semibold text-[#111827] dark:text-[#E5E5E5]">
                {definition.event}
              </span>
              <span className="rounded bg-[#E5E7EB] px-1.5 py-0.5 text-[9px] uppercase text-[#6B7280] dark:bg-[#27272a] dark:text-[#a1a1aa]">
                {definition.type}
              </span>
              {definition.name && (
                <span className="text-[#71717a]">{definition.name}</span>
              )}
              {definition.pluginName && (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[9px] text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                  {definition.pluginName} · {definition.pluginSource}
                </span>
              )}
            </div>
            {definition.matcher && (
              <div className="mt-1 break-all text-[9.5px] text-[#9CA3AF]">
                {definition.matcher}
              </div>
            )}
            <pre className="mt-1.5 whitespace-pre-wrap break-all text-[10.5px] text-[#374151] dark:text-[#d4d4d8]">
              {definition.target}
            </pre>
          </div>
        ))}
        {activeStatus && activeStatus.definitions.length === 0 && (
          <div className="px-3 py-8 text-center text-[11px] text-[#9CA3AF]">
            {t('settings.hooks.empty')}
          </div>
        )}
      </div>
    </div>
  );
}
