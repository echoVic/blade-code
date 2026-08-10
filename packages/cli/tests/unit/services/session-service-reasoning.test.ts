import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService durable reasoning effort', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-reasoning-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-reasoning-workspace-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  it('persists, updates, and forks the Session-owned selection', async () => {
    const created = await SessionService.createSessionMetadata(
      'reasoning-parent',
      workspace,
      {
        taskStatus: 'completed',
        selectedModelId: 'reasoning-model',
        reasoningEffort: 'low',
      }
    );
    expect(created.reasoningEffort).toBe('low');

    const updated = await SessionService.updateSessionMetadata(
      created.sessionId,
      workspace,
      { reasoningEffort: 'high' }
    );
    expect(updated.reasoningEffort).toBe('high');
    await expect(
      SessionService.findSessionMetadata(created.sessionId, workspace)
    ).resolves.toMatchObject({ reasoningEffort: 'high' });

    const fork = await SessionService.forkSession(created.sessionId, {
      sourceProjectPath: workspace,
      targetProjectPath: workspace,
      newSessionId: 'reasoning-child',
    });
    expect(fork.metadata.reasoningEffort).toBe('high');

    const transcript = await readFile(
      getSessionFilePath(workspace, created.sessionId),
      'utf8'
    );
    expect(transcript).toContain('"reasoningEffort":"low"');
    expect(transcript).toContain('"reasoningEffort":"high"');
  });

  it('rejects unknown values before appending an event', async () => {
    const created = await SessionService.createSessionMetadata(
      'reasoning-invalid',
      workspace,
      { taskStatus: 'completed' }
    );
    const filePath = getSessionFilePath(workspace, created.sessionId);
    const before = await readFile(filePath, 'utf8');
    await expect(
      SessionService.updateSessionMetadata(created.sessionId, workspace, {
        reasoningEffort: 'ultra',
      } as never)
    ).rejects.toThrow('Invalid session reasoning effort');
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });
});
