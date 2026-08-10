import { createHash } from 'node:crypto';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../config/types.js';

export const MCP_LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const satisfies readonly LoggingLevel[];

export const MAX_MCP_LOG_EVENTS_PER_SECOND = 64;
export const MAX_MCP_LOG_ENTRIES_PER_SERVER = 64;
export const MAX_MCP_LOG_ENTRIES_PER_SESSION = 256;
export const MAX_MCP_LOG_MESSAGE_BYTES = 8 * 1024;
export const MAX_MCP_LOG_PROJECTED_BYTES = 16 * 1024;
export const MAX_MCP_LOG_LOGGER_BYTES = 256;

const MAX_LOG_DEPTH = 6;
const MAX_LOG_NODES = 128;
const MAX_LOG_ARRAY_ITEMS = 64;
const MAX_LOG_OBJECT_KEYS = 64;
const MAX_LOG_KEY_BYTES = 128;

const SENSITIVE_LOG_KEY =
  /authorization|api[-_]?key|cookie|credential|password|secret|token/i;

export type McpLogLevel = (typeof MCP_LOG_LEVELS)[number];

export interface McpLoggingPolicy {
  enabled: boolean;
  level: McpLogLevel;
}

export interface McpClientLogEntry {
  level: McpLogLevel;
  logger?: string;
  message: string;
  projectedBytes: number;
  dataSha256: string;
  truncated: boolean;
  detailsOmitted: boolean;
  timestamp: number;
  synthetic?: boolean;
}

export interface NormalizeMcpLogOptions {
  exposeDetails?: boolean;
  now?: number;
}

