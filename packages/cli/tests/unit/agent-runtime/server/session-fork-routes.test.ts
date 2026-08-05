import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForkSessionResponseSchema } from '../../../../src/api/schemas.js';
import { JSONLStore } from '../../../../src/context/storage/JSONLStore.js';
import { PersistentStore } from '../../../../src/context/storage/PersistentStore.js';
import { getSessionFilePath } from '../../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../../src/context/types.js';
import { SessionService } from '../../../../src/services/SessionService.js';

async function writeTranscript(
  workspace: string,
  sessionId: string,
  entries: SessionEvent[]
): Promise<void> {
  const filePath = getSessionFilePath(workspace, sessionId);
  await new JSONLStore(filePath).createExclusive(entries);
}

describe('BladeServer session fork route', () => {
  let storageRoot: string;
  let workspace: string;
  let otherWorkspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-fork-route-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-fork-route-workspace-'));
    otherWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-fork-route-other-workspace-')
    );
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
      rm(otherWorkspace, { recursive: true, force: true }),
    ]);
  });

  it('forks a durable transcript over the real HTTP server without mutating the parent', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const store = new PersistentStore(workspace, 100, 'test');
    await store.saveMessage('parent-session', 'user', 'Remember FORK_VALUE');
    await store.saveMessage('parent-session', 'assistant', 'READY');
    const parentPath = getSessionFilePath(workspace, 'parent-session');
    const parentBeforeFork = await readFile(parentPath, 'utf-8');
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const response = await fetch(`${server.url}sessions/parent-session/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      const parsed = ForkSessionResponseSchema.parse(body);
      expect(parsed.session).toMatchObject({
        projectPath: workspace,
        rootId: 'parent-session',
        parentId: 'parent-session',
        relationType: 'fork',
      });
      expect(JSON.stringify(parsed.session)).not.toContain('.jsonl');
      expect(parsed.messages).toEqual([
        { role: 'user', content: 'Remember FORK_VALUE' },
        { role: 'assistant', content: 'READY' },
      ]);
      expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);

      const childMessagesResponse = await fetch(
        `${server.url}sessions/${parsed.session.sessionId}/message?projectPath=${encodeURIComponent(
          workspace
        )}`
      );
      expect(childMessagesResponse.status).toBe(200);
      await expect(childMessagesResponse.json()).resolves.toEqual([
        { role: 'user', content: 'Remember FORK_VALUE' },
        { role: 'assistant', content: 'READY' },
      ]);
    } finally {
      await server.stop();
    }
  });

  it('rejects invalid source ids and invalid projectPath before filesystem access', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const findSpy = vi.spyOn(SessionService, 'findSessionMetadata');
    const forkSpy = vi.spyOn(SessionService, 'forkSession');
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const invalidIdResponse = await fetch(
        `${server.url}sessions/%2E%2E%2Fescape/fork`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath: workspace }),
        }
      );
      expect(invalidIdResponse.status).toBe(400);

      const relativePathResponse = await fetch(
        `${server.url}sessions/parent-session/fork`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectPath: './relative' }),
        }
      );
      expect(relativePathResponse.status).toBe(400);

      const missingBodyResponse = await fetch(
        `${server.url}sessions/parent-session/fork`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      expect(missingBodyResponse.status).toBe(400);

      expect(findSpy).not.toHaveBeenCalled();
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('returns 404 when the exact workspace and session id pair is missing', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const store = new PersistentStore(otherWorkspace, 100, 'test');
    await store.saveMessage('parent-session', 'user', 'other workspace only');
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const response = await fetch(`${server.url}sessions/parent-session/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'NOT_FOUND' },
      });
    } finally {
      await server.stop();
    }
  });

  it('maps missing durable creation records to conflict without leaking paths', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    await writeTranscript(workspace, 'parent-session', [
      {
        id: 'parent-message',
        sessionId: 'parent-session',
        timestamp: '2024-01-01T00:00:01.000Z',
        type: 'message_created',
        cwd: workspace,
        gitBranch: 'main',
        version: 'test',
        data: {
          messageId: 'parent-message',
          role: 'user',
          createdAt: '2024-01-01T00:00:01.000Z',
        },
      },
    ]);
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const response = await fetch(`${server.url}sessions/parent-session/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'CONFLICT',
          message: 'Session has no durable creation record',
        },
      });
    } finally {
      await server.stop();
    }
  });

  it('maps unexpected fork I/O errors to a generic internal error', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const { SessionService: CurrentSessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    const store = new PersistentStore(workspace, 100, 'test');
    await store.saveMessage('parent-session', 'user', 'history');
    vi.spyOn(CurrentSessionService, 'forkSession').mockRejectedValueOnce(
      Object.assign(
        new Error(`EACCES: permission denied, open ${workspace}/secret.jsonl`),
        {
          code: 'EACCES',
        }
      )
    );
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const response = await fetch(`${server.url}sessions/parent-session/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace }),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fork session',
        },
      });
      expect(JSON.stringify(body)).not.toContain(workspace);
      expect(JSON.stringify(body)).not.toContain('.jsonl');
      expect(JSON.stringify(body)).not.toContain('API_KEY');
    } finally {
      await server.stop();
    }
  });

  it('does not resolve or move the source transcript from a different workspace', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const sourceStore = new PersistentStore(workspace, 100, 'test');
    await sourceStore.saveMessage('parent-session', 'user', 'source history');
    const parentPath = getSessionFilePath(workspace, 'parent-session');
    const parentBeforeFork = await readFile(parentPath, 'utf-8');
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const response = await fetch(`${server.url}sessions/parent-session/fork`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: otherWorkspace }),
      });

      expect(response.status).toBe(404);
      expect(await readFile(parentPath, 'utf-8')).toBe(parentBeforeFork);
    } finally {
      await server.stop();
    }
  });
});
