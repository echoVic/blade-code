import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import {
  SessionSurfaceCatalogPageSchema,
  type SessionSurfaceErrorCode,
  SessionSurfaceErrorEnvelopeSchema,
  SessionSurfaceHistoryPageSchema,
  SessionSurfaceOpenResultSchema,
} from '../../../../src/api/sessionSurfaceSchemas.js';
import { JSONLStore } from '../../../../src/context/storage/JSONLStore.js';
import {
  getAcpRemoteSessionFilePath,
  getSessionFilePath,
} from '../../../../src/context/storage/pathUtils.js';
import type { SqliteDb } from '../../../../src/context/storage/sqlite/driver.js';
import { openDb } from '../../../../src/context/storage/sqlite/driver.js';
import { migrate } from '../../../../src/context/storage/sqlite/schema.js';
import type { SessionEvent } from '../../../../src/context/types.js';
import { SessionService } from '../../../../src/services/SessionService.js';
import {
  SessionSurfaceService,
  SessionSurfaceServiceError,
} from '../../../../src/services/SessionSurfaceService.js';

function messageEvents(
  sessionId: string,
  projectPath: string,
  messageId: string,
  role: 'user' | 'assistant',
  content: string,
  seconds: number
): SessionEvent[] {
  const createdAt = `2026-09-03T00:00:${String(seconds).padStart(2, '0')}.000Z`;
  return [
    {
      id: `event-${messageId}`,
      sessionId,
      projectPath,
      timestamp: createdAt,
      type: 'message_created',
      cwd: projectPath,
      version: 'test',
      data: { messageId, role, createdAt },
    },
    {
      id: `part-${messageId}`,
      sessionId,
      projectPath,
      timestamp: createdAt,
      type: 'part_created',
      cwd: projectPath,
      version: 'test',
      data: {
        partId: `part-${messageId}`,
        messageId,
        partType: 'text',
        payload: { text: content },
        createdAt,
      },
    },
  ];
}

async function createLocalSession(
  workspace: string,
  sessionId: string,
  title: string
): Promise<void> {
  await SessionService.createSessionMetadata(sessionId, workspace, {
    title,
    taskStatus: 'completed',
  });
  await new JSONLStore(getSessionFilePath(workspace, sessionId)).appendBatch([
    ...messageEvents(sessionId, workspace, `${sessionId}-one`, 'user', 'one', 1),
    ...messageEvents(sessionId, workspace, `${sessionId}-two`, 'assistant', 'two', 2),
  ]);
}