interface ProjectionState {
  nodes: number;
  remainingStringBytes: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

export function normalizeMcpLoggingPolicy(
  config: Pick<McpServerConfig, 'logging'>
): McpLoggingPolicy {
  const logging = config.logging;
  if (
    logging !== undefined &&
    (logging === null || typeof logging !== 'object' || Array.isArray(logging))
  ) {
    throw new Error('MCP logging configuration must be an object');
  }
  const enabled = logging?.enabled ?? true;
  if (typeof enabled !== 'boolean') {
    throw new Error('MCP logging enabled must be a boolean');
  }
  const level = logging?.level ?? 'warning';
  if (!isMcpLogLevel(level)) {
    throw new Error(`MCP logging level must be one of: ${MCP_LOG_LEVELS.join(', ')}`);
  }
  return { enabled, level };
}

export function isMcpLogLevel(value: unknown): value is McpLogLevel {
  return (
    typeof value === 'string' && (MCP_LOG_LEVELS as readonly string[]).includes(value)
  );
}

export function isMcpLogLevelEnabled(
  level: McpLogLevel,
  minimum: McpLogLevel
): boolean {
  return MCP_LOG_LEVELS.indexOf(level) >= MCP_LOG_LEVELS.indexOf(minimum);
}

export function normalizeMcpLogEntry(
  params: {
    level: McpLogLevel;
    logger?: string;
    data: unknown;
  },
  options: NormalizeMcpLogOptions = {}
): McpClientLogEntry {
  const projection = projectLogData(params.data);
  const rawSerialized =
    typeof projection.value === 'string'
      ? projection.value
      : JSON.stringify(projection.value);
  const boundedProjection = boundedUtf8Preview(
    rawSerialized,
    MAX_MCP_LOG_PROJECTED_BYTES
  );
  const serialized = boundedProjection.value;
  const projectedBytes = Buffer.byteLength(serialized);
  const dataSha256 = createHash('sha256').update(serialized).digest('hex');
  const exposed = options.exposeDetails !== false;
  const preview = exposed
    ? boundedUtf8Preview(serialized, MAX_MCP_LOG_MESSAGE_BYTES)
    : {
        value: `[MCP log details omitted; sha256=${dataSha256}]`,
        truncated: false,
      };
  const logger =
    exposed && params.logger
      ? boundedUtf8(sanitizeLogText(params.logger), MAX_MCP_LOG_LOGGER_BYTES)
      : undefined;

  return {
    level: params.level,
    ...(logger ? { logger } : {}),
    message: preview.value || '[empty MCP log message]',
    projectedBytes,
    dataSha256,
    truncated: projection.truncated || boundedProjection.truncated || preview.truncated,
    detailsOmitted: !exposed,
    timestamp: options.now ?? Date.now(),
  };
}

export function createMcpLogRateLimitEntry(
  dropped: number,
  options: Pick<NormalizeMcpLogOptions, 'now'> = {}
): McpClientLogEntry {
  return {
    ...normalizeMcpLogEntry(
      {
        level: 'warning',
        logger: 'blade.mcp.logging',
        data: `MCP log rate exceeded; dropped at least ${Math.max(1, dropped)} message(s)`,
      },
      options
    ),
    synthetic: true,
  };
}

function projectLogData(data: unknown): {
  value: unknown;
  truncated: boolean;
} {
  const state: ProjectionState = {
    nodes: 0,
    remainingStringBytes: MAX_MCP_LOG_PROJECTED_BYTES,
    truncated: false,
    seen: new WeakSet(),
  };
  return {
    value: visitLogValue(data, 0, state),
    truncated: state.truncated,
  };
}

function visitLogValue(value: unknown, depth: number, state: ProjectionState): unknown {
  state.nodes++;
  if (state.nodes > MAX_LOG_NODES) {
    state.truncated = true;
    return '[node limit reached]';
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    const sanitized = sanitizeLogText(value);
    const allowed = Math.max(0, state.remainingStringBytes);
    const bounded = boundedUtf8(sanitized, allowed);
    const consumed = Buffer.byteLength(bounded);
    state.remainingStringBytes -= consumed;
    if (consumed < Buffer.byteLength(sanitized)) state.truncated = true;
    return bounded;
  }
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'symbol' || typeof value === 'function') {
    return `[${typeof value}]`;
  }
  if (depth >= MAX_LOG_DEPTH) {
    state.truncated = true;
    return '[depth limit reached]';
  }
  if (state.seen.has(value)) {
    state.truncated = true;
    return '[circular]';
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_LOG_ARRAY_ITEMS) state.truncated = true;
      return value
        .slice(0, MAX_LOG_ARRAY_ITEMS)
        .map((entry) => visitLogValue(entry, depth + 1, state));
    }

    const output = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(value);
    if (entries.length > MAX_LOG_OBJECT_KEYS) state.truncated = true;
    for (const [rawKey, entry] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
      const key =
        boundedUtf8(sanitizeLogText(rawKey), MAX_LOG_KEY_BYTES) || '[empty-key]';
      if (rawKey === '_meta' || SENSITIVE_LOG_KEY.test(rawKey)) {
        output[key] = '[redacted]';
      } else {
        output[key] = visitLogValue(entry, depth + 1, state);
      }
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function sanitizeLogText(value: string): string {
  const redacted = value
    .replace(/\bhttps?:\/\/[^\s"'`]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  return [...redacted]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code === 9 || code === 10 || code === 13 || code >= 32) && code !== 127;
    })
    .join('');
}

function boundedUtf8(value: string, maximum: number): string {
  if (maximum <= 0) return '';
  if (Buffer.byteLength(value) <= maximum) return value;
  let bounded = Buffer.from(value).subarray(0, maximum).toString('utf8');
  while (Buffer.byteLength(bounded) > maximum) bounded = bounded.slice(0, -1);
  return bounded;
}

function boundedUtf8Preview(
  value: string,
  maximum: number
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maximum) {
    return { value, truncated: false };
  }
  const suffix = '\n...[MCP log truncated]';
  const head = boundedUtf8(value, maximum - Buffer.byteLength(suffix));
  return {
    value: head + suffix,
    truncated: true,
  };
}
