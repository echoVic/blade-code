/**
 * AutoMemoryManager 单元测试
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoMemoryManager } from '../../../../src/memory/AutoMemoryManager.js';

vi.unmock('node:child_process');

const execFileAsync = promisify(execFile);
const concurrentWriter = path.resolve(
  import.meta.dirname,
  '../../../support/memoryConsolidationConcurrentWriter.ts'
);

describe('AutoMemoryManager', () => {
  let tmpDir: string;
  let memDir: string;
  let manager: AutoMemoryManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-memory-test-'));
    memDir = path.join(tmpDir, 'memory');
    manager = new AutoMemoryManager(tmpDir, undefined, memDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should create memory directory', async () => {
      await manager.initialize();
      const stat = await fs.stat(memDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should be idempotent', async () => {
      await manager.initialize();
      await manager.initialize();
      const stat = await fs.stat(memDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('loadIndex', () => {
    it('should return null when MEMORY.md does not exist', async () => {
      const result = await manager.loadIndex();
      expect(result).toBeNull();
    });

    it('should return null when MEMORY.md is empty', async () => {
      await manager.initialize();
      await fs.writeFile(path.join(memDir, 'MEMORY.md'), '', 'utf-8');
      const result = await manager.loadIndex();
      expect(result).toBeNull();
    });

    it('should load full content when under line limit', async () => {
      await manager.initialize();
      const content = '# Memory\n\n- Build: `bun run build`\n- Test: `bun run test`';
      await fs.writeFile(path.join(memDir, 'MEMORY.md'), content, 'utf-8');
      const result = await manager.loadIndex();
      expect(result).toBe(content);
    });

    it('should truncate content beyond maxIndexLines', async () => {
      const smallManager = new AutoMemoryManager(
        tmpDir,
        { enabled: true, maxIndexLines: 3 },
        memDir
      );
      await smallManager.initialize();
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      await fs.writeFile(path.join(memDir, 'MEMORY.md'), lines.join('\n'), 'utf-8');

      const result = await smallManager.loadIndex();
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
      expect(result).toContain('Line 3');
      expect(result).not.toContain('Line 4');
      expect(result).toContain('7 more lines');
    });

    it('should return null when disabled', async () => {
      const disabledManager = new AutoMemoryManager(
        tmpDir,
        { enabled: false, maxIndexLines: 200 },
        memDir
      );
      await disabledManager.initialize();
      await fs.writeFile(path.join(memDir, 'MEMORY.md'), '# Memory', 'utf-8');
      const result = await disabledManager.loadIndex();
      expect(result).toBeNull();
    });
  });

  describe('readTopic / writeTopic', () => {
    it('should return null for non-existent topic', async () => {
      const result = await manager.readTopic('nonexistent');
      expect(result).toBeNull();
    });

    it('should write and read a topic (overwrite)', async () => {
      await manager.writeTopic(
        'debugging',
        '## Redis issue\nNeed local Redis.',
        'overwrite'
      );
      const result = await manager.readTopic('debugging');
      expect(result).toBe('## Redis issue\nNeed local Redis.');
    });

    it('should append to existing topic', async () => {
      await manager.writeTopic('patterns', 'Pattern 1\n', 'overwrite');
      await manager.writeTopic('patterns', 'Pattern 2\n', 'append');
      const result = await manager.readTopic('patterns');
      expect(result).toContain('Pattern 1');
      expect(result).toContain('Pattern 2');
    });

    it('should append to non-existent topic (creates file)', async () => {
      await manager.writeTopic('new-topic', 'First entry', 'append');
      const result = await manager.readTopic('new-topic');
      expect(result).toBe('First entry');
    });

    it('should handle .md extension in topic name', async () => {
      await manager.writeTopic('test.md', 'content', 'overwrite');
      const result = await manager.readTopic('test');
      expect(result).toBe('content');
    });
  });

  describe('updateIndex', () => {
    it('should create MEMORY.md with overwrite', async () => {
      await manager.updateIndex('# Project Memory\n\n- Build: bun run build');
      const result = await manager.readTopic('MEMORY');
      expect(result).toContain('# Project Memory');
    });

    it('should append to existing MEMORY.md', async () => {
      await manager.updateIndex('# Memory\n', 'overwrite');
      await manager.updateIndex('- New entry\n', 'append');
      const result = await manager.readTopic('MEMORY');
      expect(result).toContain('# Memory');
      expect(result).toContain('- New entry');
    });
  });

  describe('appendUniqueEntries', () => {
    it('normalizes and deduplicates entries while keeping topic order stable', async () => {
      const result = await manager.appendUniqueEntries(
        new Map([
          ['lessons', ['Second lesson']],
          ['debugging', ['First fix', 'First   fix', 'Another fix']],
        ])
      );

      expect(result).toEqual({
        written: 3,
        duplicate: 1,
        topics: ['debugging', 'lessons'],
      });
      const debugging = await manager.readTopic('debugging');
      expect(debugging).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] First fix$/m);
      expect(debugging).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] Another fix$/m);
      expect(debugging?.match(/First fix/g)).toHaveLength(1);
    });

    it('does not rewrite files when every entry already exists', async () => {
      await manager.appendUniqueEntries(new Map([['debugging', ['Stable fix']]]));
      const topicPath = path.join(memDir, 'debugging.md');
      const indexPath = path.join(memDir, 'MEMORY.md');
      const before = {
        topic: await fs.stat(topicPath),
        index: await fs.stat(indexPath),
      };

      const result = await manager.appendUniqueEntries(
        new Map([['debugging', [' Stable   fix ']]])
      );
      const after = {
        topic: await fs.stat(topicPath),
        index: await fs.stat(indexPath),
      };

      expect(result).toEqual({ written: 0, duplicate: 1, topics: [] });
      expect(after.topic.ino).toBe(before.topic.ino);
      expect(after.index.ino).toBe(before.index.ino);
    });

    it('maintains one managed index block without changing user-authored content', async () => {
      const userContent = '# Project Memory\n\nKeep this paragraph exactly.\n';
      await manager.updateIndex(userContent, 'overwrite');

      await manager.appendUniqueEntries(
        new Map([
          ['lessons', ['One lesson']],
          ['debugging', ['One fix']],
        ])
      );
      await manager.appendUniqueEntries(new Map([['debugging', ['Second fix']]]));

      const index = await manager.readTopic('MEMORY');
      expect(index?.startsWith(userContent)).toBe(true);
      expect(index?.match(/blade:auto-memory-topics:start/g)).toHaveLength(1);
      expect(index?.match(/\[debugging\]\(debugging\.md\)/g)).toHaveLength(1);
      expect(index?.match(/\[lessons\]\(lessons\.md\)/g)).toHaveLength(1);
      expect(index?.indexOf('[debugging]')).toBeLessThan(
        index?.indexOf('[lessons]') ?? 0
      );
    });

    it('writes private topic and index files', async () => {
      await manager.appendUniqueEntries(new Map([['debugging', ['Private fix']]]));

      expect((await fs.stat(path.join(memDir, 'debugging.md'))).mode & 0o777).toBe(
        0o600
      );
      expect((await fs.stat(path.join(memDir, 'MEMORY.md'))).mode & 0o777).toBe(0o600);
    });

    it('serializes path aliases in the current process', async () => {
      const aliasManager = new AutoMemoryManager(
        tmpDir,
        undefined,
        path.join(memDir, '.')
      );

      await Promise.all([
        manager.appendUniqueEntries(new Map([['debugging', ['First writer']]])),
        aliasManager.appendUniqueEntries(new Map([['debugging', ['Second writer']]])),
      ]);

      const content = await manager.readTopic('debugging');
      expect(content).toContain('First writer');
      expect(content).toContain('Second writer');
    });

    it('serializes writers from separate processes without losing updates', async () => {
      await fs.mkdir(memDir, { recursive: true });

      await Promise.all([
        execFileAsync('bun', [concurrentWriter, memDir, 'debugging', 'Child first']),
        execFileAsync('bun', [concurrentWriter, memDir, 'debugging', 'Child second']),
      ]);

      const content = await manager.readTopic('debugging');
      const index = await manager.readTopic('MEMORY');
      expect(content).toContain('Child first');
      expect(content).toContain('Child second');
      expect(index?.match(/\[debugging\]\(debugging\.md\)/g)).toHaveLength(1);
    });

    it('fails within a bounded interval when another process owns the lock', async () => {
      await fs.mkdir(memDir, { recursive: true });
      const release = await lockfile.lock(memDir, { realpath: false });
      const startedAt = Date.now();

      try {
        await expect(
          manager.appendUniqueEntries(new Map([['debugging', ['Blocked write']]]))
        ).rejects.toMatchObject({ code: 'ELOCKED' });
        expect(Date.now() - startedAt).toBeLessThan(5_000);
      } finally {
        await release();
      }
    });
  });

  describe('listTopics', () => {
    it('should return empty array when no files exist', async () => {
      const topics = await manager.listTopics();
      expect(topics).toEqual([]);
    });

    it('should list all .md files', async () => {
      await manager.writeTopic('MEMORY', '# Index', 'overwrite');
      await manager.writeTopic('debugging', '## Debug', 'overwrite');
      await manager.writeTopic('patterns', '## Patterns', 'overwrite');

      const topics = await manager.listTopics();
      const names = topics.map((t) => t.name);
      expect(names).toContain('MEMORY');
      expect(names).toContain('debugging');
      expect(names).toContain('patterns');
      expect(topics.length).toBe(3);
    });

    it('should include size and lastModified', async () => {
      await manager.writeTopic('test', 'hello world', 'overwrite');
      const topics = await manager.listTopics();
      expect(topics[0].size).toBeGreaterThan(0);
      expect(topics[0].lastModified).toBeInstanceOf(Date);
    });

    it('should propagate non-ENOENT filesystem failures', async () => {
      await fs.writeFile(memDir, 'not a directory', 'utf-8');

      await expect(manager.listTopics()).rejects.toMatchObject({ code: 'EEXIST' });
    });
  });

  describe('deleteTopic', () => {
    it('should delete existing topic', async () => {
      await manager.writeTopic('temp', 'temporary', 'overwrite');
      const deleted = await manager.deleteTopic('temp');
      expect(deleted).toBe(true);
      const result = await manager.readTopic('temp');
      expect(result).toBeNull();
    });

    it('should return false for non-existent topic', async () => {
      const deleted = await manager.deleteTopic('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('should remove all memory files', async () => {
      await manager.writeTopic('MEMORY', '# Index', 'overwrite');
      await manager.writeTopic('debugging', '## Debug', 'overwrite');
      await manager.writeTopic('patterns', '## Patterns', 'overwrite');

      const count = await manager.clearAll();
      expect(count).toBe(3);

      const topics = await manager.listTopics();
      expect(topics).toEqual([]);
    });

    it('should return 0 when no files exist', async () => {
      const count = await manager.clearAll();
      expect(count).toBe(0);
    });
  });

  describe('path traversal protection', () => {
    it('should sanitize path separators in topic name', async () => {
      await manager.writeTopic('../../../etc/passwd', 'malicious', 'overwrite');
      const topics = await manager.listTopics();
      expect(topics.length).toBe(1);
      const filePath = path.join(memDir, topics[0].name + '.md');
      expect(filePath.startsWith(memDir)).toBe(true);
    });

    it('should sanitize special characters', async () => {
      await manager.writeTopic('test:file*name', 'content', 'overwrite');
      const topics = await manager.listTopics();
      expect(topics.length).toBe(1);
      expect(topics[0].name).not.toContain(':');
      expect(topics[0].name).not.toContain('*');
    });
  });
});
