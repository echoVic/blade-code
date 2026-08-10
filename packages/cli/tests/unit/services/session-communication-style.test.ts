import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService durable communication style', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-style-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-style-workspace-'));
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
      'style-parent',
      workspace,
      {
        taskStatus: 'completed',
        selectedModelId: 'gpt',
        communicationStyle: 'pragmatic',
      }
    );
    expect(created.communicationStyle).toBe('pragmatic');

    const updated = await SessionService.updateSessionMetadata(
      created.sessionId,
      workspace,
      {
        communicationStyle: 'project:strict-review',
        communicationStyleDigest: 'a'.repeat(64),
      }
    );
    expect(updated.communicationStyle).toBe('project:strict-review');
    expect(updated.communicationStyleDigest).toBe('a'.repeat(64));
    const fork = await SessionService.forkSession(created.sessionId, {
      sourceProjectPath: workspace,
      targetProjectPath: workspace,
      newSessionId: 'style-child',
    });
    expect(fork.metadata.communicationStyle).toBe('project:strict-review');
    expect(fork.metadata.communicationStyleDigest).toBe('a'.repeat(64));
    const cleared = await SessionService.updateSessionMetadata(
      created.sessionId,
      workspace,
      {
        communicationStyle: 'explanatory',
        communicationStyleDigest: null,
      }
    );
    expect(cleared.communicationStyle).toBe('explanatory');
    expect(cleared.communicationStyleDigest).toBeUndefined();

    const transcript = await readFile(
      getSessionFilePath(workspace, created.sessionId),
      'utf8'
    );
    expect(transcript).toContain('"communicationStyle":"pragmatic"');
    expect(transcript).toContain('"communicationStyle":"project:strict-review"');
    expect(transcript).toContain(`"communicationStyleDigest":"${'a'.repeat(64)}"`);
  });

  it('rejects unknown values before appending an event', async () => {
    const created = await SessionService.createSessionMetadata(
      'style-invalid',
      workspace,
      { taskStatus: 'completed' }
    );
    const filePath = getSessionFilePath(workspace, created.sessionId);
    const before = await readFile(filePath, 'utf8');
    await expect(
      SessionService.updateSessionMetadata(created.sessionId, workspace, {
        communicationStyle: 'learning',
      } as never)
    ).rejects.toThrow('Invalid session communication style');
    await expect(
      SessionService.updateSessionMetadata(created.sessionId, workspace, {
        communicationStyleDigest: 'not-a-digest',
      })
    ).rejects.toThrow('Invalid session communication style digest');
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });
});
