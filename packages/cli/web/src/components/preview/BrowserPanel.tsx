import type {
  BrowserAction,
  BrowserDiagnosticEntry,
  BrowserObservation,
  WebBrowserNavigateRequest,
} from '@api/browserSchemas';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  FileCode,
  FlaskConical,
  Loader2,
  MonitorUp,
  RefreshCw,
} from 'lucide-react';
import { type SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n';
import { appendComposerDraftContext } from '@/lib/composerDraft';
import { focusBladeComposer } from '@/lib/composerFocus';
import { cn } from '@/lib/utils';
import type { SessionRef } from '@/services/sessionService';
import {
  type BrowserInspectKind,
  webBrowserService,
} from '@/services/webBrowserService';
import { useBrowserActivityStore } from '@/store/BrowserActivityStore';
import { useSessionStore } from '@/store/session';
import {
  isHistorySurfaceActive,
  rejectHistorySurfaceAction,
} from '@/store/session/historySurfaceGuard';
import { sessionRefKey } from '@/store/session/sessionIdentity';
import { type BrowserLoadState, BrowserPreview } from './BrowserPreview';
import { BrowserTest, type BrowserTestSource } from './BrowserTest';
import {
  appendPreviewBrowserHistory,
  type BrowserPanelMode,
  DEFAULT_PREVIEW_BROWSER_URL,
  normalizeBrowserPanelUrl,
  normalizePreviewBrowserUrl,
  type PreviewBrowserHistory,
  type PreviewBrowserUrlFailure,
} from './browserPanelModel';

interface BrowserPanelProps {
  sessionRef?: SessionRef | null;
  onElementAdded?: () => void;
}

function isHttpBrowserOrigin(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const COPY = {
  en: {
    modeAria: 'Browser mode',
    preview: 'Preview',
    test: 'Test',
    external: 'External',
    noSession: 'No active Session',
    snapshotRefreshed:
      'The page changed. Snapshot refreshed; select the element again.',
    toolbarAria: 'Browser navigation',
    addressAria: 'Browser address',
    addressPlaceholder: 'Enter an HTTP or HTTPS URL',
    back: 'Go back',
    forward: 'Go forward',
    reload: 'Reload page',
    go: 'Open address',
    openExternal: 'Open in system browser',
    externalEmpty: 'No external page selected',
    status: {
      idle: 'Idle',
      loading: 'Loading…',
      ready: 'Ready',
      error: 'Failed',
    },
    error: {
      empty: 'Enter a URL.',
      invalid: 'Enter a valid URL.',
      protocol: 'Only HTTP and HTTPS URLs are supported.',
      credentials: 'URLs containing credentials are not allowed.',
      same_origin: 'The Blade Web origin cannot be embedded in itself.',
    },
  },
  zh: {
    modeAria: '浏览器模式',
    preview: '预览',
    test: '测试',
    external: '外部',
    noSession: '没有活动 Session',
    snapshotRefreshed: '页面已变化，快照已刷新，请重新选择元素。',
    toolbarAria: '浏览器导航',
    addressAria: '浏览器地址',
    addressPlaceholder: '输入 HTTP 或 HTTPS 地址',
    back: '后退',
    forward: '前进',
    reload: '刷新页面',
    go: '打开地址',
    openExternal: '在系统浏览器中打开',
    externalEmpty: '未选择外部页面',
    status: {
      idle: '空闲',
      loading: '正在加载…',
      ready: '就绪',
      error: '失败',
    },
    error: {
      empty: '请输入地址。',
      invalid: '请输入有效地址。',
      protocol: '仅支持 HTTP 与 HTTPS 地址。',
      credentials: '不允许使用包含凭据的地址。',
      same_origin: '不能在面板中嵌套 Blade Web 自身地址。',
    },
  },
} as const;

export function BrowserPanel({ sessionRef = null, onElementAdded }: BrowserPanelProps) {
  const { locale } = useLocale();
  const copy = COPY[locale];
  const agentActivity = useBrowserActivityStore((state) => state.agentActivity);
  const historyOnly = useSessionStore((state) =>
    isHistorySurfaceActive(state.historySurfaceSelection)
  );
  const agentAvailable =
    sessionRef !== null &&
    agentActivity !== null &&
    agentActivity.sessionRef.sessionId === sessionRef.sessionId &&
    agentActivity.sessionRef.projectPath === sessionRef.projectPath;
  const [mode, setMode] = useState<BrowserPanelMode>('preview');
  const [testSource, setTestSource] = useState<BrowserTestSource>('user');
  const [address, setAddress] = useState(DEFAULT_PREVIEW_BROWSER_URL);
  const [previewHistory, setPreviewHistory] = useState<PreviewBrowserHistory>({
    entries: [],
    index: -1,
  });
  const previewHistoryRef = useRef(previewHistory);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewLoadState, setPreviewLoadState] = useState<BrowserLoadState>('idle');
  const [validationError, setValidationError] =
    useState<PreviewBrowserUrlFailure | null>(null);
  const [testObservation, setTestObservation] = useState<BrowserObservation | null>(
    null
  );
  const [testScreenshotUrl, setTestScreenshotUrl] = useState<string | null>(null);
  const [agentScreenshotUrl, setAgentScreenshotUrl] = useState<string | null>(null);
  const [agentScreenshotLoading, setAgentScreenshotLoading] = useState(false);
  const [agentScreenshotError, setAgentScreenshotError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [elementPickerActive, setElementPickerActive] = useState(false);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<
    Partial<Record<BrowserInspectKind, BrowserDiagnosticEntry[]>>
  >({});
  const [diagnosticsLoading, setDiagnosticsLoading] =
    useState<BrowserInspectKind | null>(null);
  const generation = useRef(0);
  const screenshotUrlRef = useRef<string | null>(null);
  const agentScreenshotUrlRef = useRef<string | null>(null);

  const previewUrl = previewHistory.entries[previewHistory.index] ?? null;
  const currentUrl =
    mode === 'preview'
      ? previewUrl
      : mode === 'test'
        ? testSource === 'agent' && agentAvailable
          ? (agentActivity?.url ?? null)
          : (testObservation?.url ?? null)
        : externalUrl;
  const currentHost = useMemo(() => {
    if (!currentUrl) return '';
    try {
      return new URL(currentUrl).host;
    } catch {
      return '';
    }
  }, [currentUrl]);
  const status: BrowserLoadState =
    mode === 'preview'
      ? previewLoadState
      : mode === 'test'
        ? testSource === 'agent' && agentAvailable
          ? agentScreenshotLoading || agentActivity?.phase === 'running'
            ? 'loading'
            : agentScreenshotError || agentActivity?.phase === 'error'
              ? 'error'
              : agentScreenshotUrl
                ? 'ready'
                : 'idle'
          : testBusy
            ? 'loading'
            : testError
              ? 'error'
              : testObservation
                ? 'ready'
                : 'idle'
        : externalUrl
          ? 'ready'
          : 'idle';
  const errorMessage =
    validationError !== null
      ? copy.error[validationError]
      : mode === 'test'
        ? testSource === 'agent' && agentAvailable
          ? (agentScreenshotError ?? agentActivity?.errorCode ?? null)
          : testError
        : null;

  const replaceScreenshotUrl = (next: string | null) => {
    if (screenshotUrlRef.current) {
      URL.revokeObjectURL(screenshotUrlRef.current);
    }
    screenshotUrlRef.current = next;
    setTestScreenshotUrl(next);
  };

  const replaceAgentScreenshotUrl = (next: string | null) => {
    if (agentScreenshotUrlRef.current) {
      URL.revokeObjectURL(agentScreenshotUrlRef.current);
    }
    agentScreenshotUrlRef.current = next;
    setAgentScreenshotUrl(next);
  };

  useEffect(() => {
    const nextGeneration = generation.current + 1;
    generation.current = nextGeneration;
    setTestObservation(null);
    setTestSource('user');
    setTestError(null);
    setAgentScreenshotError(null);
    setAgentScreenshotLoading(false);
    setElementPickerActive(false);
    setDiagnostics({});
    replaceScreenshotUrl(null);
    replaceAgentScreenshotUrl(null);
    return () => {
      if (generation.current === nextGeneration) {
        generation.current += 1;
      }
    };
  }, [historyOnly, sessionRef?.projectPath, sessionRef?.sessionId]);

  useEffect(
    () => () => {
      if (screenshotUrlRef.current) {
        URL.revokeObjectURL(screenshotUrlRef.current);
      }
      if (agentScreenshotUrlRef.current) {
        URL.revokeObjectURL(agentScreenshotUrlRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (historyOnly || !sessionRef || !agentAvailable || !agentActivity) return;
    setMode('test');
    setTestSource('agent');
    setValidationError(null);
    if (agentActivity.url) setAddress(agentActivity.url);
  }, [agentActivity?.revision, agentAvailable, historyOnly, sessionRef]);

  useEffect(() => {
    if (historyOnly || !sessionRef || !agentAvailable || !agentActivity) return;
    if (
      !agentActivity.pageId ||
      !agentActivity.origin ||
      agentActivity.frameRevision === 0
    ) {
      return;
    }
    if (!isHttpBrowserOrigin(agentActivity.origin)) {
      setAgentScreenshotLoading(false);
      setAgentScreenshotError(null);
      replaceAgentScreenshotUrl(null);
      return;
    }

    const requestGeneration = generation.current;
    const frameRevision = agentActivity.frameRevision;
    const isCurrentRequest = () => {
      const current = useBrowserActivityStore.getState().agentActivity;
      return (
        generation.current === requestGeneration &&
        current?.frameRevision === frameRevision &&
        current.sessionRef.sessionId === sessionRef.sessionId &&
        current.sessionRef.projectPath === sessionRef.projectPath
      );
    };
    setAgentScreenshotLoading(true);
    setAgentScreenshotError(null);
    void webBrowserService
      .screenshot(sessionRef, {
        source: 'agent',
        pageId: agentActivity.pageId,
        expectedOrigin: agentActivity.origin,
      })
      .then((blob) => {
        if (!isCurrentRequest()) return;
        replaceAgentScreenshotUrl(URL.createObjectURL(blob));
      })
      .catch((error) => {
        if (isCurrentRequest()) {
          setAgentScreenshotError(
            error instanceof Error ? error.message : String(error)
          );
        }
      })
      .finally(() => {
        if (isCurrentRequest()) {
          setAgentScreenshotLoading(false);
        }
      });
  }, [
    agentActivity?.frameRevision,
    agentActivity?.origin,
    agentActivity?.pageId,
    agentAvailable,
    historyOnly,
    sessionRef,
  ]);

  const refreshScreenshot = async (
    ref: SessionRef,
    observation: BrowserObservation,
    requestGeneration: number
  ) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    const blob = await webBrowserService.screenshot(ref, {
      pageId: observation.pageId,
      expectedOrigin: observation.origin,
    });
    if (generation.current !== requestGeneration) return;
    replaceScreenshotUrl(URL.createObjectURL(blob));
  };

  const applyTestObservation = async (
    ref: SessionRef,
    observation: BrowserObservation,
    requestGeneration: number
  ) => {
    if (generation.current !== requestGeneration) return;
    setTestObservation(observation);
    setAddress(observation.url);
    setDiagnostics({});
    await refreshScreenshot(ref, observation, requestGeneration);
  };

  const runTestNavigation = async (request: WebBrowserNavigateRequest) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (!sessionRef) {
      setTestError(copy.noSession);
      return;
    }
    const requestGeneration = generation.current;
    setElementPickerActive(false);
    setTestBusy(true);
    setTestError(null);
    try {
      const observation = await webBrowserService.navigate(sessionRef, request);
      await applyTestObservation(sessionRef, observation, requestGeneration);
    } catch (error) {
      if (generation.current === requestGeneration) {
        setTestError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation.current === requestGeneration) setTestBusy(false);
    }
  };

  const navigatePreview = (url: string) => {
    const nextHistory = appendPreviewBrowserHistory(previewHistoryRef.current, url);
    previewHistoryRef.current = nextHistory;
    setPreviewHistory(nextHistory);
    setAddress(url);
    setPreviewLoadState('loading');
  };

  const submitAddress = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    const resolved =
      mode === 'preview'
        ? normalizePreviewBrowserUrl(address)
        : normalizeBrowserPanelUrl(address);
    if (!resolved.ok) {
      setValidationError(resolved.reason);
      return;
    }
    setValidationError(null);
    if (mode === 'preview') {
      if (resolved.url === previewUrl) setPreviewRevision((value) => value + 1);
      navigatePreview(resolved.url);
      return;
    }
    if (mode === 'test') {
      if (testSource === 'agent') return;
      void runTestNavigation({ action: 'goto', url: resolved.url });
      return;
    }
    setExternalUrl(resolved.url);
    setAddress(resolved.url);
    window.open(resolved.url, '_blank', 'noopener,noreferrer');
  };

  const movePreviewHistory = (delta: -1 | 1) => {
    const nextIndex = previewHistoryRef.current.index + delta;
    const nextUrl = previewHistoryRef.current.entries[nextIndex];
    if (!nextUrl) return;
    const nextHistory = { ...previewHistoryRef.current, index: nextIndex };
    previewHistoryRef.current = nextHistory;
    setPreviewHistory(nextHistory);
    setAddress(nextUrl);
    setPreviewLoadState('loading');
  };

  const navigateRelative = (action: 'back' | 'forward' | 'reload') => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (mode === 'preview') {
      if (action === 'back') {
        movePreviewHistory(-1);
      } else if (action === 'forward') {
        movePreviewHistory(1);
      } else if (previewUrl) {
        setPreviewLoadState('loading');
        setPreviewRevision((value) => value + 1);
      }
      return;
    }
    if (mode === 'test' && testSource === 'user' && testObservation) {
      void runTestNavigation({
        action,
        pageId: testObservation.pageId,
        expectedOrigin: testObservation.origin,
      });
    }
  };

  const changeMode = (nextMode: BrowserPanelMode) => {
    setElementPickerActive(false);
    setMode(nextMode);
    setValidationError(null);
    setTestError(null);
    const nextUrl =
      nextMode === 'preview'
        ? previewUrl
        : nextMode === 'test'
          ? testSource === 'agent' && agentAvailable
            ? agentActivity?.url
            : testObservation?.url
          : externalUrl;
    if (nextUrl) setAddress(nextUrl);
  };

  const changeTestSource = (source: BrowserTestSource) => {
    if (source === 'agent' && !agentAvailable) return;
    setTestSource(source);
    setElementPickerActive(false);
    setValidationError(null);
    setTestError(null);
    setAgentScreenshotError(null);
    const nextUrl = source === 'agent' ? agentActivity?.url : testObservation?.url;
    if (nextUrl) setAddress(nextUrl);
  };

  const interact = async (action: BrowserAction, ref?: string) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (!sessionRef || !testObservation) return;
    const activeObservation = testObservation;
    const requestGeneration = generation.current;
    setElementPickerActive(false);
    setTestBusy(true);
    setTestError(null);
    try {
      const result = await webBrowserService.interact(sessionRef, {
        pageId: activeObservation.pageId,
        snapshotId: activeObservation.snapshotId,
        expectedOrigin: activeObservation.origin,
        ...(ref ? { ref } : {}),
        action,
      });
      if (result.outcome === 'applied') {
        await applyTestObservation(sessionRef, result.observation, requestGeneration);
      } else if (result.outcome === 'applied_observation_failed') {
        if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
        const observation = await webBrowserService.snapshot(sessionRef, {
          pageId: result.pageId,
        });
        await applyTestObservation(sessionRef, observation, requestGeneration);
      } else {
        setTestError(result.errorCode);
      }
    } catch (error) {
      if (generation.current === requestGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        if (/snapshot is stale/i.test(message)) {
          try {
            if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
            const observation = await webBrowserService.snapshot(sessionRef, {
              pageId: activeObservation.pageId,
            });
            await applyTestObservation(sessionRef, observation, requestGeneration);
            if (generation.current === requestGeneration) {
              setTestError(copy.snapshotRefreshed);
            }
          } catch (refreshError) {
            if (generation.current === requestGeneration) {
              setTestError(
                refreshError instanceof Error
                  ? refreshError.message
                  : String(refreshError)
              );
            }
          }
        } else {
          setTestError(message);
        }
      }
    } finally {
      if (generation.current === requestGeneration) setTestBusy(false);
    }
  };

  const refreshSnapshot = async (includeBoxes = false): Promise<boolean> => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return false;
    if (!sessionRef || !testObservation) return false;
    const requestGeneration = generation.current;
    setTestBusy(true);
    setTestError(null);
    try {
      const observation = await webBrowserService.snapshot(sessionRef, {
        pageId: testObservation.pageId,
        ...(includeBoxes ? { includeBoxes: true } : {}),
      });
      await applyTestObservation(sessionRef, observation, requestGeneration);
      return generation.current === requestGeneration;
    } catch (error) {
      if (generation.current === requestGeneration) {
        setTestError(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (generation.current === requestGeneration) setTestBusy(false);
    }
  };

  const inspect = async (target: BrowserInspectKind) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (!sessionRef || !testObservation) return;
    const requestGeneration = generation.current;
    setDiagnosticsLoading(target);
    try {
      const result = await webBrowserService.inspect(sessionRef, {
        target,
        pageId: testObservation.pageId,
        expectedOrigin: testObservation.origin,
      });
      if (generation.current === requestGeneration) {
        setDiagnostics((current) => ({
          ...current,
          [target]: result.entries ?? [],
        }));
      }
    } catch (error) {
      if (generation.current === requestGeneration) {
        setTestError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation.current === requestGeneration) setDiagnosticsLoading(null);
    }
  };

  const changeElementPicker = async (active: boolean) => {
    if (!active) {
      setElementPickerActive(false);
      return;
    }
    if (testSource === 'agent') return;
    const refreshed = await refreshSnapshot(true);
    if (refreshed) setElementPickerActive(true);
  };

  const addElementToConversation = (context: string) => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    const draftKey = sessionRef
      ? `session:${sessionRefKey(sessionRef)}`
      : 'session:temporary';
    if (!appendComposerDraftContext(draftKey, context)) return;
    setElementPickerActive(false);
    onElementAdded?.();
    requestAnimationFrame(() => focusBladeComposer());
  };

  const resetTestBrowser = async () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    if (!sessionRef) return;
    const requestGeneration = generation.current;
    setElementPickerActive(false);
    setTestBusy(true);
    setTestError(null);
    try {
      await webBrowserService.reset(sessionRef);
      if (generation.current === requestGeneration) {
        setTestObservation(null);
        setDiagnostics({});
        replaceScreenshotUrl(null);
      }
    } catch (error) {
      if (generation.current === requestGeneration) {
        setTestError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation.current === requestGeneration) setTestBusy(false);
    }
  };

  const openExternal = () => {
    if (rejectHistorySurfaceAction(useSessionStore.getState())) return;
    const candidate = currentUrl ?? address;
    const resolved = normalizeBrowserPanelUrl(candidate);
    if (!resolved.ok) {
      setValidationError(resolved.reason);
      return;
    }
    setExternalUrl(resolved.url);
    window.open(resolved.url, '_blank', 'noopener,noreferrer');
  };

  const canGoBack =
    mode === 'preview'
      ? previewHistory.index > 0
      : mode === 'test' && testSource === 'user' && Boolean(testObservation);
  const canGoForward =
    mode === 'preview'
      ? previewHistory.index >= 0 &&
        previewHistory.index < previewHistory.entries.length - 1
      : mode === 'test' && testSource === 'user' && Boolean(testObservation);
  const testReadOnly = mode === 'test' && testSource === 'agent';
  const visibleTestBusy =
    testSource === 'agent'
      ? agentScreenshotLoading || agentActivity?.phase === 'running'
      : testBusy;

  if (historyOnly) return null;

  return (
    <section
      data-browser-panel
      data-browser-mode={mode}
      data-browser-test-source={testSource}
      data-browser-history-count={previewHistory.entries.length}
      data-browser-history-index={previewHistory.index}
      className="flex h-full min-h-0 flex-col bg-[hsl(var(--deck-canvas))]"
    >
      <div
        role="tablist"
        aria-label={copy.modeAria}
        className="grid h-9 shrink-0 grid-cols-3 border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))]"
      >
        {(
          [
            ['preview', copy.preview, FileCode],
            ['test', copy.test, FlaskConical],
            ['external', copy.external, MonitorUp],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => changeMode(value)}
            className={cn(
              'flex min-w-0 items-center justify-center gap-1.5 border-r border-[hsl(var(--deck-border))] px-2 font-mono text-[11px] text-[hsl(var(--deck-ink-muted))] last:border-r-0',
              mode === value &&
                'bg-[hsl(var(--deck-canvas-veil))] text-[hsl(var(--deck-ink))]'
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      <form
        aria-label={copy.toolbarAria}
        onSubmit={submitAddress}
        className="flex h-12 shrink-0 items-center gap-1 border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-2"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!canGoBack || (mode === 'test' && visibleTestBusy)}
          aria-label={copy.back}
          title={copy.back}
          onClick={() => navigateRelative('back')}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!canGoForward || (mode === 'test' && visibleTestBusy)}
          aria-label={copy.forward}
          title={copy.forward}
          onClick={() => navigateRelative('forward')}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={
            mode === 'external' ||
            testReadOnly ||
            !currentUrl ||
            (mode === 'test' && visibleTestBusy)
          }
          aria-label={copy.reload}
          title={copy.reload}
          onClick={() => navigateRelative('reload')}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <RefreshCw
            className={cn('h-4 w-4', status === 'loading' && 'animate-spin')}
          />
        </Button>
        <div
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-[hsl(var(--deck-canvas))] px-2',
            errorMessage
              ? 'border-red-500/70'
              : 'border-[hsl(var(--deck-border))] focus-within:border-[hsl(var(--deck-accent)/0.65)]'
          )}
        >
          <FileCode className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
          <input
            data-browser-panel-address
            data-preview-browser-address={mode === 'preview' || undefined}
            value={address}
            readOnly={testReadOnly}
            onChange={(event) => {
              setAddress(event.target.value);
              setValidationError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && currentUrl) {
                event.preventDefault();
                setAddress(currentUrl);
                setValidationError(null);
              }
            }}
            aria-label={copy.addressAria}
            placeholder={copy.addressPlaceholder}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[hsl(var(--deck-ink))] outline-none placeholder:text-[hsl(var(--deck-ink-faint))]"
          />
        </div>
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          aria-label={copy.go}
          title={copy.go}
          disabled={testReadOnly || (mode === 'test' && visibleTestBusy)}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-accent))]"
        >
          {status === 'loading' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUpRight className="h-4 w-4" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!currentUrl}
          aria-label={copy.openExternal}
          title={copy.openExternal}
          onClick={openExternal}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </form>

      {errorMessage && mode !== 'test' && (
        <div
          role="alert"
          className="shrink-0 border-b border-red-500/25 bg-red-500/10 px-3 py-2 font-mono text-[10.5px] text-red-700 dark:text-red-300"
        >
          {errorMessage}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === 'preview' ? (
          <BrowserPreview
            url={previewUrl}
            revision={previewRevision}
            loadState={previewLoadState}
            onLoad={() => setPreviewLoadState('ready')}
            onError={() => setPreviewLoadState('error')}
          />
        ) : mode === 'test' ? (
          <BrowserTest
            source={testSource}
            agentAvailable={agentAvailable}
            sessionAvailable={Boolean(sessionRef)}
            observation={testSource === 'agent' ? null : testObservation}
            screenshotUrl={
              testSource === 'agent' ? agentScreenshotUrl : testScreenshotUrl
            }
            interaction={
              testSource === 'agent' ? agentActivity?.interaction : undefined
            }
            pointerRevision={
              testSource === 'agent' ? (agentActivity?.pointerRevision ?? 0) : 0
            }
            busy={visibleTestBusy}
            error={errorMessage}
            diagnostics={testSource === 'agent' ? {} : diagnostics}
            diagnosticsLoading={testSource === 'agent' ? null : diagnosticsLoading}
            onInteract={interact}
            onInspect={inspect}
            onSnapshot={async () => {
              await refreshSnapshot();
            }}
            onReset={resetTestBrowser}
            onSourceChange={changeTestSource}
            pickerActive={elementPickerActive}
            onPickerChange={changeElementPicker}
            onAddToConversation={addElementToConversation}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-[hsl(var(--deck-canvas-veil))]">
            <MonitorUp className="h-7 w-7 text-[hsl(var(--deck-ink-faint))]" />
            <span className="font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]">
              {externalUrl ? new URL(externalUrl).host : copy.externalEmpty}
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={openExternal}
              disabled={!address.trim()}
              className="h-8 rounded-md font-mono text-[11px]"
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              {copy.openExternal}
            </Button>
          </div>
        )}
      </div>

      <div
        data-browser-panel-status={status}
        data-preview-browser-status={mode === 'preview' ? status : undefined}
        aria-live="polite"
        className="flex h-7 shrink-0 items-center justify-between border-t border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--deck-ink-faint))]',
              status === 'loading' && 'bg-amber-500',
              status === 'ready' && 'bg-emerald-500',
              status === 'error' && 'bg-red-500'
            )}
          />
          <span>{copy.status[status]}</span>
        </span>
        <span className="ml-3 truncate">{currentHost || copy[mode]}</span>
      </div>
    </section>
  );
}
