import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { SessionService } from '../../../src/services/SessionService.js';

const timestamp = '2026-08-09T00:00:00.000Z';

function events(sessionId: string, projectPath: string): SessionEvent[] {
  return [
    {
      id: 'created',
      sessionId,
      timestamp,
      type: 'session_created',
      cwd: projectPath,
      version: 'test',
      data: {
        sessionId,
        rootId: sessionId,
        title: 'Portable evidence',
        taskStatus: 'completed',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    {
      id: 'user-message',
      sessionId,
      timestamp,
      type: 'message_created',
      cwd: projectPath,
      version: 'test',
      data: {
        messageId: 'user',
        role: 'user',
        createdAt: timestamp,
      },
    },
    {
      id: 'user-text',
      sessionId,
      timestamp,
      type: 'part_created',
      cwd: projectPath,
      version: 'test',
      data: {
        partId: 'user-text',
        messageId: 'user',
        partType: 'text',
        payload: { text: 'Export this conversation' },
        createdAt: timestamp,
      },
    },
    {
      id: 'assistant-message',
      sessionId,
      timestamp,
      type: 'message_created',
      cwd: projectPath,
      version: 'test',
      data: {
        messageId: 'assistant',
        role: 'assistant',
        createdAt: timestamp,
      },
    },
    {
      id: 'assistant-reasoning',
      sessionId,
      timestamp,
      type: 'part_created',
      cwd: projectPath,
      version: 'test',
      data: {
        partId: 'reasoning',
        messageId: 'assistant',
        partType: 'reasoning',
        payload: { text: 'reasoning evidence' },
        createdAt: timestamp,
      },
    },
    {
      id: 'assistant-text',
      sessionId,
      timestamp,
      type: 'part_created',
      cwd: projectPath,
      version: 'test',
      data: {
        partId: 'assistant-text',
        messageId: 'assistant',
        partType: 'text',
        payload: { text: 'Export completed' },
        createdAt: timestamp,
      },
    },
  ];
}

describe('SessionService Markdown export', () => {
  let storageRoot: string;
  let projectPath: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-export-'));
    projectPath = await mkdtemp(path.join(os.tmpdir(), 'blade-export-project-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(projectPath, { recursive: true, force: true }),
    ]);
  });

  it('exports a stable exact-workspace snapshot and supports archived sessions', async () => {
    const sessionId = 'export-session';
    const filePath = getSessionFilePath(projectPath, sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await new JSONLStore(filePath).createExclusive(events(sessionId, projectPath));

    const hidden = await SessionService.exportSessionMarkdown(sessionId, projectPath);
    expect(hidden.markdown).toContain('Export this conversation');
    expect(hidden.markdown).toContain('Export completed');
    expect(hidden.markdown).not.toContain('reasoning evidence');
    expect(hidden.markdown).toContain('- State: active');

    const visible = await SessionService.exportSessionMarkdown(sessionId, projectPath, {
      includeReasoning: true,
    });
    expect(visible.markdown).toContain('reasoning evidence');

    await SessionService.archiveSession(sessionId, projectPath);
    const archived = await SessionService.exportSessionMarkdown(sessionId, projectPath);
    expect(archived.markdown).toContain('- State: archived');
    expect(archived.contentSha256).toBe(hidden.contentSha256);
  });

  it('fails closed for the wrong workspace and missing conversations', async () => {
    const sessionId = 'foreign-export';
    const filePath = getSessionFilePath(projectPath, sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await new JSONLStore(filePath).createExclusive(events(sessionId, projectPath));
    const other = await mkdtemp(path.join(os.tmpdir(), 'blade-export-other-'));
    try {
      await expect(
        SessionService.exportSessionMarkdown(sessionId, other)
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
