export const DEFAULT_PREVIEW_BROWSER_URL = 'http://localhost:3000';
export const MAX_PREVIEW_BROWSER_HISTORY = 50;
const MAX_PREVIEW_BROWSER_URL_LENGTH = 2_048;

export type BrowserPanelMode = 'preview' | 'test' | 'external';
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

function browserOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
}

export function normalizeBrowserPanelUrl(
  input: string,
  currentOrigin = browserOrigin(),
  rejectSameOrigin = false
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
  if (rejectSameOrigin && currentOrigin && parsed.origin === currentOrigin) {
    return { ok: false, reason: 'same_origin' };
  }
  return { ok: true, url: parsed.href };
}

export function normalizePreviewBrowserUrl(
  input: string,
  currentOrigin = browserOrigin()
): PreviewBrowserUrlResult {
  return normalizeBrowserPanelUrl(input, currentOrigin, true);
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
