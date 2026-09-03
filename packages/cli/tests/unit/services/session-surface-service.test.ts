import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../src/acp/AcpRemoteWorkspace.js';
import {
  __setAcpRemoteWorkspaceReferenceHooksForTesting,
  getAcpRemoteWorkspaceReferenceFilePath,
} from '../../../src/acp/AcpRemoteWorkspaceReference.js';
import { AcpServiceContext } from '../../../src/acp/AcpServiceContext.js';
import { Agent } from '../../../src/agent/Agent.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import {
  type SessionLocatorV2,
  SessionSurfaceCatalogPageSchema,
  SessionSurfaceHistoryPageSchema,
  SessionSurfaceOpenResultSchema,
} from '../../../src/api/sessionSurfaceSchemas.js';
import { SessionEventLog } from '../../../src/context/events/SessionEventLog.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import * as storagePaths from '../../../src/context/storage/pathUtils.js';
import {
  getAcpRemoteSessionFilePath,
  getSessionFilePath,
} from '../../../src/context/storage/pathUtils.js';
import type { SqliteDb } from '../../../src/context/storage/sqlite/driver.js';
import { openDb } from '../../../src/context/storage/sqlite/driver.js';
import {
  __resetProjectionIOForTesting,
  __setProjectionIOForTesting,
  readSessionSurfaceCandidates,
  readSessionSurfaceCatalogRevision,
} from '../../../src/context/storage/sqlite/projection.js';
import { migrate } from '../../../src/context/storage/sqlite/schema.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { PluginRegistry } from '../../../src/plugins/PluginRegistry.js';
import { WebBrowserSessionRegistry } from '../../../src/server/WebBrowserSessionRegistry.js';
import { LocalFileSystemService } from '../../../src/services/FileSystemService.js';
import {
  __resetSessionSnapshotIOForTesting,
  __setSessionSnapshotIOForTesting,
  SessionService,
} from '../../../src/services/SessionService.js';
import {
  SessionSurfaceService,
  SessionSurfaceServiceError,
} from '../../../src/services/SessionSurfaceService.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';

const timestamp = '2026-09-02T00:00:00.000Z';

