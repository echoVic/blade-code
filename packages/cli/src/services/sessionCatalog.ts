import * as path from 'node:path';
import { isValidSessionId } from '../context/storage/pathUtils.js';

export const DEFAULT_SESSION_PAGE_SIZE = 50;
export const MAX_SESSION_PAGE_SIZE = 100;

export interface SessionListOptions {
  cwd?: string;
  cursor?: string | null;
  limit?: number;
  includeSubagents?: boolean;
}

export interface SessionCatalogItem {
  sessionId: string;
  projectPath: string;
  lastMessageTime: string;
  relationType?: 'subagent' | 'fork';
}

export interface NormalizedSessionListOptions {
  cwd: string | null;
  cursor?: string;
  limit: number;
  includeSubagents: boolean;
}

export interface SessionCursorBoundary {
  version: 1;
  cwd: string | null;
  includeSubagents: boolean;
  lastMessageTime: string;
  projectPath: string;
  sessionId: string;
}

const BASE64URL_UNPADDED_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_DATETIME_WITH_TIMEZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

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

function encodeCursor(cursor: SessionCursorBoundary): string {
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
      typeof parsed.includeSubagents !== 'boolean' ||
      !(parsed.cwd === null || isValidAbsolutePath(parsed.cwd)) ||
      !isValidIsoTime(parsed.lastMessageTime) ||
      !isValidAbsolutePath(parsed.projectPath) ||
      !isValidSessionId(parsed.sessionId)
    ) {
      throw new Error('invalid');
    }
    return {
      version: 1,
      cwd: parsed.cwd === null ? null : path.resolve(parsed.cwd),
      includeSubagents: parsed.includeSubagents,
      lastMessageTime: parsed.lastMessageTime,
      projectPath: path.resolve(parsed.projectPath),
      sessionId: parsed.sessionId,
    };
  } catch {
    throw new Error('Invalid session cursor');
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
    decoded.includeSubagents !== options.includeSubagents
  ) {
    throw new Error('Session cursor scope does not match this query');
  }
  return decoded;
}

export function normalizeSessionListOptions(
  options: SessionListOptions = {}
): NormalizedSessionListOptions {
  const { cwd, cursor, limit, includeSubagents = false } = options;

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
  };
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
      cwd: options.cwd,
      includeSubagents: options.includeSubagents,
      lastMessageTime: last.lastMessageTime,
      projectPath: last.projectPath,
      sessionId: last.sessionId,
    }),
  };
}