describe('SessionSurfaceRouteController', () => {
  let storageRoot: string;
  let workspace: string;
  let database: SqliteDb;
  let service: SessionSurfaceService;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-surface-route-store-'));
    workspace = path.join(storageRoot, 'workspace');
    await mkdir(workspace, { recursive: true });
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const opened = await openDb(path.join(storageRoot, 'surface.db'));
    if (!opened) throw new Error('SQLite is unavailable');
    database = opened;
    migrate(database);
    service = new SessionSurfaceService({ database });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.close().catch(() => undefined);
    database.close();
    delete process.env.BLADE_STORAGE_ROOT;
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('serves catalog, open, history, and fork through the v2 surface controller', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    await createLocalSession(workspace, 'surface-route-session', 'Surface Route');
    const controller = createSessionSurfaceRouteController({ database });

    try {
      const catalogResponse = await controller.app.request('/catalog?limit=1');
      expect(catalogResponse.status).toBe(200);
      const catalog = SessionSurfaceCatalogPageSchema.parse(
        await catalogResponse.json()
      );
      expect(catalog.sessions).toHaveLength(1);
      expect(catalog.sessions[0]?.displayCwd).toBe(workspace);

      const openResponse = await controller.app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locator: catalog.sessions[0]?.locator,
          limit: 1,
        }),
      });
      expect(openResponse.status).toBe(200);
      const opened = SessionSurfaceOpenResultSchema.parse(await openResponse.json());
      expect(opened.history.messages.map((message) => message.content)).toEqual([
        'two',
      ]);
      expect(opened.history.snapshot).toMatch(/^session-surface-snapshot:/);

      const historyResponse = await controller.app.request('/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locator: catalog.sessions[0]?.locator,
          cursor: opened.history.olderCursor,
          expectedSnapshot: opened.history.snapshot,
          limit: 1,
        }),
      });
      expect(historyResponse.status).toBe(200);
      const older = SessionSurfaceHistoryPageSchema.parse(await historyResponse.json());
      expect(older.messages.map((message) => message.content)).toEqual(['one']);

      const forkResponse = await controller.app.request('/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locator: catalog.sessions[0]?.locator,
        }),
      });
      expect(forkResponse.status).toBe(200);
      const forked = SessionSurfaceOpenResultSchema.parse(await forkResponse.json());
      expect(forked.session.parentId).toBe('surface-route-session');
      expect(forked.history.messages).toHaveLength(2);
    } finally {
      await controller.shutdown();
    }
  });

  it('serves remote history and fork without exposing protected identity fields', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const sessionId = 'remote-surface-route-session';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Private\\Remote\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      { title: 'Remote Route', taskStatus: 'completed' }
    );
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await new JSONLStore(getAcpRemoteSessionFilePath(scope, sessionId)).appendBatch(
        messageEvents(
          sessionId,
          hostStateRoot,
          'remote-route-message',
          'user',
          'remote-visible',
          1
        )
      );
    });
    const controller = createSessionSurfaceRouteController({ database });

    try {
      const catalogResponse = await controller.app.request(
        '/catalog?workspaceKind=acp-remote'
      );
      expect(catalogResponse.status).toBe(200);
      const catalog = SessionSurfaceCatalogPageSchema.parse(
        await catalogResponse.json()
      );
      const remote = catalog.sessions.find(
        (session) => session.locator.sessionId === sessionId
      );
      expect(remote?.locator.workspace.kind).toBe('acp-remote');

      const openResponse = await controller.app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locator: remote?.locator }),
      });
      const opened = SessionSurfaceOpenResultSchema.parse(await openResponse.json());
      expect(opened.history.messages[0]?.content).toBe('remote-visible');

      const forkResponse = await controller.app.request('/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locator: remote?.locator }),
      });
      const forked = SessionSurfaceOpenResultSchema.parse(await forkResponse.json());
      expect(forked.session.locator.workspace.kind).toBe('acp-remote');
      expect(forked.session.capabilities.turn).toEqual({
        start: false,
        reason: 'history-only',
      });

      const publicWire = JSON.stringify({
        catalog,
        opened,
        forked,
        catalogContentType: catalogResponse.headers.get('content-type'),
        openContentType: openResponse.headers.get('content-type'),
        forkContentType: forkResponse.headers.get('content-type'),
      });
      expect(publicWire).not.toContain(hostStateRoot);
      expect(publicWire).not.toContain(descriptor.exactIdentity);
      expect(publicWire).not.toContain(descriptor.collisionIdentity);
      expect(publicWire).not.toContain('remoteWorkspace');
    } finally {
      await controller.shutdown();
    }
  });

  it('rejects unknown and duplicate query/body fields with the fixed request envelope', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const controller = createSessionSurfaceRouteController({ database });

    try {
      const duplicateQuery = await controller.app.request('/catalog?limit=1&limit=2');
      expect(duplicateQuery.status).toBe(400);
      await expect(duplicateQuery.json()).resolves.toEqual({
        error: {
          code: 'invalid_session_surface_request',
          message: 'Session surface request is invalid',
          retryable: false,
        },
      });

      const unknownQuery = await controller.app.request('/catalog?limit=1&extra=1');
      expect(unknownQuery.status).toBe(400);
      SessionSurfaceErrorEnvelopeSchema.parse(await unknownQuery.json());

      const duplicateBody = await controller.app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"locator":{"version":2,"sessionId":"surface-route-session","workspace":{"kind":"local","projectPath":${JSON.stringify(
          workspace
        )}}},"locator":{"version":2,"sessionId":"shadow","workspace":{"kind":"local","projectPath":${JSON.stringify(
          workspace
        )}}}}`,
      });
      expect(duplicateBody.status).toBe(400);
      await expect(duplicateBody.json()).resolves.toEqual({
        error: {
          code: 'invalid_session_surface_request',
          message: 'Session surface request is invalid',
          retryable: false,
        },
      });

      const unknownBody = await controller.app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locator: {
            version: 2,
            sessionId: 'surface-route-session',
            workspace: { kind: 'local', projectPath: workspace },
          },
          extra: true,
        }),
      });
      expect(unknownBody.status).toBe(400);
      SessionSurfaceErrorEnvelopeSchema.parse(await unknownBody.json());

      const nestedDuplicate = await controller.app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"locator":{"version":2,"sessionId":"surface-route-session","workspace":{"kind":"local","kind":"acp-remote","projectPath":${JSON.stringify(
          workspace
        )}}}}`,
      });
      expect(nestedDuplicate.status).toBe(400);

      const postQuery = await controller.app.request('/fork?unexpected=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locator: {
            version: 2,
            sessionId: 'surface-route-session',
            workspace: { kind: 'local', projectPath: workspace },
          },
        }),
      });
      expect(postQuery.status).toBe(400);

      const invalidJson = await controller.app.request('/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"locator":',
      });
      expect(invalidJson.status).toBe(400);
    } finally {
      await controller.shutdown();
    }
  });

  it('stops reading a streaming request body once the 64 KiB limit is exceeded', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const service = {
      listPage: vi.fn(),
      open: vi.fn(),
      historyPage: vi.fn(),
      fork: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const controller = createSessionSurfaceRouteController({ service });
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls += 1;
        if (pulls <= 5) {
          stream.enqueue(new Uint8Array(32 * 1024));
        } else {
          stream.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body,
      duplex: 'half',
    };

    try {
      const response = await controller.app.fetch(
        new Request('http://localhost/open', requestInit)
      );
      expect(response.status).toBe(400);
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(6);
      expect(service.open).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
    }
  });

  it('rejects reserved property names at every request object boundary', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const controller = createSessionSurfaceRouteController({ database });
    const locator = {
      version: 2,
      sessionId: 'surface-route-session',
      workspace: { kind: 'local', projectPath: workspace },
    } as const;
    const reservedKeys = ['__proto__', 'constructor', 'prototype'] as const;

    try {
      for (const key of reservedKeys) {
        const queryResponse = await controller.app.request(
          '/catalog?' + key + '=shadow'
        );
        expect(queryResponse.status).toBe(400);
        expect(
          SessionSurfaceErrorEnvelopeSchema.parse(await queryResponse.json())
        ).toMatchObject({ error: { code: 'invalid_session_surface_request' } });

        const bodyRootResponse = await controller.app.request('/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ locator, [key]: 'shadow' }),
        });
        expect(bodyRootResponse.status).toBe(400);
        expect(
          SessionSurfaceErrorEnvelopeSchema.parse(await bodyRootResponse.json())
        ).toMatchObject({ error: { code: 'invalid_session_surface_request' } });

        const locatorResponse = await controller.app.request('/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            locator: { ...locator, [key]: 'shadow' },
          }),
        });
        expect(locatorResponse.status).toBe(400);
        expect(
          SessionSurfaceErrorEnvelopeSchema.parse(await locatorResponse.json())
        ).toMatchObject({ error: { code: 'invalid_session_locator' } });

        const workspaceResponse = await controller.app.request('/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            locator: {
              ...locator,
              workspace: { ...locator.workspace, [key]: 'shadow' },
            },
          }),
        });
        expect(workspaceResponse.status).toBe(400);
        expect(
          SessionSurfaceErrorEnvelopeSchema.parse(await workspaceResponse.json())
        ).toMatchObject({ error: { code: 'invalid_session_locator' } });
      }
    } finally {
      await controller.shutdown();
    }
  });

  it('maps a malformed locator at the HTTP boundary without invoking the service', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const open = vi.fn();
    const controller = createSessionSurfaceRouteController({
      service: {
        listPage: vi.fn(),
        open,
        historyPage: vi.fn(),
        fork: vi.fn(),
        close: vi.fn(async () => undefined),
      },
    });

    try {
      const response = await controller.app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locator: {
            version: 2,
            sessionId: '',
            workspace: { kind: 'local', projectPath: workspace },
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_session_locator',
          message: 'Session locator is invalid',
          retryable: false,
        },
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
    }
  });

  it.each([
    ['invalid_session_surface_request', 400],
    ['invalid_session_locator', 400],
    ['session_surface_not_found', 404],
    ['workspace_binding_mismatch', 409],
    ['session_surface_cursor_invalid', 400],
    ['session_surface_snapshot_changed', 409],
    ['session_surface_read_only', 409],
    ['session_surface_capability_unavailable', 403],
    ['session_surface_capacity', 429],
    ['session_surface_unavailable', 503],
    ['session_surface_state_invalid', 500],
  ] as const)('maps %s to the fixed envelope and status %i', async (code, status) => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const controller = createSessionSurfaceRouteController({
      logger,
      service: {
        listPage: vi.fn(async () => {
          throw new SessionSurfaceServiceError(code);
        }),
        open: vi.fn(),
        historyPage: vi.fn(),
        fork: vi.fn(),
        close: vi.fn(async () => undefined),
      },
    });

    try {
      const response = await controller.app.request('/catalog');
      expect(response.status).toBe(status);
      expect(SessionSurfaceErrorEnvelopeSchema.parse(await response.json())).toEqual({
        error: {
          code,
          message: new SessionSurfaceServiceError(code).message,
          retryable: new SessionSurfaceServiceError(code).retryable,
        },
      });
    } finally {
      await controller.shutdown();
    }
  });

  it('logs locator failures with a bounded digest instead of raw identity', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const rawSessionId = 'private-session-identity';
    const rawProjectPath = `${workspace}/private/project/path`;
    const controller = createSessionSurfaceRouteController({
      logger,
      service: {
        listPage: vi.fn(),
        open: vi.fn(async () => {
          throw new SessionSurfaceServiceError('session_surface_not_found');
        }),
        historyPage: vi.fn(),
        fork: vi.fn(),
        close: vi.fn(async () => undefined),
      },
    });

    try {
      const response = await controller.app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locator: {
            version: 2,
            sessionId: rawSessionId,
            workspace: { kind: 'local', projectPath: rawProjectPath },
          },
        }),
      });

      expect(response.status).toBe(404);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[SessionSurfaceRoutes] method=POST path=\/open code=session_surface_not_found kind=local locator=[0-9a-f]{16}$/
        )
      );
      const logged = JSON.stringify(logger.warn.mock.calls);
      expect(logged).not.toContain(rawSessionId);
      expect(logged).not.toContain(rawProjectPath);
    } finally {
      await controller.shutdown();
    }
  });

  it('validates outgoing responses and logs only bounded locator digests for failures', async () => {
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };
    const rawProjectPath = `${workspace}/private/raw/path`;
    const controller = createSessionSurfaceRouteController({
      logger,
      service: {
        listPage: vi.fn(async () => ({
          sessions: [
            {
              locator: {
                version: 2,
                sessionId: 'surface-route-session',
                workspace: { kind: 'local', projectPath: rawProjectPath },
              },
              displayCwd: rawProjectPath,
              taskStatus: 'completed',
              messageCount: 0,
              firstMessageTime: '2026-09-03T00:00:00.000Z',
              lastMessageTime: '2026-09-03T00:00:00.000Z',
              hasErrors: false,
              capabilities: {},
            },
          ],
        })),
        open: vi.fn(),
        historyPage: vi.fn(),
        fork: vi.fn(),
        close: vi.fn(async () => undefined),
      },
    });

    try {
      const response = await controller.app.request('/catalog');
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'session_surface_state_invalid',
          message: 'Session surface state is invalid',
          retryable: false,
        },
      });
      const logged = JSON.stringify([
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ]);
      expect(logged).toContain('/catalog');
      expect(logged).toContain('session_surface_state_invalid');
      expect(logged).not.toContain(rawProjectPath);
      expect(logged).not.toContain('surface-route-session');
      expect(logged).not.toContain('displayCwd');
    } finally {
      await controller.shutdown();
    }
  });

  it('keeps the V2 route module isolated from interactive execution surfaces', () => {
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../../../src/server/routes/sessionSurface.ts'
      ),
      'utf8'
    );
    for (const forbidden of [
      '/agent/',
      '/browser/',
      '/hooks/',
      '/plugins/',
      '/skills/',
      '/tools/builtin/file',
      '/tools/builtin/shell',
      '/worktree/',
      'hono/streaming',
      'server/bus',
      'node:child_process',
      './session.js',
      './terminal.js',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