function messageEvents(
  sessionId: string,
  projectPath: string,
  messageId: string,
  role: 'user' | 'assistant',
  content: string,
  seconds: number
): SessionEvent[] {
  const createdAt = `2026-09-02T00:00:${String(seconds).padStart(2, '0')}.000Z`;
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
      id: `part-event-${messageId}`,
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

describe('SessionSurfaceService', () => {
  let storageRoot: string;
  let localWorkspace: string;
  let database: SqliteDb;
  let service: SessionSurfaceService;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-surface-service-'));
    localWorkspace = path.join(storageRoot, 'workspace');
    await mkdir(localWorkspace, { recursive: true });
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const opened = await openDb(path.join(storageRoot, 'surface.db'));
    if (!opened) throw new Error('SQLite is unavailable');
    database = opened;
    migrate(database);
    service = new SessionSurfaceService({ database });
  });

  afterEach(async () => {
    __setAcpRemoteWorkspaceReferenceHooksForTesting(undefined);
    vi.restoreAllMocks();
    __resetProjectionIOForTesting();
    __resetSessionSnapshotIOForTesting();
    await service.close();
    database.close();
    delete process.env.BLADE_STORAGE_ROOT;
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('lists local and remote rows with opaque compound locators and lifecycle isolation', async () => {
    const sessionId = 'shared-surface-session';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Surface\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await SessionService.createSessionMetadata(sessionId, localWorkspace, {
      title: 'Local surface',
      taskStatus: 'completed',
    });
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      { title: 'Remote surface', taskStatus: 'completed' }
    );

    const first = await service.listPage({ archived: false, limit: 1 });
    SessionSurfaceCatalogPageSchema.parse(first);
    expect(first.sessions).toHaveLength(1);
    expect(first.nextCursor).toMatch(/^session-surface-catalog:/);
    expect(first.nextCursor).not.toContain(localWorkspace);
    expect(first.nextCursor).not.toContain(hostStateRoot);

    const second = await service.listPage({
      archived: false,
      cursor: first.nextCursor,
      limit: 1,
    });
    const sessions = [...first.sessions, ...second.sessions];
    expect(sessions).toHaveLength(2);
    expect(
      new Set(sessions.map((session) => JSON.stringify(session.locator))).size
    ).toBe(2);
    expect(
      sessions.find((session) => session.locator.workspace.kind === 'local')
    ).toMatchObject({
      displayCwd: localWorkspace,
      capabilities: { connection: 'local', history: { read: true, fork: true } },
    });
    expect(
      sessions.find((session) => session.locator.workspace.kind === 'acp-remote')
    ).toMatchObject({
      displayCwd: descriptor.wirePath,
      pathStyle: 'win32',
      capabilities: {
        connection: 'offline',
        history: { read: true, fork: true },
        turn: { start: false, reason: 'history-only' },
        files: { readText: false, writeText: false, browse: 'none' },
        terminal: { mode: 'none', owner: 'none' },
      },
    });
    const serialized = JSON.stringify(sessions);
    expect(serialized).not.toContain(hostStateRoot);
    expect(serialized).not.toContain(descriptor.exactIdentity);
    expect(serialized).not.toContain(descriptor.collisionIdentity);

    const restarted = new SessionSurfaceService({ database });
    await expect(
      restarted.listPage({
        archived: false,
        cursor: first.nextCursor,
        limit: 1,
      })
    ).rejects.toMatchObject({ code: 'session_surface_cursor_invalid' });
    await restarted.close();

    await service.close('PRIVATE_CLOSE_REASON');
    await expect(service.listPage({ archived: false })).rejects.toEqual(
      expect.objectContaining({
        code: 'session_surface_unavailable',
        message: expect.not.stringContaining('PRIVATE_CLOSE_REASON'),
      })
    );
  });

  it('returns not found for a remote locator after its public reference rotates', async () => {
    const sessionId = 'rotated-surface-session';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Remote\\Rotated')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      { title: 'Rotated surface', taskStatus: 'completed' }
    );
    const firstCatalog = await service.listPage({
      archived: false,
      workspaceKind: 'acp-remote',
    });
    const oldLocator = firstCatalog.sessions.find(
      (entry) => entry.locator.sessionId === sessionId
    )?.locator;
    expect(oldLocator?.workspace.kind).toBe('acp-remote');
    if (!oldLocator || oldLocator.workspace.kind !== 'acp-remote') {
      throw new Error('Expected the initial remote locator');
    }

    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await unlink(getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor));
    });
    const replacementCatalog = await service.listPage({
      archived: false,
      workspaceKind: 'acp-remote',
    });
    const replacement = replacementCatalog.sessions.find(
      (entry) => entry.locator.sessionId === sessionId
    );
    expect(replacement?.locator.workspace.kind).toBe('acp-remote');
    expect(replacement?.locator).not.toEqual(oldLocator);

    await expect(service.open(oldLocator)).rejects.toMatchObject({
      code: 'session_surface_not_found',
    });
  });

  it('opens bounded history and rejects stale or parameter-mismatched cursors', async () => {
    const sessionId = 'history-surface-session';
    await SessionService.createSessionMetadata(sessionId, localWorkspace, {
      title: 'History',
      taskStatus: 'completed',
    });
    const filePath = getSessionFilePath(localWorkspace, sessionId);
    await new JSONLStore(filePath).appendBatch([
      ...messageEvents(sessionId, localWorkspace, 'message-one', 'user', 'one', 1),
      ...messageEvents(sessionId, localWorkspace, 'message-two', 'assistant', 'two', 2),
    ]);
    const locator = {
      version: 2 as const,
      sessionId,
      workspace: { kind: 'local' as const, projectPath: localWorkspace },
    };

    const opened = await service.open(locator, { limit: 1 });
    SessionSurfaceOpenResultSchema.parse(opened);
    expect(opened.history.messages.map((message) => message.content)).toEqual(['two']);
    expect(opened.history.olderCursor).toMatch(/^session-surface-history:/);
    expect(opened.history.snapshot).toMatch(/^session-surface-snapshot:/);

    const older = await service.historyPage(locator, {
      cursor: opened.history.olderCursor!,
      expectedSnapshot: opened.history.snapshot,
      limit: 1,
    });
    SessionSurfaceHistoryPageSchema.parse(older);
    expect(older.messages.map((message) => message.content)).toEqual(['one']);
    expect(
      await service.historyPage(locator, {
        cursor: opened.history.olderCursor!,
        expectedSnapshot: opened.history.snapshot,
        limit: 1,
      })
    ).toEqual(older);
    await expect(
      service.historyPage(locator, {
        cursor: opened.history.olderCursor!,
        expectedSnapshot: opened.history.snapshot,
        limit: 2,
      })
    ).rejects.toMatchObject({ code: 'session_surface_cursor_invalid' });

    await new JSONLStore(filePath).appendBatch(
      messageEvents(sessionId, localWorkspace, 'message-three', 'user', 'three', 3)
    );
    await expect(
      service.historyPage(locator, {
        cursor: opened.history.olderCursor!,
        expectedSnapshot: opened.history.snapshot,
        limit: 1,
      })
    ).rejects.toMatchObject({ code: 'session_surface_snapshot_changed' });
  });

  it('resolves and forks remote history without exposing or mutating the source root', async () => {
    const sessionId = 'remote-history-session';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/surface')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      {
        title:
          'Remote history ' +
          descriptor.wirePath +
          '/private ' +
          descriptor.exactIdentity +
          'suffix',
        taskStatus: 'completed',
      }
    );
    const sourcePath = await withValidatedAcpRemoteStateScope(
      hostStateRoot,
      async (scope) => getAcpRemoteSessionFilePath(scope, sessionId)
    );
    await new JSONLStore(sourcePath).appendBatch(
      messageEvents(
        sessionId,
        hostStateRoot,
        'remote-message',
        'user',
        'Read ' +
          descriptor.wirePath +
          '/inputs/source.txt before ' +
          descriptor.collisionIdentity +
          'suffix',
        1
      )
    );
    const remoteSummary = (
      await service.listPage({ archived: false, workspaceKind: 'acp-remote' })
    ).sessions[0]!;
    const sourceBytes = await readFile(sourcePath);
    const runtimeCreate = vi.spyOn(SessionRuntime, 'create');
    const agentCreate = vi.spyOn(Agent, 'create');
    const agentCreateWithRuntime = vi.spyOn(Agent, 'createWithRuntime');
    const browserGet = vi.spyOn(WebBrowserSessionRegistry.prototype, 'get');
    const eventLogFor = vi.spyOn(SessionEventLog, 'for');
    const hookGet = vi.spyOn(HookManager, 'getInstance');
    const pluginGet = vi.spyOn(PluginRegistry, 'getInstance');
    const skillGet = vi.spyOn(SkillRegistry, 'getInstance');
    const fileSystemGet = vi.spyOn(AcpServiceContext.prototype, 'getFileSystemService');
    const terminalGet = vi.spyOn(AcpServiceContext.prototype, 'getTerminalService');
    const localRead = vi.spyOn(LocalFileSystemService.prototype, 'readTextFile');
    const gitBranch = vi.spyOn(storagePaths, 'detectGitBranch');

    const opened = await service.open(remoteSummary.locator);
    expect(opened.session.displayCwd).toBe(descriptor.wirePath);
    expect(opened.session.title).toBe(
      'Remote history [private state path] [private state path]suffix'
    );
    expect(opened.history.messages[0]?.content).toBe(
      'Read [private state path] before [private state path]suffix'
    );
    expect(JSON.stringify(opened)).not.toContain(descriptor.wirePath + '/private');
    expect(JSON.stringify(opened.history)).not.toContain(descriptor.wirePath);
    expect(JSON.stringify(opened)).not.toContain(descriptor.exactIdentity);
    expect(JSON.stringify(opened)).not.toContain(descriptor.collisionIdentity);
    expect(JSON.stringify(opened)).not.toContain(hostStateRoot);
    const forked = await service.fork(remoteSummary.locator);
    expect(forked.session.locator.workspace.kind).toBe('acp-remote');
    expect(forked.session.parentId).toBe(sessionId);
    expect(forked.session.capabilities).toMatchObject({
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'history-only',
      },
      terminal: { mode: 'none', owner: 'none', reason: 'history-only' },
    });
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
    for (const forbiddenCall of [
      runtimeCreate,
      agentCreate,
      agentCreateWithRuntime,
      browserGet,
      eventLogFor,
      hookGet,
      pluginGet,
      skillGet,
      fileSystemGet,
      terminalGet,
      localRead,
      gitBranch,
    ]) {
      expect(forbiddenCall).not.toHaveBeenCalled();
    }
  });

  it('keeps the history surface source isolated from interactive execution modules', () => {
    const cliRoot = path.resolve(import.meta.dirname, '../../..');
    const surfaceSource = readFileSync(
      path.join(cliRoot, 'src/services/SessionSurfaceService.ts'),
      'utf8'
    );
    for (const forbidden of [
      'SessionRuntime',
      'SessionEventLog',
      'WebBrowserSessionRegistry',
      'SessionBrowserRuntime',
      'HookManager',
      'PluginRegistry',
      'SkillRegistry',
      'getFileSystemService',
      'getTerminalService',
      'detectGitBranch',
      'TerminalRoutes',
    ]) {
      expect(surfaceSource, forbidden).not.toContain(forbidden);
    }

    const sessionServiceSource = readFileSync(
      path.join(cliRoot, 'src/services/SessionService.ts'),
      'utf8'
    );
    const remoteForkStart = sessionServiceSource.indexOf(
      'private static async forkRemoteSession('
    );
    const remoteForkEnd = sessionServiceSource.indexOf(
      'private static async findRemoteArchivedAncestor(',
      remoteForkStart
    );
    const remoteForkSource = sessionServiceSource.slice(remoteForkStart, remoteForkEnd);
    expect(remoteForkStart).toBeGreaterThan(0);
    expect(remoteForkEnd).toBeGreaterThan(remoteForkStart);
    for (const forbidden of [
      'detectGitBranch(',
      'removeBrowserSessionArtifacts(',
      'SessionRuntime',
      'SessionEventLog',
      'getFileSystemService',
      'getTerminalService',
    ]) {
      expect(remoteForkSource, forbidden).not.toContain(forbidden);
    }

    const projectionSource = readFileSync(
      path.join(cliRoot, 'src/context/storage/sqlite/projection.ts'),
      'utf8'
    );
    const remoteEmptyStart = projectionSource.indexOf(
      "if (sourceKind === 'acp-remote' && raw.length === 0)"
    );
    const remoteEmptyEnd = projectionSource.indexOf(
      "throw new AcpRemoteWorkspaceStateError('remote-session-empty')",
      remoteEmptyStart
    );
    const remoteEmptySource = projectionSource.slice(remoteEmptyStart, remoteEmptyEnd);
    const emptyCatch = remoteEmptySource.indexOf('catch (error)');
    const abortGate = remoteEmptySource.indexOf(
      'if (signal?.aborted) throw error;',
      emptyCatch
    );
    const deleteTransaction = remoteEmptySource.indexOf('db.transaction(', emptyCatch);
    expect(remoteEmptyStart).toBeGreaterThan(0);
    expect(remoteEmptyEnd).toBeGreaterThan(remoteEmptyStart);
    expect(abortGate).toBeGreaterThan(emptyCatch);
    expect(deleteTransaction).toBeGreaterThan(abortGate);

    for (const internalType of [
      'ValidatedRemoteSurfaceCandidate',
      'ValidatedLocalSurfaceCandidate',
      'ValidatedSessionSurfaceSnapshot',
    ]) {
      expect(sessionServiceSource).not.toContain(`export interface ${internalType}`);
    }
    expect(sessionServiceSource).not.toContain('readonly metadata: SessionMetadata;');

    const internalOperations = [
      'readValidatedLocalSurfaceSnapshot',
      'readValidatedRemoteSurfaceSnapshot',
      'listValidatedRemoteSurfaceCandidates',
      'listValidatedLocalSurfaceCandidates',
    ];
    const allowedConsumers = new Set([
      'src/services/SessionService.ts',
      'src/services/SessionSurfaceService.ts',
    ]);
    const sourceRoot = path.join(cliRoot, 'src');
    const sourceFiles = readdirSync(sourceRoot, {
      recursive: true,
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      )
      .map((entry) => path.join(entry.parentPath, entry.name));
    for (const operation of internalOperations) {
      const consumers = sourceFiles
        .filter((filePath) => readFileSync(filePath, 'utf8').includes(operation))
        .map((filePath) => path.relative(cliRoot, filePath));
      expect(consumers, operation).toEqual(
        expect.arrayContaining([...allowedConsumers])
      );
      expect(consumers.every((consumer) => allowedConsumers.has(consumer))).toBe(true);
    }
  });

  it('uses fixed redacted errors for malformed locators', async () => {
    const malformed: SessionLocatorV2 = {
      version: 2,
      sessionId: '../private-session',
      workspace: { kind: 'local', projectPath: storageRoot },
    };
    let thrown: unknown;
    try {
      await service.open(malformed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionSurfaceServiceError);
    expect(thrown).toMatchObject({ code: 'invalid_session_locator' });
    expect(String(thrown)).not.toContain('../private-session');
    expect(String(thrown)).not.toContain(storageRoot);
    expect(timestamp).toBeTruthy();
  });

  it('rejects a protected remote state root disguised as a local locator', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/disguised-local')
    );
    const protectedRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const locator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'disguised-local-session',
      workspace: { kind: 'local', projectPath: protectedRoot },
    };
    const readLocal = vi.spyOn(SessionService, 'readValidatedLocalSurfaceSnapshot');
    const forkLocal = vi.spyOn(SessionService, 'forkSession');

    await expect(service.open(locator)).rejects.toMatchObject({
      code: 'invalid_session_locator',
    });
    await expect(service.fork(locator)).rejects.toMatchObject({
      code: 'invalid_session_locator',
    });
    expect(readLocal).not.toHaveBeenCalled();
    expect(forkLocal).not.toHaveBeenCalled();
  });

  it('falls back to bounded JSONL catalog and history when SQLite is unavailable', async () => {
    const localSessionId = 'fallback-local-session';
    const remoteSessionId = 'fallback-remote-session';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Fallback\\Repo')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await SessionService.createSessionMetadata(localSessionId, localWorkspace, {
      title: 'Local fallback',
      taskStatus: 'completed',
    });
    await new JSONLStore(
      getSessionFilePath(localWorkspace, localSessionId)
    ).appendBatch(
      messageEvents(
        localSessionId,
        localWorkspace,
        'fallback-local-message',
        'user',
        'local',
        1
      )
    );
    await SessionService.createRemoteSessionMetadata(
      remoteSessionId,
      hostStateRoot,
      descriptor,
      {
        title: `Remote fallback ${descriptor.wirePath}/private`,
        taskStatus: 'completed',
      }
    );
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await new JSONLStore(
        getAcpRemoteSessionFilePath(scope, remoteSessionId)
      ).appendBatch(
        messageEvents(
          remoteSessionId,
          hostStateRoot,
          'fallback-remote-message',
          'user',
          `Read ${descriptor.wirePath}/inputs/source.txt through fallback`,
          2
        )
      );
    });
    const fallback = new SessionSurfaceService({ database: null });

    const first = await fallback.listPage({ archived: false, limit: 1 });
    expect(first.nextCursor).toMatch(/^session-surface-catalog:/);
    const second = await fallback.listPage({
      archived: false,
      cursor: first.nextCursor,
      limit: 1,
    });
    const summaries = [...first.sessions, ...second.sessions];
    expect(summaries).toHaveLength(2);
    expect(JSON.stringify({ first, second })).not.toContain(hostStateRoot);
    expect(JSON.stringify({ first, second })).not.toContain(descriptor.exactIdentity);

    const local = summaries.find(
      (summary) => summary.locator.workspace.kind === 'local'
    )!;
    const remote = summaries.find(
      (summary) => summary.locator.workspace.kind === 'acp-remote'
    )!;
    expect(remote.displayCwd).toBe(descriptor.wirePath);
    expect(remote.title).toBe('Remote fallback [private state path]');
    const openedRemote = await fallback.open(remote.locator, { limit: 1 });
    expect(openedRemote.history.messages.map((message) => message.content)).toEqual([
      'Read [private state path] through fallback',
    ]);
    const opened = await fallback.open(local.locator, { limit: 1 });
    expect(opened.history.messages.map((message) => message.content)).toEqual([
      'local',
    ]);
    const fallbackFile = getSessionFilePath(localWorkspace, localSessionId);
    await new JSONLStore(fallbackFile).appendBatch([
      ...messageEvents(
        localSessionId,
        localWorkspace,
        'fallback-local-message-two',
        'assistant',
        'second',
        2
      ),
      ...messageEvents(
        localSessionId,
        localWorkspace,
        'fallback-local-message-three',
        'user',
        'third',
        3
      ),
    ]);
    const paged = await fallback.open(local.locator, { limit: 1 });
    expect(paged.history.messages.map((message) => message.content)).toEqual(['third']);
    const older = await fallback.historyPage(local.locator, {
      cursor: paged.history.olderCursor!,
      expectedSnapshot: paged.history.snapshot,
      limit: 1,
    });
    expect(older.messages.map((message) => message.content)).toEqual(['second']);
    expect(older.olderCursor).toMatch(/^session-surface-history:/);
    await fallback.close();
  });

  it('reuses one bounded cursor chain across fallback catalog pages', async () => {
    for (const sessionId of [
      'fallback-chain-a',
      'fallback-chain-b',
      'fallback-chain-c',
    ]) {
      await SessionService.createSessionMetadata(sessionId, localWorkspace, {
        title: sessionId,
        taskStatus: 'completed',
      });
    }
    const fallback = new SessionSurfaceService({
      database: null,
      cursorRegistryOptions: { limits: { maxChains: 1 } },
    });

    try {
      const first = await fallback.listPage({ archived: false, limit: 1 });
      const second = await fallback.listPage({
        archived: false,
        cursor: first.nextCursor,
        limit: 1,
      });
      const third = await fallback.listPage({
        archived: false,
        cursor: second.nextCursor,
        limit: 1,
      });

      expect([first, second, third].flatMap((page) => page.sessions)).toHaveLength(3);
      expect(third.nextCursor).toBeUndefined();

      const nextChain = await fallback.listPage({ archived: false, limit: 1 });
      expect(nextChain.nextCursor).toMatch(/^session-surface-catalog:/);
    } finally {
      await fallback.close();
    }
  });

  it('keeps archived fallback history readable while rejecting its fork as read only', async () => {
    const sessionId = 'fallback-archived-session';
    await SessionService.createSessionMetadata(sessionId, localWorkspace, {
      title: 'Archived fallback',
      taskStatus: 'completed',
    });
    await new JSONLStore(getSessionFilePath(localWorkspace, sessionId)).appendBatch([
      ...messageEvents(
        sessionId,
        localWorkspace,
        'fallback-archived-one',
        'user',
        'one',
        1
      ),
      ...messageEvents(
        sessionId,
        localWorkspace,
        'fallback-archived-two',
        'assistant',
        'two',
        2
      ),
    ]);
    await SessionService.archiveSession(sessionId, localWorkspace);
    const fallback = new SessionSurfaceService({ database: null });

    try {
      const catalog = await fallback.listPage({ archived: true });
      const archived = catalog.sessions.find(
        (session) => session.locator.sessionId === sessionId
      );
      expect(archived).toMatchObject({
        archivedAt: expect.any(String),
        capabilities: { history: { read: true, fork: false } },
      });

      const opened = await fallback.open(archived!.locator, { limit: 1 });
      expect(opened.history.messages.map((message) => message.content)).toEqual([
        'two',
      ]);
      const older = await fallback.historyPage(archived!.locator, {
        cursor: opened.history.olderCursor!,
        expectedSnapshot: opened.history.snapshot,
        limit: 1,
      });
      expect(older.messages.map((message) => message.content)).toEqual(['one']);
      await expect(fallback.fork(archived!.locator)).rejects.toMatchObject({
        code: 'session_surface_read_only',
      });
    } finally {
      await fallback.close();
    }
  });

  it('forks an active local session through the JSONL fallback', async () => {
    const sessionId = 'fallback-fork-session';
    await SessionService.createSessionMetadata(sessionId, localWorkspace, {
      title: 'Fallback fork',
      taskStatus: 'completed',
    });
    const fallback = new SessionSurfaceService({ database: null });

    try {
      const catalog = await fallback.listPage({
        archived: false,
        workspaceKind: 'local',
      });
      const source = catalog.sessions.find(
        (session) => session.locator.sessionId === sessionId
      );
      const forked = await fallback.fork(source!.locator);

      expect(forked.session).toMatchObject({
        parentId: sessionId,
        relationType: 'fork',
        capabilities: { history: { read: true, fork: true } },
      });
      expect(forked.session.locator.workspace).toEqual({
        kind: 'local',
        projectPath: localWorkspace,
      });
    } finally {
      await fallback.close();
    }
  });

  it('enforces bounded admission and close waits for active work before redacted rejection', async () => {
    const sessionId = 'lifecycle-surface-session';
    await SessionService.createSessionMetadata(sessionId, localWorkspace, {
      taskStatus: 'completed',
    });
    let releaseRead = (): void => undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let readAborted = (): void => undefined;
    const aborted = new Promise<void>((resolve) => {
      readAborted = resolve;
    });
    __setProjectionIOForTesting({
      async readSession(store, _remoteScope, signal) {
        readStarted();
        signal.addEventListener('abort', readAborted, { once: true });
        await aborted;
        expect(signal.aborted).toBe(true);
        await cleanup;
        return store.readAll();
      },
    });
    const bounded = new SessionSurfaceService({
      database,
      maxConcurrentOperations: 1,
    });
    const active = bounded.listPage({ archived: false });
    await started;
    await expect(bounded.listPage({ archived: false })).rejects.toMatchObject({
      code: 'session_surface_capacity',
      retryable: true,
    });

    let closeSettled = false;
    const closing = bounded.close('PRIVATE_CLOSE_REASON').then(() => {
      closeSettled = true;
    });
    await aborted;
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseRead();
    await expect(active).rejects.toMatchObject({
      code: 'session_surface_unavailable',
      message: expect.not.stringContaining('PRIVATE_CLOSE_REASON'),
    });
    await closing;
  });

  it('aborts an in-flight fallback snapshot read before close settles', async () => {
    const sessionId = 'fallback-abort-session';
    await SessionService.createSessionMetadata(sessionId, localWorkspace, {
      taskStatus: 'completed',
    });
    let readStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let readAborted = (): void => undefined;
    const aborted = new Promise<void>((resolve) => {
      readAborted = resolve;
    });
    __setSessionSnapshotIOForTesting({
      stat(filePath) {
        return stat(filePath, { bigint: true });
      },
      async readFile(_filePath, signal) {
        expect(signal?.aborted).toBe(false);
        readStarted();
        signal?.addEventListener('abort', readAborted, { once: true });
        await aborted;
        signal?.throwIfAborted();
        return '';
      },
    });
    const fallback = new SessionSurfaceService({ database: null });
    const active = fallback.listPage({ archived: false });
    await started;

    const closing = fallback.close('PRIVATE_CLOSE_REASON');
    await aborted;
    await expect(active).rejects.toMatchObject({
      code: 'session_surface_unavailable',
      message: expect.not.stringContaining('PRIVATE_CLOSE_REASON'),
    });
    await expect(closing).resolves.toBeUndefined();
  });

  it('aborts remote fallback scanning without reading the next transcript', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/abort-scan')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await SessionService.createRemoteSessionMetadata(
      'remote-abort-a',
      hostStateRoot,
      descriptor,
      { taskStatus: 'completed' }
    );
    await SessionService.createRemoteSessionMetadata(
      'remote-abort-b',
      hostStateRoot,
      descriptor,
      { taskStatus: 'completed' }
    );
    let readCount = 0;
    let readStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let readAborted = (): void => undefined;
    const aborted = new Promise<void>((resolve) => {
      readAborted = resolve;
    });
    __setSessionSnapshotIOForTesting({
      stat(filePath) {
        return stat(filePath, { bigint: true });
      },
      async readFile(_filePath, signal) {
        readCount += 1;
        readStarted();
        signal?.addEventListener('abort', readAborted, { once: true });
        await aborted;
        signal?.throwIfAborted();
        return '';
      },
    });
    const fallback = new SessionSurfaceService({ database: null });
    const active = fallback.listPage({
      archived: false,
      workspaceKind: 'acp-remote',
    });
    await started;

    const closing = fallback.close();
    await aborted;
    await expect(active).rejects.toMatchObject({
      code: 'session_surface_unavailable',
    });
    await expect(closing).resolves.toBeUndefined();
    expect(readCount).toBe(1);
  });

  it('does not commit a remote projection after close aborts during reference publication', async () => {
    const sessionId = 'remote-abort-before-projection-write';
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/abort-before-write')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      { taskStatus: 'completed' }
    );
    let publicationStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    let releasePublication = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    __setAcpRemoteWorkspaceReferenceHooksForTesting({
      async beforePublish() {
        publicationStarted();
        await blocked;
      },
    });
    const revisionBefore = readSessionSurfaceCatalogRevision(database);
    const active = service.listPage({
      archived: false,
      workspaceKind: 'acp-remote',
    });
    await started;

    const closing = service.close();
    releasePublication();
    await expect(active).rejects.toMatchObject({
      code: 'session_surface_unavailable',
    });
    await expect(closing).resolves.toBeUndefined();
    expect(readSessionSurfaceCatalogRevision(database)).toBe(revisionBefore);
    expect(readSessionSurfaceCandidates(database, sessionId)).toEqual([]);
  });
});
