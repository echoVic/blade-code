import type { Task } from '@modelcontextprotocol/sdk/types.js';
import type { McpNormalizedToolResult } from './McpToolResult.js';

export const MAX_MCP_TASKS_PER_SESSION = 32;
export const MAX_MCP_TASKS_GLOBAL = 256;
export const MIN_MCP_TASK_TTL_MS = 10_000;
export const MAX_MCP_TASK_TTL_MS = 24 * 60 * 60 * 1_000;
export const MIN_MCP_TASK_POLL_INTERVAL_MS = 100;
export const MAX_MCP_TASK_POLL_INTERVAL_MS = 10_000;
export const MAX_MCP_TASK_STATUS_MESSAGE_BYTES = 1_024;

const DEFAULT_TASK_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_LIFETIME_MS = 30 * 60 * 1_000;
const MAX_SERVER_TASK_ID_BYTES = 512;
const UNSAFE_UNICODE = /[\p{Cf}\p{Co}\p{Cn}]/u;

export interface McpTaskPolicyConfig {
  enabled: boolean;
  defaultTtlMs?: number;
  pollIntervalMs?: number;
  maxTasksPerSession?: number;
  maxLifetimeMs?: number;
}

export interface McpTaskPolicy {
  enabled: boolean;
  defaultTtlMs: number;
  pollIntervalMs: number;
  maxTasksPerSession: number;
  maxLifetimeMs: number;
}

export type McpTaskStatus =
  | 'working'
  | 'input_required'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface McpServerTaskState {
  taskId: string;
  status: Exclude<McpTaskStatus, 'interrupted'>;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollIntervalMs: number;
  statusMessage?: string;
}

export interface McpTaskOwner {
  sessionId: string;
  projectPath: string;
}

export interface McpTaskSnapshot {
  taskId: string;
  serverName: string;
  toolName: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  hasResult: boolean;
  result?: McpNormalizedToolResult;
  error?: string;
}

export interface McpTaskChange extends McpTaskSnapshot {
  revision: number;
  owner: McpTaskOwner;
}

export function normalizeMcpTaskPolicy(
  input: McpTaskPolicyConfig | undefined
): McpTaskPolicy {
  if (!input) {
    return {
      enabled: false,
      defaultTtlMs: DEFAULT_TASK_TTL_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      maxTasksPerSession: MAX_MCP_TASKS_PER_SESSION,
      maxLifetimeMs: DEFAULT_MAX_LIFETIME_MS,
    };
  }
  if (typeof input.enabled !== 'boolean') {
    throw new Error('MCP tasks.enabled must be a boolean');
  }
  const defaultTtlMs = boundedInteger(
    input.defaultTtlMs ?? DEFAULT_TASK_TTL_MS,
    MIN_MCP_TASK_TTL_MS,
    MAX_MCP_TASK_TTL_MS,
    'MCP tasks.defaultTtlMs'
  );
  const maxLifetimeMs = boundedInteger(
    input.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
    MIN_MCP_TASK_TTL_MS,
    MAX_MCP_TASK_TTL_MS,
    'MCP tasks.maxLifetimeMs'
  );
  if (defaultTtlMs > maxLifetimeMs) {
    throw new Error('MCP tasks.defaultTtlMs must not exceed tasks.maxLifetimeMs');
  }
  return {
    enabled: input.enabled,
    defaultTtlMs,
    pollIntervalMs: boundedInteger(
      input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MIN_MCP_TASK_POLL_INTERVAL_MS,
      MAX_MCP_TASK_POLL_INTERVAL_MS,
      'MCP tasks.pollIntervalMs'
    ),
    maxTasksPerSession: boundedInteger(
      input.maxTasksPerSession ?? MAX_MCP_TASKS_PER_SESSION,
      1,
      MAX_MCP_TASKS_PER_SESSION,
      'MCP tasks.maxTasksPerSession'
    ),
    maxLifetimeMs,
  };
}

export function normalizeMcpTaskTtl(
  value: number | undefined,
  policy: McpTaskPolicy
): number {
  return boundedInteger(
    value ?? policy.defaultTtlMs,
    MIN_MCP_TASK_TTL_MS,
    Math.min(MAX_MCP_TASK_TTL_MS, policy.maxLifetimeMs),
    'MCP task ttl'
  );
}

export function normalizeMcpServerTask(
  task: Task,
  policy: McpTaskPolicy,
  expected?: { taskId: string; createdAt: string }
): McpServerTaskState {
  const taskId = boundedIdentity(task.taskId, 'task ID', MAX_SERVER_TASK_ID_BYTES);
  const createdAt = normalizedTimestamp(task.createdAt, 'createdAt');
  const lastUpdatedAt = normalizedTimestamp(task.lastUpdatedAt, 'lastUpdatedAt');
  if (Date.parse(lastUpdatedAt) < Date.parse(createdAt)) {
    throw new Error('MCP task lastUpdatedAt precedes createdAt');
  }
  if (expected && (taskId !== expected.taskId || createdAt !== expected.createdAt)) {
    throw new Error('MCP task identity changed across connection generation');
  }
  const ttl =
    task.ttl === null
      ? null
      : boundedInteger(task.ttl, 0, MAX_MCP_TASK_TTL_MS, 'MCP task ttl');
  const serverPollInterval =
    task.pollInterval === undefined
      ? policy.pollIntervalMs
      : boundedInteger(
          task.pollInterval,
          0,
          Number.MAX_SAFE_INTEGER,
          'MCP task pollInterval'
        );
  const pollIntervalMs = Math.min(
    MAX_MCP_TASK_POLL_INTERVAL_MS,
    Math.max(MIN_MCP_TASK_POLL_INTERVAL_MS, serverPollInterval)
  );
  const statusMessage = task.statusMessage
    ? boundedStatusMessage(task.statusMessage, taskId)
    : undefined;
  return {
    taskId,
    status: task.status,
    createdAt,
    lastUpdatedAt,
    ttl,
    pollIntervalMs,
    ...(statusMessage ? { statusMessage } : {}),
  };
}

export function isMcpTaskTerminal(status: McpTaskStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

export function sanitizeMcpTaskError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedUtf8(
    sanitizeText(
      message
        .replace(/\bhttps?:\/\/[^\s"'`]+/gi, '[redacted-url]')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    ),
    MAX_MCP_TASK_STATUS_MESSAGE_BYTES
  );
}

function boundedStatusMessage(value: string, taskId: string): string {
  return boundedUtf8(
    sanitizeText(value.replaceAll(taskId, '[redacted-task-id]')),
    MAX_MCP_TASK_STATUS_MESSAGE_BYTES
  );
}

function sanitizeText(value: string): string {
  return [...value.normalize('NFKC')]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        codePoint === 0 ||
        (codePoint >= 1 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127
      ) {
        return false;
      }
      return !UNSAFE_UNICODE.test(character);
    })
    .join('')
    .trim();
}

function normalizedTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`MCP task ${label} is invalid`);
  }
  return new Date(timestamp).toISOString();
}

function boundedIdentity(value: string, label: string, maximumBytes: number): string {
  if (
    !value ||
    Buffer.byteLength(value) > maximumBytes ||
    sanitizeText(value) !== value
  ) {
    throw new Error(`MCP ${label} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let result = bytes.subarray(0, maximumBytes).toString('utf8');
  while (Buffer.byteLength(result) > maximumBytes) {
    result = result.slice(0, -1);
  }
  return result;
}
