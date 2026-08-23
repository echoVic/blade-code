import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextManager } from '../../src/context/ContextManager.js';
import { getSessionFilePath } from '../../src/context/storage/pathUtils.js';
import { SessionService } from '../../src/services/SessionService.js';

describe('durable compaction checkpoint recovery', () => {
  let storageRoot: string;
  let workspace: string;
  const sessionId = 'compaction-checkpoint';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-compaction-checkpoint-'));
    workspace = path.join(storageRoot, 'workspace');
    await mkdir(workspace, { recursive: true });
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('keeps the visible transcript while restoring only replacement context', async () => {
    const contextManager = new ContextManager({ projectPath: workspace });
    await contextManager.saveMessage(sessionId, 'user', 'oversized request');
    await contextManager.saveMessage(sessionId, 'assistant', 'oversized answer');

    const replacementMessages = [
      {
        role: 'user' as const,
        content: 'durable compacted summary',
        metadata: { isCompactSummary: true },
      },
      { role: 'user' as const, content: 'active task checkpoint' },
    ];
    await contextManager.saveCompaction(sessionId, 'durable compacted summary', {
      trigger: 'auto',
      reason: 'context_limit',
      strategy: 'llm',
      preTokens: 120_000,
      postTokens: 2_000,
      sampleAttempts: 2,
      filesIncluded: ['src/runtime.ts'],
      replacementMessages,
    });
    await contextManager.saveMessage(
      sessionId,
      'assistant',
      'continued after recovery'
    );

    const visible = await SessionService.loadSession(sessionId, workspace);
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'oversized request' }),
        expect.objectContaining({ content: 'oversized answer' }),
        expect.objectContaining({ content: 'continued after recovery' }),
      ])
    );
    await expect(
      SessionService.loadSessionModelContext(sessionId, workspace)
    ).resolves.toEqual([
      ...replacementMessages,
      { role: 'assistant', content: 'continued after recovery' },
    ]);

    const persisted = await readFile(getSessionFilePath(workspace, sessionId), 'utf8');
    const checkpoint = persisted
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find(
        (event) => event.type === 'part_created' && event.data.partType === 'summary'
      );
    expect(checkpoint.data.payload).toMatchObject({
      text: 'durable compacted summary',
      metadata: {
        checkpointVersion: 1,
        reason: 'context_limit',
        strategy: 'llm',
        preTokens: 120_000,
        postTokens: 2_000,
        sampleAttempts: 2,
      },
      replacementMessages,
    });
  });
});
