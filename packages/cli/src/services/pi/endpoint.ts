import type { Api } from '@earendil-works/pi-ai';

export function normalizeProviderBaseUrl(api: Api, baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (api === 'anthropic-messages' && /\/v1$/i.test(normalized)) {
    return normalized.slice(0, -3);
  }
  return normalized;
}
