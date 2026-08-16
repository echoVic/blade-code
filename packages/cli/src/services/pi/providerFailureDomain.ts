import { createHmac } from 'node:crypto';
import type { Api } from '@earendil-works/pi-ai';

export interface ProviderFailureDomainScope {
  provider: string;
  api: Api | string;
  baseUrl: string;
  model: string;
  serviceTier?: string;
  apiVersion?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
}

function canonicalBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

function canonicalHeaders(
  headers: Readonly<Record<string, string>> | undefined
): ReadonlyArray<readonly [string, string]> {
  if (!headers) return [];
  return Object.entries(headers)
    .map(([name, value]) => [name.trim().toLowerCase(), value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

export function createProviderFailureDomainKey(
  scope: ProviderFailureDomainScope,
  processSecret: Uint8Array,
  policy: unknown
): string {
  const canonical = JSON.stringify([
    scope.provider.trim(),
    String(scope.api).trim(),
    canonicalBaseUrl(scope.baseUrl),
    scope.model.trim(),
    scope.serviceTier?.trim() ?? '',
    scope.apiVersion?.trim() ?? '',
    scope.apiKey ?? '',
    canonicalHeaders(scope.customHeaders),
    policy,
  ]);
  return createHmac('sha256', Buffer.from(processSecret))
    .update(canonical)
    .digest('hex');
}
