import * as path from 'node:path';
import { isValidSessionId } from '../context/storage/pathUtils.js';
import type {
  AcpRemoteWorkspaceDescriptorV1,
  SessionTaskPriority,
  SessionTaskStatus,
} from '../context/types.js';

export const DEFAULT_SESSION_PAGE_SIZE = 50;
export const MAX_SESSION_PAGE_SIZE = 100;

const SESSION_TASK_STATUSES = new Set<SessionTaskStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const SESSION_TASK_PRIORITIES = new Set<SessionTaskPriority>(['high', 'medium', 'low']);

export interface SessionListOptions {
  cwd?: string;
  cursor?: string | null;
  limit?: number;
  includeSubagents?: boolean;
  archived?: boolean;
}

export interface RemoteSessionListOptions {
  descriptor?: AcpRemoteWorkspaceDescriptorV1;
  cursor?: string | null;
  limit?: number;
  includeSubagents?: boolean;
  archived?: boolean;
}

export type RemoteSessionScanOptions = Omit<
  RemoteSessionListOptions,
  'cursor' | 'limit'
>;

export interface SessionTaskFilterOptions {
  /**
   * 可选：仅返回这些任务状态的会话。投影路径下推为 SQL `task_status IN (...)`
   * 并命中对应任务索引；JSONL 回退路径用等价内存过滤。
   */
  taskStatus?: SessionTaskStatus | readonly SessionTaskStatus[];
  /** 可选：仅返回这些优先级的任务会话。 */
  taskPriority?: SessionTaskPriority | readonly SessionTaskPriority[];
  /** 可选：仅返回截止时间大于等于该时刻的任务会话。 */
  taskDueAfter?: string;
  /** 可选：仅返回截止时间小于等于该时刻的任务会话。 */
  taskDueBefore?: string;
}

export interface SessionScanOptions
  extends Omit<SessionListOptions, 'cursor' | 'limit'>,
    SessionTaskFilterOptions {}

export interface SessionCatalogItem {
  sessionId: string;
  projectPath: string;
  lastMessageTime: string;
  relationType?: 'subagent' | 'fork';
}

export interface RemoteSessionCatalogItem extends SessionCatalogItem {
  workspaceIdentity: string;
}

export interface NormalizedSessionTaskFilters {
  taskStatuses?: readonly SessionTaskStatus[];
  taskPriorities?: readonly SessionTaskPriority[];
  taskDueAfter?: string;
  taskDueBefore?: string;
}

export interface NormalizedSessionListOptions {
  cwd: string | null;
  cursor?: string;
  limit: number;
  includeSubagents: boolean;
  archived: boolean;
}

export interface NormalizedRemoteSessionListOptions {
  descriptor?: AcpRemoteWorkspaceDescriptorV1;
  exactIdentity: string | null;
  cursor?: string;
  limit: number;
  includeSubagents: boolean;
  archived: boolean;
}

export interface SessionCursorBoundary {
  version: 1;
  kind?: 'local';
  cwd: string | null;
  includeSubagents: boolean;
  archived?: boolean;
  lastMessageTime: string;
  projectPath: string;
  sessionId: string;
}

export interface RemoteSessionCursorBoundary {
  version: 1;
  kind: 'remote';
  exactIdentity: string | null;
  includeSubagents: boolean;
  archived: boolean;
  lastMessageTime: string;
  workspaceIdentity: string;
  sessionId: string;
}

const BASE64URL_UNPADDED_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_DATETIME_WITH_TIMEZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ACP_REMOTE_EXACT_IDENTITY_PATTERN = /^acp-remote-exact-path:[a-f0-9]{64}$/;

function isValidIsoTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATETIME_WITH_TIMEZONE_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isValidAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function isValidRemoteWorkspaceIdentity(value: unknown): value is string {
  return typeof value === 'string' && ACP_REMOTE_EXACT_IDENTITY_PATTERN.test(value);
}

function encodeCursor(cursor: SessionCursorBoundary): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function encodeRemoteCursor(cursor: RemoteSessionCursorBoundary): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseCursor(cursor: string): SessionCursorBoundary {
  try {
    if (!BASE64URL_UNPADDED_PATTERN.test(cursor)) {
      throw new Error('invalid');
    }
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new Error('invalid');
    }
    const parsed = JSON.parse(decoded) as Partial<SessionCursorBoundary>;
    if (
      parsed.version !== 1 ||
      (parsed.kind !== undefined && parsed.kind !== 'local') ||
      typeof parsed.includeSubagents !== 'boolean' ||
      (parsed.archived !== undefined && typeof parsed.archived !== 'boolean') ||
      !(parsed.cwd === null || isValidAbsolutePath(parsed.cwd)) ||
      !isValidIsoTime(parsed.lastMessageTime) ||
      !isValidAbsolutePath(parsed.projectPath) ||
      !isValidSessionId(parsed.sessionId)
    ) {
      throw new Error('invalid');
    }
    return {
      version: 1,
      kind: 'local',
      cwd: parsed.cwd === null ? null : path.resolve(parsed.cwd),
      includeSubagents: parsed.includeSubagents,
      archived: parsed.archived ?? false,
      lastMessageTime: parsed.lastMessageTime,
      projectPath: path.resolve(parsed.projectPath),
      sessionId: parsed.sessionId,
    };
  } catch {
    throw new Error('Invalid session cursor');
  }
}

