import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  FileCode,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n';
import { cn } from '@/lib/utils';

export const DEFAULT_PREVIEW_BROWSER_URL = 'http://localhost:3000';
export const MAX_PREVIEW_BROWSER_HISTORY = 50;
const MAX_PREVIEW_BROWSER_URL_LENGTH = 2_048;

export type PreviewBrowserUrlFailure =
  | 'empty'
  | 'invalid'
  | 'protocol'
  | 'credentials'
  | 'same_origin';

export type PreviewBrowserUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: PreviewBrowserUrlFailure };

export interface PreviewBrowserHistory {
  entries: string[];
  index: number;
}

const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?$/i;
const BARE_HOST_WITH_PORT_PATTERN = /^[a-z\d.-]+:\d+$/i;
const BROWSER_COPY = {
  en: {
    toolbarAria: 'Browser navigation',
    addressAria: 'Browser address',
    addressPlaceholder: 'Enter an HTTP or HTTPS URL',
    back: 'Go back',
    forward: 'Go forward',
    reload: 'Reload page',
    go: 'Open address',
    openExternal: 'Open in system browser',
    frameTitle: 'Browser preview',
    emptyTitle: 'No page open',
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
    toolbarAria: '浏览器导航',
    addressAria: '浏览器地址',
    addressPlaceholder: '输入 HTTP 或 HTTPS 地址',
    back: '后退',
    forward: '前进',
    reload: '刷新页面',
    go: '打开地址',
    openExternal: '在系统浏览器中打开',
    frameTitle: '浏览器预览',
    emptyTitle: '未打开页面',
    status: {
      idle: '空闲',
      loading: '正在加载…',
      ready: '就绪',
      error: '加载失败',
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

function browserOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
}

export function normalizePreviewBrowserUrl(
  input: string,
  currentOrigin = browserOrigin()
): PreviewBrowserUrlResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_PREVIEW_BROWSER_URL_LENGTH) {
    return { ok: false, reason: 'invalid' };
  }

  let candidate = trimmed;
  const authority = candidate.split(/[/?#]/, 1)[0] ?? '';
  if (
    LOCAL_ADDRESS_PATTERN.test(authority) ||
    BARE_HOST_WITH_PORT_PATTERN.test(authority)
  ) {
    candidate = `http://${candidate}`;
  } else if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'protocol' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials' };
  }
  if (currentOrigin && parsed.origin === currentOrigin) {
    return { ok: false, reason: 'same_origin' };
  }
  return { ok: true, url: parsed.href };
}

export function appendPreviewBrowserHistory(
  state: PreviewBrowserHistory,
  url: string
): PreviewBrowserHistory {
  if (state.entries[state.index] === url) return state;
  const entries = [...state.entries.slice(0, state.index + 1), url].slice(
    -MAX_PREVIEW_BROWSER_HISTORY
  );
  return { entries, index: entries.length - 1 };
}

type BrowserLoadState = 'idle' | 'loading' | 'ready' | 'error';

export function BrowserPreview() {
  const { locale } = useLocale();
  const copy = BROWSER_COPY[locale];
  const [address, setAddress] = useState(DEFAULT_PREVIEW_BROWSER_URL);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [loadState, setLoadState] = useState<BrowserLoadState>('idle');
  const [validationError, setValidationError] =
    useState<PreviewBrowserUrlFailure | null>(null);
  const currentUrl = history[historyIndex] ?? null;
  const currentHost = useMemo(() => {
    if (!currentUrl) return '';
    try {
      return new URL(currentUrl).host;
    } catch {
      return '';
    }
  }, [currentUrl]);

  const load = (url: string) => {
    setAddress(url);
    setValidationError(null);
    setLoadState('loading');
  };

  const navigate = (rawUrl: string) => {
    const resolved = normalizePreviewBrowserUrl(rawUrl);
    if (!resolved.ok) {
      setValidationError(resolved.reason);
      return;
    }

    if (resolved.url === currentUrl) {
      load(resolved.url);
      setReloadRevision((value) => value + 1);
      return;
    }

    const nextHistory = appendPreviewBrowserHistory(
      { entries: history, index: historyIndex },
      resolved.url
    );
    setHistory(nextHistory.entries);
    setHistoryIndex(nextHistory.index);
    load(resolved.url);
  };

  const moveHistory = (nextIndex: number) => {
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    load(nextUrl);
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate(address);
  };

  const validationMessage = validationError ? copy.error[validationError] : null;

  return (
    <section
      data-preview-browser
      className="flex h-full min-h-0 flex-col bg-[hsl(var(--deck-canvas))]"
    >
      <form
        aria-label={copy.toolbarAria}
        onSubmit={submitAddress}
        className="flex h-12 shrink-0 items-center gap-1 border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-2"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={historyIndex <= 0}
          aria-label={copy.back}
          title={copy.back}
          onClick={() => moveHistory(historyIndex - 1)}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={historyIndex < 0 || historyIndex >= history.length - 1}
          aria-label={copy.forward}
          title={copy.forward}
          onClick={() => moveHistory(historyIndex + 1)}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!currentUrl}
          aria-label={copy.reload}
          title={copy.reload}
          onClick={() => {
            if (!currentUrl) return;
            load(currentUrl);
            setReloadRevision((value) => value + 1);
          }}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <RefreshCw
            className={cn('h-4 w-4', loadState === 'loading' && 'animate-spin')}
          />
        </Button>
        <div
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-[hsl(var(--deck-canvas))] px-2',
            validationError
              ? 'border-red-500/70'
              : 'border-[hsl(var(--deck-border))] focus-within:border-[hsl(var(--deck-accent)/0.65)]'
          )}
        >
          <FileCode className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--deck-ink-faint))]" />
          <input
            data-preview-browser-address
            value={address}
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
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-accent))]"
        >
          <ArrowUpRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!currentUrl}
          aria-label={copy.openExternal}
          title={copy.openExternal}
          onClick={() => {
            if (currentUrl) {
              window.open(currentUrl, '_blank', 'noopener,noreferrer');
            }
          }}
          className="h-8 w-8 rounded-md text-[hsl(var(--deck-ink-muted))]"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </form>

      {validationMessage && (
        <div
          role="alert"
          className="shrink-0 border-b border-red-500/25 bg-red-500/10 px-3 py-2 font-mono text-[10.5px] text-red-700 dark:text-red-300"
        >
          {validationMessage}
        </div>
      )}

      <div
        aria-busy={loadState === 'loading'}
        className="relative min-h-0 flex-1 overflow-hidden bg-white"
      >
        {currentUrl ? (
          <>
            <iframe
              key={`${currentUrl}:${reloadRevision}`}
              data-preview-browser-frame
              src={currentUrl}
              title={copy.frameTitle}
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              referrerPolicy="no-referrer"
              onLoad={() => setLoadState('ready')}
              onError={() => setLoadState('error')}
              className="block h-full w-full border-0 bg-white"
            />
            {loadState === 'loading' && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex h-8 items-center justify-center border-b border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-canvas)/0.92)] backdrop-blur-sm">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin text-[hsl(var(--deck-accent))]" />
                <span className="font-mono text-[10.5px] text-[hsl(var(--deck-ink-muted))]">
                  {copy.status.loading}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-[hsl(var(--deck-canvas-veil))] text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface))] text-[hsl(var(--deck-ink-faint))]">
              <FileCode className="h-5 w-5" />
            </div>
            <span className="font-mono text-[11px] text-[hsl(var(--deck-ink-muted))]">
              {copy.emptyTitle}
            </span>
          </div>
        )}
      </div>

      <div
        data-preview-browser-status={loadState}
        aria-live="polite"
        className="flex h-7 shrink-0 items-center justify-between border-t border-[hsl(var(--deck-border))] bg-[hsl(var(--deck-surface-2))] px-3 font-mono text-[10px] text-[hsl(var(--deck-ink-faint))]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--deck-ink-faint))]',
              loadState === 'loading' && 'bg-amber-500',
              loadState === 'ready' && 'bg-emerald-500',
              loadState === 'error' && 'bg-red-500'
            )}
          />
          <span>{copy.status[loadState]}</span>
        </span>
        {currentHost && <span className="ml-3 truncate">{currentHost}</span>}
      </div>
    </section>
  );
}
