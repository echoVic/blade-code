/**
 * MemoryReadTool / MemoryWriteTool 单元测试
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectStoragePath } from '../../../../src/context/storage/pathUtils.js';
import { AutoMemoryManager } from '../../../../src/memory/AutoMemoryManager.js';
import { memoryReadTool } from '../../../../src/tools/builtin/memory/MemoryReadTool.js';
import { memoryWriteTool } from '../../../../src/tools/builtin/memory/MemoryWriteTool.js';

describe('MemoryWriteTool', () => {
  let tmpDir: string;
  let manager: AutoMemoryManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-memtool-w-'));
    // manager 和工具都走 getProjectStoragePath(tmpDir) 映射
    manager = new AutoMemoryManager(tmpDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(getProjectStoragePath(tmpDir), { recursive: true, force: true });
  });

  it('should write a new topic file', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'debugging', content: '## Redis\nNeed local Redis.', mode: 'append' }
    );
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('memory/debugging.md');

    const content = await manager.readTopic('debugging');
    expect(content).toContain('Redis');
  });

  it('should append to existing topic', async () => {
    await memoryWriteTool.execute(
      { topic: 'patterns', content: 'Pattern 1\n', mode: 'overwrite' }
    );
    await memoryWriteTool.execute(
      { topic: 'patterns', content: 'Pattern 2\n', mode: 'append' }
    );

    const content = await manager.readTopic('patterns');
    expect(content).toContain('Pattern 1');
    expect(content).toContain('Pattern 2');
  });

  it('should overwrite existing topic', async () => {
    await memoryWriteTool.execute(
      { topic: 'test', content: 'old content', mode: 'overwrite' }
    );
    await memoryWriteTool.execute(
      { topic: 'test', content: 'new content', mode: 'overwrite' }
    );

    const content = await manager.readTopic('test');
    expect(content).toBe('new content');
  });

  it('should write to MEMORY.md index', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'MEMORY', content: '# Project Memory\n- Build: pnpm build', mode: 'overwrite' }
    );
    expect(result.success).toBe(true);

    const content = await manager.readTopic('MEMORY');
    expect(content).toContain('# Project Memory');
  });

  it('should reject content with password', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'secrets', content: 'password = abc123', mode: 'overwrite' }
    );
    expect(result.success).toBe(false);
    expect(result.llmContent).toContain('sensitive data');
  });

  it('should reject content with api_key', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'config', content: 'api_key = sk-1234567890', mode: 'overwrite' }
    );
    expect(result.success).toBe(false);
  });

  it('should reject content with token', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'auth', content: 'token = ghp_abc123', mode: 'overwrite' }
    );
    expect(result.success).toBe(false);
  });

  it('should reject content with secret', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'env', content: 'secret: my-secret-value', mode: 'overwrite' }
    );
    expect(result.success).toBe(false);
  });

  it('should reject content with private_key', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'keys', content: 'private_key content here', mode: 'overwrite' }
    );
    expect(result.success).toBe(false);
  });

  it('should allow content mentioning password in context', async () => {
    const result = await memoryWriteTool.execute(
      { topic: 'notes', content: 'The user forgot their password reset flow', mode: 'overwrite' }
    );
    expect(result.success).toBe(true);
  });
});

describe('MemoryReadTool', () => {
  let tmpDir: string;
  let manager: AutoMemoryManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-memtool-r-'));
    manager = new AutoMemoryManager(tmpDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(getProjectStoragePath(tmpDir), { recursive: true, force: true });
  });

  it('should read existing topic', async () => {
    await manager.writeTopic('debugging', '## Debug notes', 'overwrite');

    const result = await memoryReadTool.execute({ topic: 'debugging' });
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('Debug notes');
  });

  it('should return not found for missing topic', async () => {
    const result = await memoryReadTool.execute({ topic: 'nonexistent' });
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('not found');
  });

  it('should list all topics with _list', async () => {
    await manager.writeTopic('MEMORY', '# Index', 'overwrite');
    await manager.writeTopic('debugging', '## Debug', 'overwrite');

    const result = await memoryReadTool.execute({ topic: '_list' });
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('MEMORY.md');
    expect(result.llmContent).toContain('debugging.md');
  });

  it('should show empty message when no files for _list', async () => {
    const result = await memoryReadTool.execute({ topic: '_list' });
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('No memory files found');
  });

  it('should read MEMORY.md index', async () => {
    await manager.writeTopic('MEMORY', '# Project Memory\n- Build: pnpm build', 'overwrite');

    const result = await memoryReadTool.execute({ topic: 'MEMORY' });
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('# Project Memory');
  });
});
