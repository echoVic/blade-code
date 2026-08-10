import type { McpServerConfig } from '../config/types.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_TERMINAL_ERROR_THRESHOLD = 3;

export const MAX_MCP_RECOVERY_ATTEMPTS = 20;
export const MAX_MCP_RECOVERY_DELAY_MS = 5 * 60_000;
export const MAX_MCP_CONNECTION_ERROR_BYTES = 512;

export type McpRecoveryReason =
  | 'transport_closed'
  | 'transport_error'
  | 'session_expired'
  | 'health_check';

export type McpRecoveryPhase = 'reconnecting' | 'recovered' | 'failed';

export interface McpRecoveryPolicy {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  terminalErrorThreshold: number;
}

export interface McpClientConnectionLifecycleChange {
  phase: McpRecoveryPhase;
  reason: McpRecoveryReason;
  attempt: number;
  maxAttempts: number;
  nextRetryAt?: number;
  error?: string;
}

function finiteNumber(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function finiteInteger(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  const normalized = finiteNumber(value, fallback, label, minimum, maximum);
  if (!Number.isInteger(normalized)) {
    throw new Error(`${label} must be an integer`);
  }
  return normalized;
}

export function normalizeMcpRecoveryPolicy(
  config: Pick<McpServerConfig, 'recovery'>
): McpRecoveryPolicy {
  const recovery = config.recovery;
  if (
    recovery !== undefined &&
    (recovery === null || typeof recovery !== 'object' || Array.isArray(recovery))
  ) {
    throw new Error('MCP recovery configuration must be an object');
  }

  const enabled = recovery?.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    throw new Error('MCP recovery enabled must be a boolean');
  }
  const maxAttempts = finiteInteger(
    recovery?.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    'MCP recovery maxAttempts',
    0,
    MAX_MCP_RECOVERY_ATTEMPTS
  );
  const initialDelayMs = finiteInteger(
    recovery?.initialDelayMs,
    DEFAULT_INITIAL_DELAY_MS,
    'MCP recovery initialDelayMs',
    10,
    MAX_MCP_RECOVERY_DELAY_MS
  );
  const maxDelayMs = finiteInteger(
    recovery?.maxDelayMs,
    DEFAULT_MAX_DELAY_MS,
    'MCP recovery maxDelayMs',
    initialDelayMs,
    MAX_MCP_RECOVERY_DELAY_MS
  );
  const jitterRatio = finiteNumber(
    recovery?.jitterRatio,
    DEFAULT_JITTER_RATIO,
    'MCP recovery jitterRatio',
    0,
    1
  );
  const terminalErrorThreshold = finiteInteger(
    recovery?.terminalErrorThreshold,
    DEFAULT_TERMINAL_ERROR_THRESHOLD,
    'MCP recovery terminalErrorThreshold',
    1,
    10
  );

  return {
    enabled,
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    terminalErrorThreshold,
  };
}

export function getMcpRecoveryDelay(
  policy: McpRecoveryPolicy,
  attempt: number,
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs);
  if (policy.jitterRatio === 0) return base;
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const factor = 1 - policy.jitterRatio + 2 * policy.jitterRatio * boundedRandom;
  return Math.max(0, Math.round(base * factor));
}

export function sanitizeMcpConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = message
    .replace(/\bhttps?:\/\/[^\s"'`]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (Buffer.byteLength(sanitized) <= MAX_MCP_CONNECTION_ERROR_BYTES) {
    return sanitized;
  }
  let truncated = Buffer.from(sanitized)
    .subarray(0, MAX_MCP_CONNECTION_ERROR_BYTES)
    .toString('utf8');
  while (Buffer.byteLength(truncated) > MAX_MCP_CONNECTION_ERROR_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

export function isMcpSessionExpiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    (normalized.includes('404') || normalized.includes('-32001')) &&
    (normalized.includes('session') || normalized.includes('not found'))
  );
}

export function isTerminalMcpTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return [
    'econnreset',
    'etimedout',
    'epipe',
    'ehostunreach',
    'econnrefused',
    'body timeout error',
    'socket hang up',
    'connection closed',
    'connection terminated',
    'sse stream disconnected',
    'failed to reconnect sse stream',
    'maximum reconnection attempts',
  ].some((needle) => normalized.includes(needle));
}

export function createMcpRecoveryAbortError(reason?: unknown): DOMException {
  return new DOMException(
    String(reason || 'MCP connection recovery cancelled'),
    'AbortError'
  );
}

export async function waitForMcpRecoveryDelay(
  delayMs: number,
  signal: AbortSignal,
  unref = true
): Promise<void> {
  if (signal.aborted) throw createMcpRecoveryAbortError(signal.reason);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    if (unref) timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(createMcpRecoveryAbortError(signal.reason));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