function parseRemoteCursor(cursor: string): RemoteSessionCursorBoundary {
  try {
    if (!BASE64URL_UNPADDED_PATTERN.test(cursor)) {
      throw new Error('invalid');
    }
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new Error('invalid');
    }
    const parsed = JSON.parse(decoded) as Partial<RemoteSessionCursorBoundary>;
    const keys = Object.keys(parsed);
    const allowedKeys = new Set([
      'version',
      'kind',
      'exactIdentity',
      'includeSubagents',
      'archived',
      'lastMessageTime',
      'workspaceIdentity',
      'sessionId',
    ]);
    if (
      keys.some((key) => !allowedKeys.has(key)) ||
      parsed.version !== 1 ||
      parsed.kind !== 'remote' ||
      typeof parsed.includeSubagents !== 'boolean' ||
      typeof parsed.archived !== 'boolean' ||
      !(
        parsed.exactIdentity === null ||
        isValidRemoteWorkspaceIdentity(parsed.exactIdentity)
      ) ||
      !isValidIsoTime(parsed.lastMessageTime) ||
      !isValidRemoteWorkspaceIdentity(parsed.workspaceIdentity) ||
      !isValidSessionId(parsed.sessionId)
    ) {
      throw new Error('invalid');
    }
    return {
      version: 1,
      kind: 'remote',
      exactIdentity: parsed.exactIdentity ?? null,
      includeSubagents: parsed.includeSubagents,
      archived: parsed.archived,
      lastMessageTime: parsed.lastMessageTime,
      workspaceIdentity: parsed.workspaceIdentity,
      sessionId: parsed.sessionId,
    };
  } catch {
    throw new Error('Invalid remote session cursor');
  }
}

export function sessionCatalogSortKey(value: string): string {
  let key = '';
  for (let index = 0; index < value.length; index += 1) {
    key += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return key;
}

export function resolveSessionCursorBoundary(
  options: NormalizedSessionListOptions
): SessionCursorBoundary | undefined {
  if (!options.cursor) return undefined;
  const decoded = parseCursor(options.cursor);
  if (
    decoded.cwd !== options.cwd ||
    decoded.includeSubagents !== options.includeSubagents ||
    (decoded.archived ?? false) !== options.archived
  ) {
    throw new Error('Session cursor scope does not match this query');
  }
  return decoded;
}

export function resolveRemoteSessionCursorBoundary(
  options: NormalizedRemoteSessionListOptions
): RemoteSessionCursorBoundary | undefined {
  if (!options.cursor) return undefined;
  const decoded = parseRemoteCursor(options.cursor);
  if (
    decoded.exactIdentity !== options.exactIdentity ||
    (options.exactIdentity !== null &&
      decoded.workspaceIdentity !== options.exactIdentity) ||
    decoded.includeSubagents !== options.includeSubagents ||
    (decoded.archived ?? false) !== options.archived
  ) {
    throw new Error('Remote session cursor scope does not match this query');
  }
  return decoded;
}

export function normalizeSessionListOptions(
  options: SessionListOptions = {}
): NormalizedSessionListOptions {
  const { cwd, cursor, limit, includeSubagents = false, archived = false } = options;

  if (cwd !== undefined && !path.isAbsolute(cwd)) {
    throw new Error('Session catalog cwd must be absolute');
  }

  const normalizedLimit = limit === undefined ? DEFAULT_SESSION_PAGE_SIZE : limit;
  if (
    !Number.isInteger(normalizedLimit) ||
    normalizedLimit < 1 ||
    normalizedLimit > MAX_SESSION_PAGE_SIZE
  ) {
    throw new Error('Session catalog limit must be an integer from 1 to 100');
  }

  return {
    cwd: cwd === undefined ? null : path.resolve(cwd),
    cursor: cursor ?? undefined,
    limit: normalizedLimit,
    includeSubagents,
    archived,
  };
}

export function normalizeRemoteSessionListOptions(
  options: RemoteSessionListOptions = {}
): NormalizedRemoteSessionListOptions {
  const {
    descriptor,
    cursor,
    limit,
    includeSubagents = false,
    archived = false,
  } = options;

  const normalizedLimit = limit === undefined ? DEFAULT_SESSION_PAGE_SIZE : limit;
  if (
    !Number.isInteger(normalizedLimit) ||
    normalizedLimit < 1 ||
    normalizedLimit > MAX_SESSION_PAGE_SIZE
  ) {
    throw new Error('Session catalog limit must be an integer from 1 to 100');
  }

  return {
    descriptor,
    exactIdentity: descriptor?.exactIdentity ?? null,
    cursor: cursor ?? undefined,
    limit: normalizedLimit,
    includeSubagents,
    archived,
  };
}

export function normalizeSessionTaskFilters(
  options: SessionTaskFilterOptions = {}
): NormalizedSessionTaskFilters {
  const taskStatuses = normalizeEnumFilter(
    options.taskStatus,
    SESSION_TASK_STATUSES,
    'task status'
  );
  const taskPriorities = normalizeEnumFilter(
    options.taskPriority,
    SESSION_TASK_PRIORITIES,
    'task priority'
  );
  const taskDueAfter = normalizeDueBoundary(options.taskDueAfter, 'taskDueAfter');
  const taskDueBefore = normalizeDueBoundary(options.taskDueBefore, 'taskDueBefore');
  validateDueRange(taskDueAfter, taskDueBefore);
  return {
    ...(taskStatuses ? { taskStatuses } : {}),
    ...(taskPriorities ? { taskPriorities } : {}),
    ...(taskDueAfter ? { taskDueAfter } : {}),
    ...(taskDueBefore ? { taskDueBefore } : {}),
  };
}

function normalizeEnumFilter<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) return undefined;
  const normalized = new Set<T>();
  for (const item of raw) {
    if (typeof item !== 'string' || !allowed.has(item as T)) {
      throw new Error(`Invalid session ${label} filter`);
    }
    normalized.add(item as T);
  }
  return [...normalized].sort();
}

