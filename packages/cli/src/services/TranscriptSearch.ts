/**
 * Transcript Search — 历史会话搜索
 *
 * 在过去的 session JSONL 文件中搜索关键词，返回匹配的上下文片段。
 * 用于 /search 命令和 Agent 工具（回忆过去做过的事情）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseSessionJSONL } from '../context/storage/JSONLStore.js';
import { getProjectStoragePath } from '../context/storage/pathUtils.js';
import {
  getProjectionDb,
  searchProjectionText,
} from '../context/storage/sqlite/projection.js';
import { getCwd } from '../utils/cwd.js';
import { materializeSessionEvents } from './sessionRewind.js';

export interface TranscriptMatch {
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp?: string;
  lineNumber: number;
}

export interface SearchOptions {
  maxResults?: number;
  caseSensitive?: boolean;
  projectPath?: string;
  /** Direct path to scan for JSONL files (bypasses getProjectStoragePath) */
  storagePath?: string;
}

export async function searchTranscripts(
  query: string,
  options: SearchOptions = {}
): Promise<TranscriptMatch[]> {
  const { maxResults = 20, caseSensitive = false, projectPath, storagePath } = options;
  const scanPath = storagePath ?? getProjectStoragePath(projectPath ?? getCwd());

  // Fast path: SQLite FTS candidate retrieval + existing substring/snippet
  // matching for exact parity. Fail-open to the JSONL scan below on any issue.
  // Only used for the default project-scoped search (not a custom storagePath).
  if (!storagePath) {
    const ftsMatches = await searchTranscriptsViaProjection(
      query,
      projectPath ?? getCwd(),
      maxResults,
      caseSensitive
    );
    if (ftsMatches) return ftsMatches;
  }

  let files: string[];
  try {
    const entries = await fs.readdir(scanPath);
    files = entries
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent_'))
      .map((f) => path.join(scanPath, f));
  } catch {
    return [];
  }

  // Sort by mtime descending (most recent first)
  const fileStats = await Promise.all(
    files.map(async (f) => {
      try {
        const stat = await fs.stat(f);
        return { path: f, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const sortedFiles = fileStats
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.path);

  const matches: TranscriptMatch[] = [];
  const searchStr = caseSensitive ? query : query.toLowerCase();

  for (const file of sortedFiles) {
    if (matches.length >= maxResults) break;

    const sessionId = path.basename(file, '.jsonl');
    const fileMatches = await searchFile(file, searchStr, caseSensitive, sessionId);
    matches.push(...fileMatches);

    if (matches.length >= maxResults) {
      matches.length = maxResults;
      break;
    }
  }

  return matches;
}

/**
 * SQLite FTS 快速路径。返回 null 表示投影不可用（调用方回退 JSONL 全扫）。
 * FTS 仅缩小候选集，最终匹配沿用 createMatch 的 substring/snippet 语义以保持一致。
 */
async function searchTranscriptsViaProjection(
  query: string,
  projectPath: string,
  maxResults: number,
  caseSensitive: boolean
): Promise<TranscriptMatch[] | null> {
  try {
    const { syncAll } = await import('../context/storage/sqlite/projection.js');
    const db = await getProjectionDb();
    if (!db) return null;
    // 复用 SessionService 的聚合器保证 sessions/parts 与 JSONL 一致。
    const { SessionService } = await import('./SessionService.js');
    await syncAll(db, SessionService.projectionDeriverForSearch());

    const resolved = path.resolve(projectPath);
    // 取足够多候选（FTS 命中可能被 createMatch 二次过滤），再截断到 maxResults。
    const rows = searchProjectionText(db, query, resolved, maxResults * 4);
    const searchStr = caseSensitive ? query : query.toLowerCase();
    const matches: TranscriptMatch[] = [];
    for (const row of rows) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      const match = createMatch(
        row.text,
        searchStr,
        caseSensitive,
        row.session_id,
        row.role,
        row.timestamp ?? undefined,
        0
      );
      if (match) matches.push(match);
      if (matches.length >= maxResults) break;
    }
    return matches;
  } catch {
    return null;
  }
}

async function searchFile(
  filePath: string,
  query: string,
  caseSensitive: boolean,
  sessionId: string
): Promise<TranscriptMatch[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const rawLines = content.split('\n');
    const parsedLines = rawLines.flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [{ event: JSON.parse(line) as Record<string, unknown>, index }];
      } catch {
        return [];
      }
    });
    const isCurrentTranscript = parsedLines.some(
      ({ event }) => event.type === 'session_created'
    );
    if (!isCurrentTranscript) {
      return searchLegacyEvents(parsedLines, query, caseSensitive, sessionId);
    }

    const lineByEventId = new Map(
      parsedLines.flatMap(({ event, index }) =>
        typeof event.id === 'string' ? [[event.id, index + 1] as const] : []
      )
    );
    const events = materializeSessionEvents(parseSessionJSONL(content, filePath));
    const messages = new Map<
      string,
      {
        role: 'user' | 'assistant';
        content: string[];
        timestamp: string;
        lineNumber: number;
      }
    >();
    for (const event of events) {
      if (
        event.type === 'message_created' &&
        (event.data.role === 'user' || event.data.role === 'assistant')
      ) {
        messages.set(event.data.messageId, {
          role: event.data.role,
          content: [],
          timestamp: event.timestamp,
          lineNumber: lineByEventId.get(event.id) ?? 0,
        });
      }
      if (event.type === 'part_created' && event.data.partType === 'text') {
        const message = messages.get(event.data.messageId);
        const text = (event.data.payload as { text?: unknown }).text;
        if (message && typeof text === 'string') message.content.push(text);
      }
    }
    return [...messages.values()].flatMap((message) => {
      const match = createMatch(
        message.content.join(' '),
        query,
        caseSensitive,
        sessionId,
        message.role,
        message.timestamp,
        message.lineNumber
      );
      return match ? [match] : [];
    });
  } catch {
    return [];
  }
}

