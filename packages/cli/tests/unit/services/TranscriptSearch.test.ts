import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatSearchResults,
  searchTranscripts,
} from '../../../src/services/TranscriptSearch.js';

describe('TranscriptSearch', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'blade-search-'));
    projectDir = path.join(tempDir, 'project');
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSession(sessionId: string, events: object[]) {
    const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), content);
  }

  it('should find matching messages', async () => {
    writeSession('session-1', [
      {
        type: 'message',
        timestamp: '2024-01-01T10:00:00Z',
        message: { role: 'user', content: '请帮我实现断路器模式' },
      },
      {
        type: 'message',
        timestamp: '2024-01-01T10:01:00Z',
        message: { role: 'assistant', content: '好的，我来实现断路器' },
      },
    ]);

    const results = await searchTranscripts('断路器', {
      storagePath: projectDir,
    });

    expect(results.length).toBe(2);
    expect(results[0].role).toBe('user');
    expect(results[0].content).toContain('断路器');
  });

  it('should be case-insensitive by default', async () => {
    writeSession('session-2', [
      {
        type: 'message',
        timestamp: '2024-01-01T10:00:00Z',
        message: { role: 'user', content: 'implement CIRCUIT BREAKER' },
      },
    ]);

    const results = await searchTranscripts('circuit breaker', {
      storagePath: projectDir,
    });

    expect(results.length).toBe(1);
  });

  it('should respect maxResults', async () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      type: 'message',
      timestamp: `2024-01-01T10:${String(i).padStart(2, '0')}:00Z`,
      message: { role: 'user', content: `keyword match ${i}` },
    }));
    writeSession('session-3', events);

    const results = await searchTranscripts('keyword', {
      storagePath: projectDir,
      maxResults: 5,
    });

    expect(results.length).toBe(5);
  });

  it('should return empty for no matches', async () => {
    writeSession('session-4', [
      {
        type: 'message',
        timestamp: '2024-01-01T10:00:00Z',
        message: { role: 'user', content: 'hello world' },
      },
    ]);

    const results = await searchTranscripts('不存在的关键词', {
      storagePath: projectDir,
    });

    expect(results.length).toBe(0);
  });

  it('should skip non-message events', async () => {
    writeSession('session-5', [
      { type: 'tool_result', content: 'keyword here' },
      {
        type: 'message',
        timestamp: '2024-01-01T10:00:00Z',
        message: { role: 'user', content: 'keyword in message' },
      },
    ]);

    const results = await searchTranscripts('keyword', {
      storagePath: projectDir,
    });

    expect(results.length).toBe(1);
    expect(results[0].role).toBe('user');
  });

  describe('formatSearchResults', () => {
    it('should format empty results', () => {
      const result = formatSearchResults([]);
      expect(result).toContain('没有找到');
    });

    it('should format matches with metadata', () => {
      const result = formatSearchResults([
        {
          sessionId: 'abc12345-def',
          role: 'user',
          content: '...some matched content...',
          timestamp: '2024-01-01T10:00:00Z',
          lineNumber: 5,
        },
      ]);
      expect(result).toContain('1 条匹配');
      expect(result).toContain('abc12345');
      expect(result).toContain('some matched content');
    });
  });
});