function normalizeDueBoundary(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid session ${label} filter`);
  }
  return new Date(value).toISOString();
}

function validateDueRange(
  taskDueAfter: string | undefined,
  taskDueBefore: string | undefined
): void {
  if (
    taskDueAfter !== undefined &&
    taskDueBefore !== undefined &&
    taskDueAfter > taskDueBefore
  ) {
    throw new Error('Session task due range is inverted');
  }
}

export function compareSessionCatalogItems(
  left: SessionCatalogItem,
  right: SessionCatalogItem
): number {
  if (left.lastMessageTime > right.lastMessageTime) return -1;
  if (left.lastMessageTime < right.lastMessageTime) return 1;
  if (left.projectPath < right.projectPath) return -1;
  if (left.projectPath > right.projectPath) return 1;
  if (left.sessionId < right.sessionId) return -1;
  if (left.sessionId > right.sessionId) return 1;
  return 0;
}

export function compareRemoteSessionCatalogItems(
  left: RemoteSessionCatalogItem,
  right: RemoteSessionCatalogItem
): number {
  if (left.lastMessageTime > right.lastMessageTime) return -1;
  if (left.lastMessageTime < right.lastMessageTime) return 1;
  if (left.workspaceIdentity < right.workspaceIdentity) return -1;
  if (left.workspaceIdentity > right.workspaceIdentity) return 1;
  if (left.sessionId < right.sessionId) return -1;
  if (left.sessionId > right.sessionId) return 1;
  return 0;
}

export function paginateSessionCatalog<T extends SessionCatalogItem>(
  items: readonly T[],
  options: NormalizedSessionListOptions
): { sessions: T[]; nextCursor?: string } {
  let filtered = [...items];

  const decoded = resolveSessionCursorBoundary(options);
  if (decoded) {
    filtered = filtered.filter(
      (item) =>
        compareSessionCatalogItems(item, {
          sessionId: decoded.sessionId,
          projectPath: decoded.projectPath,
          lastMessageTime: decoded.lastMessageTime,
        }) > 0
    );
  }

  const sessions = filtered.slice(0, options.limit);
  if (sessions.length === 0 || filtered.length <= sessions.length) {
    return { sessions };
  }

  const last = sessions[sessions.length - 1]!;
  return {
    sessions,
    nextCursor: encodeCursor({
      version: 1,
      kind: 'local',
      cwd: options.cwd,
      includeSubagents: options.includeSubagents,
      archived: options.archived,
      lastMessageTime: last.lastMessageTime,
      projectPath: last.projectPath,
      sessionId: last.sessionId,
    }),
  };
}

export function paginateRemoteSessionCatalog<T extends RemoteSessionCatalogItem>(
  items: readonly T[],
  options: NormalizedRemoteSessionListOptions
): { sessions: T[]; nextCursor?: string } {
  let filtered = [...items];

  const decoded = resolveRemoteSessionCursorBoundary(options);
  if (decoded) {
    filtered = filtered.filter(
      (item) =>
        compareRemoteSessionCatalogItems(item, {
          sessionId: decoded.sessionId,
          projectPath: item.projectPath,
          lastMessageTime: decoded.lastMessageTime,
          workspaceIdentity: decoded.workspaceIdentity,
        }) > 0
    );
  }

  const sessions = filtered.slice(0, options.limit);
  if (sessions.length === 0 || filtered.length <= sessions.length) {
    return { sessions };
  }

  const last = sessions[sessions.length - 1]!;
  return {
    sessions,
    nextCursor: encodeRemoteCursor({
      version: 1,
      kind: 'remote',
      exactIdentity: options.exactIdentity,
      includeSubagents: options.includeSubagents,
      archived: options.archived,
      lastMessageTime: last.lastMessageTime,
      workspaceIdentity: last.workspaceIdentity,
      sessionId: last.sessionId,
    }),
  };
}
