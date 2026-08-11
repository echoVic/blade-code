export type ProviderRetryPhase = 'scheduled' | 'attempt' | 'recovered' | 'exhausted';

export type ProviderRetryReason =
  | 'rate_limit'
  | 'server_error'
  | 'timeout'
  | 'transport'
  | 'stream_closed';

export interface ProviderRetryEvent {
  phase: ProviderRetryPhase;
  attempt: number;
  maxRetries: number;
  reason: ProviderRetryReason;
  statusCode?: number;
  delayMs?: number;
  nextRetryAt?: number;
}

export interface ProviderResponseMetadata {
  statusCode: number;
  retryAfter?: string;
  retryAfterMs?: string;
  shouldRetry?: 'true' | 'false';
}

export interface ProviderRetryClassification {
  retryable: boolean;
  reason?: ProviderRetryReason;
  statusCode?: number;
}

export const MAX_PROVIDER_RETRY_DELAY_MS = 60_000;
const BASE_PROVIDER_RETRY_DELAY_MS = 500;
const MAX_EXPONENTIAL_RETRY_DELAY_MS = 8_000;
const replayBoundaryErrors = new WeakSet<object>();

const NON_RETRYABLE_LIMIT_MARKERS = [
  'gousagelimiterror',
  'freeusagelimiterror',
  'monthly usage limit reached',
  'available balance',
  'insufficient_quota',
  'out of budget',
  'quota exceeded',
  'billing',
];

const NON_RETRYABLE_CONTEXT_MARKERS = [
  'prompt_too_long',
  'prompt is too long',
  'maximum context length',
  'context length exceeded',
  'context_length_exceeded',
  'request too large',
];

const TRANSPORT_MARKERS = [
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'etimedout',
  'fetch failed',
  'network error',
  'connection error',
  'connection refused',
  'connection lost',
  'other side closed',
  'socket hang up',
  'socket connection was closed',
  'upstream connect',
  'reset before headers',
  'websocket closed',
  'websocket error',
  'http2 request did not get a response',
];

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function isProviderContextLimitError(error: unknown): boolean {
  const message = errorMessage(error);
  return NON_RETRYABLE_CONTEXT_MARKERS.some((marker) => message.includes(marker));
}

export function markProviderReplayBoundary(error: unknown): void {
  if (error !== null && typeof error === 'object') {
    replayBoundaryErrors.add(error);
  }
}

export function providerReplayBoundaryCrossed(error: unknown): boolean {
  return error !== null && typeof error === 'object' && replayBoundaryErrors.has(error);
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const candidate = error as Record<string, unknown>;
  for (const key of ['status', 'statusCode'] as const) {
    const value = candidate[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

function statusFromMessage(message: string): number | undefined {
  const direct = message.match(/^(?:error:\s*)?(\d{3})\b/);
  const labeled = message.match(/\b(?:status(?:\s+code)?|http)[:\s]+(\d{3})\b/);
  const value = Number(direct?.[1] ?? labeled?.[1]);
  return Number.isInteger(value) ? value : undefined;
}

export function classifyProviderRetry(
  error: unknown,
  response?: ProviderResponseMetadata
): ProviderRetryClassification {
  const message = errorMessage(error);
  const code = errorCode(error);
  if (
    code === 'STREAM_IDLE_TIMEOUT' ||
    (error instanceof Error && error.name === 'AbortError') ||
    message.includes('request aborted') ||
    message === 'aborted'
  ) {
    return { retryable: false };
  }
  if (
    NON_RETRYABLE_LIMIT_MARKERS.some((marker) => message.includes(marker)) ||
    isProviderContextLimitError(error)
  ) {
    return { retryable: false };
  }
  if (response?.shouldRetry === 'false') {
    return { retryable: false, statusCode: response.statusCode };
  }

  const statusCode =
    response?.statusCode ?? errorStatus(error) ?? statusFromMessage(message);
  if (response?.shouldRetry === 'true') {
    const reason =
      statusCode === 429
        ? 'rate_limit'
        : statusCode === 408 || statusCode === 409
          ? 'timeout'
          : 'server_error';
    return { retryable: true, reason, statusCode };
  }
  if (statusCode === 429) {
    return { retryable: true, reason: 'rate_limit', statusCode };
  }
  if (statusCode === 408 || statusCode === 409) {
    return { retryable: true, reason: 'timeout', statusCode };
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return { retryable: true, reason: 'server_error', statusCode };
  }
  if (
    code === 'PROVIDER_STREAM_CLOSED' ||
    message.includes('stream closed before completion') ||
    message.includes('ended without') ||
    message.includes('stream ended before')
  ) {
    return { retryable: true, reason: 'stream_closed', statusCode };
  }
  if (TRANSPORT_MARKERS.some((marker) => message.includes(marker))) {
    return { retryable: true, reason: 'transport', statusCode };
  }
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('temporarily unavailable') ||
    message.includes('upstream_error') ||
    message.includes('overloaded') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('service unavailable') ||
    message.includes('server error') ||
    message.includes('internal error') ||
    message.includes('please retry') ||
    message.includes('try your request again')
  ) {
    const reason =
      message.includes('rate') || message.includes('too many')
        ? 'rate_limit'
        : message.includes('timeout') || message.includes('timed out')
          ? 'timeout'
          : 'server_error';
    return { retryable: true, reason, statusCode };
  }
  return { retryable: false, statusCode };
}

function parseServerRetryDelay(
  response: ProviderResponseMetadata | undefined,
  now: number
): number | undefined {
  if (!response) return undefined;
  if (response.retryAfterMs !== undefined) {
    const value = Number.parseFloat(response.retryAfterMs);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  if (response.retryAfter === undefined) return undefined;
  const seconds = Number.parseFloat(response.retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(response.retryAfter);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export function computeProviderRetryDelay(
  attempt: number,
  response?: ProviderResponseMetadata,
  options: {
    now?: number;
    random?: number;
    maxDelayMs?: number;
  } = {}
): number {
  const now = options.now ?? Date.now();
  const maxDelayMs = options.maxDelayMs ?? MAX_PROVIDER_RETRY_DELAY_MS;
  const serverDelay = parseServerRetryDelay(response, now);
  if (serverDelay !== undefined) {
    return Math.min(Math.ceil(serverDelay), maxDelayMs);
  }

  const retryIndex = Math.max(0, attempt - 1);
  const exponential = Math.min(
    BASE_PROVIDER_RETRY_DELAY_MS * 2 ** retryIndex,
    MAX_EXPONENTIAL_RETRY_DELAY_MS
  );
  const random = Math.max(0, Math.min(1, options.random ?? Math.random()));
  const jittered = exponential * (0.75 + random * 0.25);
  return Math.min(Math.round(jittered), maxDelayMs);
}
