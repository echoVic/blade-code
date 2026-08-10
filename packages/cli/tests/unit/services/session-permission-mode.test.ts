import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService durable permission mode', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-mode-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-mode-workspace-'));
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

  it('persists the latest Session-owned mode and inherits it across forks', async () => {
    const created = await SessionService.createSessionMetadata(
      'mode-parent',
      workspace,
      {
        taskStatus: 'completed',
        permissionMode: 'autoEdit',
      }
    );
    expect(created.permissionMode).toBe('autoEdit');

    const updated = await SessionService.setSessionPermissionMode(
      created.sessionId,
      workspace,
      'yolo'
    );
    expect(updated.permissionMode).toBe('yolo');

    const fork = await SessionService.forkSession(created.sessionId, {
      sourceProjectPath: workspace,
      targetProjectPath: workspace,
      newSessionId: 'mode-child',
    });
    expect(fork.metadata.permissionMode).toBe('yolo');

    const transcript = await readFile(
      getSessionFilePath(workspace, created.sessionId),
      'utf8'
    );
    expect(transcript).toContain('"permissionMode":"autoEdit"');
    expect(transcript).toContain('"permissionMode":"yolo"');
  });

  it('creates missing metadata once and does not append duplicate mode updates', async () => {
    const created = await SessionService.setSessionPermissionMode(
      'mode-new',
      workspace,
      'plan'
    );
    expect(created).toMatchObject({
      sessionId: 'mode-new',
      permissionMode: 'plan',
      taskStatus: 'completed',
    });

    const filePath = getSessionFilePath(workspace, created.sessionId);
    const before = await readFile(filePath, 'utf8');
    await expect(
      SessionService.setSessionPermissionMode('mode-new', workspace, 'plan')
    ).resolves.toMatchObject({ permissionMode: 'plan' });
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  it('rejects unknown values before appending an event', async () => {
    const created = await SessionService.createSessionMetadata(
      'mode-invalid',
      workspace,
      { taskStatus: 'completed' }
    );
    const filePath = getSessionFilePath(workspace, created.sessionId);
    const before = await readFile(filePath, 'utf8');
    await expect(
      SessionService.updateSessionMetadata(created.sessionId, workspace, {
        permissionMode: 'unrestricted',
      } as never)
    ).rejects.toThrow('Invalid session permission mode');
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });
});
