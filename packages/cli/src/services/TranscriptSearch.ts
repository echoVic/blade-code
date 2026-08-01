/**
 * Transcript Search — 历史会话搜索
 *
 * 在过去的 session JSONL 文件中搜索关键词，返回匹配的上下文片段。
 * 用于 /search 命令和 Agent 工具（回忆过去做过的事情）。
 */

import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { getProjectStoragePath } from '../context/storage/pathUtils.js';
import { getCwd } from '../utils/cwd.js';

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

async function searchFile(
  filePath: string,
  query: string,
  caseSensitive: boolean,
  sessionId: string
): Promise<TranscriptMatch[]> {
  const matches: TranscriptMatch[] = [];

  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;

    for await (const line of rl) {
      lineNumber++;
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        if (event.type !== 'message') continue;
        if (!event.message?.content) continue;

        const role = event.message.role;
        if (role !== 'user' && role !== 'assistant') continue;

        const content =
          typeof event.message.content === 'string'
            ? event.message.content
            : Array.isArray(event.message.content)
              ? event.message.content
                  .filter((p: { type: string }) => p.type === 'text')
                  .map((p: { text: string }) => p.text)
                  .join(' ')
              : '';

        if (!content) continue;

        const searchTarget = caseSensitive ? content : content.toLowerCase();
        if (!searchTarget.includes(query)) continue;

        // Extract a snippet around the match
        const idx = searchTarget.indexOf(query);
        const snippetStart = Math.max(0, idx - 80);
        const snippetEnd = Math.min(content.length, idx + query.length + 80);
        const snippet =
          (snippetStart > 0 ? '...' : '') +
          content.slice(snippetStart, snippetEnd).replace(/\n/g, ' ') +
          (snippetEnd < content.length ? '...' : '');

        matches.push({
          sessionId,
          role,
          content: snippet,
          timestamp: event.timestamp,
          lineNumber,
        });
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error
  }

  return matches;
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
