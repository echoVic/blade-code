import { isIP } from 'node:net';
import {
  MAX_BROWSER_FINGERPRINT_BYTES,
  MAX_BROWSER_ORIGIN_BYTES,
  MAX_BROWSER_PROJECTED_URL_BYTES,
  MAX_BROWSER_URL_BYTES,
} from './constants.js';
import { type BrowserOriginClass, BrowserRuntimeError } from './types.js';

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
};

const CREDENTIAL_CONTROL_PATTERN =
  /password|passwd|passcode|one[-_ ]?time|otp|api[-_ ]?key|secret|token|credential|cvv|cvc/i;

const CREDENTIAL_AUTOCOMPLETE_TOKENS = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
]);

export interface NormalizedBrowserUrl {
  url: URL;
  href: string;
  origin: string;
  classification: BrowserOriginClass;
}

export interface BrowserControlIdentity {
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  ariaLabel?: string | null;
  accessibleName?: string | null;
  accessibleNameExceededLimit?: boolean;
  referencedAccessibleNameUnavailable?: boolean;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function assertBrowserStringBound(
  value: string,
  maximumBytes: number,
  label: string,
  options: { allowEmpty?: boolean } = {}
): void {
  if ((!options.allowEmpty && value.length === 0) || byteLength(value) > maximumBytes) {
    throw new BrowserRuntimeError(
      'browser_unsupported',
      `${label} is empty or exceeds the supported size`
    );
  }
}

export function sliceUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let result = bytes.subarray(0, maximumBytes).toString('utf8');
  while (Buffer.byteLength(result) > maximumBytes) {
    result = result.slice(0, -1);
  }
  return result.replace(/\uFFFD$/, '');
}

export function sanitizeBrowserText(value: string, maximumBytes: number): string {
  const safe = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code === 9 || code === 10 || code === 13 || code >= 32) && code !== 127;
    })
    .join('');
  return sliceUtf8(safe, maximumBytes);
}

function canonicalHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.includes(':') && !lower.startsWith('[') ? `[${lower}]` : lower;
}

export function canonicalBrowserOrigin(url: URL): string {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'null';
  const port = url.port || DEFAULT_PORTS[url.protocol];
  const origin = `${url.protocol}//${canonicalHostname(url.hostname)}:${port}`;
  if (byteLength(origin) > MAX_BROWSER_ORIGIN_BYTES) {
    throw new BrowserRuntimeError(
      'browser_unsupported',
      'Browser origin exceeds the supported size'
    );
  }
  return origin;
}

function parseIpv4(hostname: string): number[] | undefined {
  if (isIP(hostname) !== 4) return undefined;
  return hostname.split('.').map(Number);
}

function isPrivateIpv4(parts: readonly number[]): boolean {
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function normalizedIpv6(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function classifyBrowserHostname(hostname: string): BrowserOriginClass {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return 'loopback';
  }

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    if (ipv4[0] === 127) return 'loopback';
    return isPrivateIpv4(ipv4) ? 'private-network' : 'public';
  }

  const ipv6 = normalizedIpv6(normalized);
  if (isIP(ipv6) === 6) {
    if (ipv6 === '::1') return 'loopback';
    if (ipv6.startsWith('fc') || ipv6.startsWith('fd') || /^fe[89ab]/.test(ipv6)) {
      return 'private-network';
    }
    if (ipv6.startsWith('::ffff:')) {
      const mapped = parseIpv4(ipv6.slice('::ffff:'.length));
      if (mapped) {
        if (mapped[0] === 127) return 'loopback';
        return isPrivateIpv4(mapped) ? 'private-network' : 'public';
      }
    }
  }

  return 'public';
}

export function normalizeBrowserUrl(value: string): NormalizedBrowserUrl {
  assertBrowserStringBound(value, MAX_BROWSER_URL_BYTES, 'Browser URL');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserRuntimeError('browser_unsupported', 'Browser URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserRuntimeError(
      'browser_unsupported',
      'Browser navigation only supports HTTP(S) URLs'
    );
  }
  if (url.username || url.password) {
    throw new BrowserRuntimeError(
      'browser_unsupported',
      'Browser URLs cannot contain credentials'
    );
  }

  url.hash = '';
  return {
    url,
    href: url.href,
    origin: canonicalBrowserOrigin(url),
    classification: classifyBrowserHostname(url.hostname),
  };
}

export function normalizeExpectedBrowserOrigin(value: string): string {
  assertBrowserStringBound(value, MAX_BROWSER_ORIGIN_BYTES, 'Browser origin');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserRuntimeError('browser_unsupported', 'Browser origin is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new BrowserRuntimeError('browser_unsupported', 'Browser origin is invalid');
  }
  const canonical = canonicalBrowserOrigin(url);
  if (canonical !== value.toLowerCase()) {
    throw new BrowserRuntimeError(
      'browser_unsupported',
      `Browser origin must use canonical form: ${canonical}`
    );
  }
  return canonical;
}

export function projectBrowserUrl(value: string): string {
  if (value === 'about:blank') return value;
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of new Set(url.searchParams.keys())) {
      const count = url.searchParams.getAll(key).length;
      url.searchParams.delete(key);
      for (let index = 0; index < count; index++) {
        url.searchParams.append(key, '[redacted]');
      }
    }
    return sliceUtf8(url.href, MAX_BROWSER_PROJECTED_URL_BYTES);
  } catch {
    return '[invalid-url]';
  }
}

export function browserOriginFromPageUrl(value: string): string | null {
  if (value === 'about:blank') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? canonicalBrowserOrigin(url)
      : null;
  } catch {
    return null;
  }
}

function normalizeCredentialCandidate(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function isCredentialControl(identity: BrowserControlIdentity): boolean {
  if (identity.type?.toLowerCase() === 'password') return true;
  if (
    identity.accessibleNameExceededLimit ||
    identity.referencedAccessibleNameUnavailable
  ) {
    return true;
  }
  const autocompleteTokens =
    identity.autocomplete?.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? [];
  if (autocompleteTokens.some((token) => CREDENTIAL_AUTOCOMPLETE_TOKENS.has(token))) {
    return true;
  }

  for (const candidate of [
    identity.name,
    identity.id,
    identity.ariaLabel,
    identity.accessibleName,
  ]) {
    if (!candidate) continue;
    if (byteLength(candidate) > MAX_BROWSER_FINGERPRINT_BYTES) return true;
    if (CREDENTIAL_CONTROL_PATTERN.test(normalizeCredentialCandidate(candidate))) {
      return true;
    }
  }
  return false;
}