function searchLegacyEvents(
  parsedLines: Array<{ event: Record<string, unknown>; index: number }>,
  query: string,
  caseSensitive: boolean,
  sessionId: string
): TranscriptMatch[] {
  return parsedLines.flatMap(({ event, index }) => {
    if (event.type !== 'message') return [];
    const message = event.message as { role?: unknown; content?: unknown } | undefined;
    if (
      (message?.role !== 'user' && message?.role !== 'assistant') ||
      !message.content
    ) {
      return [];
    }
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(
                (part): part is { type: string; text: string } =>
                  typeof part === 'object' &&
                  part !== null &&
                  (part as { type?: unknown }).type === 'text' &&
                  typeof (part as { text?: unknown }).text === 'string'
              )
              .map((part) => part.text)
              .join(' ')
          : '';
    const match = createMatch(
      content,
      query,
      caseSensitive,
      sessionId,
      message.role,
      typeof event.timestamp === 'string' ? event.timestamp : undefined,
      index + 1
    );
    return match ? [match] : [];
  });
}

function createMatch(
  content: string,
  query: string,
  caseSensitive: boolean,
  sessionId: string,
  role: 'user' | 'assistant',
  timestamp: string | undefined,
  lineNumber: number
): TranscriptMatch | undefined {
  if (!content) return undefined;
  const searchTarget = caseSensitive ? content : content.toLowerCase();
  if (!searchTarget.includes(query)) return undefined;
  const index = searchTarget.indexOf(query);
  const snippetStart = Math.max(0, index - 80);
  const snippetEnd = Math.min(content.length, index + query.length + 80);
  return {
    sessionId,
    role,
    content:
      (snippetStart > 0 ? '...' : '') +
      content.slice(snippetStart, snippetEnd).replace(/\n/g, ' ') +
      (snippetEnd < content.length ? '...' : ''),
    timestamp,
    lineNumber,
  };
}

export function formatSearchResults(matches: TranscriptMatch[]): string {
  if (matches.length === 0) return '没有找到匹配的历史记录';

  const lines = [`**找到 ${matches.length} 条匹配:**\n`];

  for (const match of matches) {
    const time = match.timestamp
      ? new Date(match.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      : '?';
    const roleLabel = match.role === 'user' ? '👤' : '🤖';
    lines.push(`${roleLabel} \`${match.sessionId.slice(0, 8)}\` (${time})`);
    lines.push(`  ${match.content}`);
    lines.push('');
  }

  return lines.join('\n');
}
