import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService durable provider service tier', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-tier-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-tier-workspace-'));
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
      'tier-parent',
      workspace,
      {
        taskStatus: 'completed',
        selectedModelId: 'gpt',
        serviceTier: 'fast',
      }
    );
    expect(created.serviceTier).toBe('fast');

    const updated = await SessionService.updateSessionMetadata(
      created.sessionId,
      workspace,
      { serviceTier: 'standard' }
    );
    expect(updated.serviceTier).toBe('standard');
    const fork = await SessionService.forkSession(created.sessionId, {
      sourceProjectPath: workspace,
      targetProjectPath: workspace,
      newSessionId: 'tier-child',
    });
    expect(fork.metadata.serviceTier).toBe('standard');

    const transcript = await readFile(
      getSessionFilePath(workspace, created.sessionId),
      'utf8'
    );
    expect(transcript).toContain('"serviceTier":"fast"');
    expect(transcript).toContain('"serviceTier":"standard"');
  });

  it('rejects unknown values before appending an event', async () => {
    const created = await SessionService.createSessionMetadata(
      'tier-invalid',
      workspace,
      { taskStatus: 'completed' }
    );
    const filePath = getSessionFilePath(workspace, created.sessionId);
    const before = await readFile(filePath, 'utf8');
    await expect(
      SessionService.updateSessionMetadata(created.sessionId, workspace, {
        serviceTier: 'turbo',
      } as never)
    ).rejects.toThrow('Invalid session service tier');
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });
});
