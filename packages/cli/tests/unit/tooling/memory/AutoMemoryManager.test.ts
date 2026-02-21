/**
 * AutoMemoryManager 单元测试
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutoMemoryManager } from '../../../../src/memory/AutoMemoryManager.js';

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
      const content = '# Memory\n\n- Build: `pnpm build`\n- Test: `pnpm test`';
      await fs.writeFile(path.join(memDir, 'MEMORY.md'), content, 'utf-8');
      const result = await manager.loadIndex();
      expect(result).toBe(content);
    });

    it('should truncate content beyond maxIndexLines', async () => {
      const smallManager = new AutoMemoryManager(tmpDir, { enabled: true, maxIndexLines: 3 }, memDir);
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
      const disabledManager = new AutoMemoryManager(tmpDir, { enabled: false, maxIndexLines: 200 }, memDir);
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
      await manager.writeTopic('debugging', '## Redis issue\nNeed local Redis.', 'overwrite');
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
      await manager.updateIndex('# Project Memory\n\n- Build: pnpm build');
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
