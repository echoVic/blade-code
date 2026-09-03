import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { SocketReadyState } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../src/acp/AcpRemoteWorkspace.js';
import type { SessionSurfaceSummary } from '../../../src/api/sessionSurfaceSchemas.js';
import { JSONLStore } from '../../../src/context/storage/JSONLStore.js';
import { getAcpRemoteSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import type { SqliteDb } from '../../../src/context/storage/sqlite/driver.js';
import { openDb } from '../../../src/context/storage/sqlite/driver.js';
import {
  __resetProjectionIOForTesting,
  __setProjectionIOForTesting,
} from '../../../src/context/storage/sqlite/projection.js';
import { migrate } from '../../../src/context/storage/sqlite/schema.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { SessionSurfaceService } from '../../../src/services/SessionSurfaceService.js';
import { FocusId } from '../../../src/store/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { SessionHistoryViewer } from '../../../src/ui/components/SessionHistoryViewer.js';
import { SessionSelector } from '../../../src/ui/components/SessionSelector.js';
import type { ResolvedInput } from '../../../src/ui/hooks/useInputBuffer.js';
import { TerminalInputRouterProvider } from '../../../src/ui/input/TerminalInputRouter.js';
import { SessionHistoryController } from '../../../src/ui/services/SessionHistoryController.js';
import { dispatchSessionSurfaceSelection } from '../../../src/ui/utils/sessionActivation.js';
import { processSlashCommand } from '../../../src/ui/utils/slashCommandRouter.js';

const clipboard = vi.hoisted(() => ({
  copyTranscriptText: vi.fn<
    (text: string) => Promise<{ success: boolean; method: 'native' }>
  >(async () => ({ success: true, method: 'native' })),
}));

vi.mock('../../../src/ui/utils/clipboard.js', () => ({
  copyTranscriptText: clipboard.copyTranscriptText,
}));

class TestInputStream extends PassThrough {
  public isTTY = true;
  public isRaw = false;
  public isRawMode = false;
  public bytesRead = 0;
  public bytesWritten = 0;
  public connecting = false;
  public destroyed = false;
  public pending = false;
  public bufferSize = 0;
  public readyState: SocketReadyState = 'open';

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.isRawMode = mode;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

class TestOutputStream extends PassThrough {
  public columns = 120;
  public rows = 40;
  public isTTY = true;
  public output = '';
  public bytesRead = 0;
  public bytesWritten = 0;
  public connecting = false;
  public destroyed = false;
  public pending = false;
  public bufferSize = 0;
  public readyState: SocketReadyState = 'open';

  constructor() {
    super();
    this.on('data', (chunk: string | Buffer) => {
      this.output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
  }

  clearLine(_direction: -1 | 0 | 1, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  clearScreenDown(callback?: () => void): boolean {
    callback?.();
    return true;
  }

  cursorTo(_x: number, _y?: number | (() => void), callback?: () => void): boolean {
    if (typeof _y === 'function') _y();
    else callback?.();
    return true;
  }

  moveCursor(_dx: number, _dy: number, callback?: () => void): boolean {
    callback?.();
    return true;
  }

  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }
}

function messageEvents(
  sessionId: string,
  projectPath: string,
  messageId: string,
  role: 'user' | 'assistant',
  content: string,
  seconds: number
): SessionEvent[] {
  const createdAt = `2026-09-02T08:00:${String(seconds).padStart(2, '0')}.000Z`;
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

async function waitForAssertion(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw lastError;
}

function resolvedInput(text: string): ResolvedInput {
  return {
    displayText: text,
    text,
    images: [],
    parts: [{ type: 'text', text }],
  };
}

describe('TUI remote Session history surface', () => {
  let storageRoot: string;
  let database: SqliteDb;
  let controller: SessionHistoryController;
  let hostStateRoot: string;
  let exactIdentity: string;
  let collisionIdentity: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-history-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const opened = await openDb(path.join(storageRoot, 'surface.db'));
    if (!opened) throw new Error('SQLite is unavailable');
    database = opened;
    migrate(database);

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Remote\\History')
    );
    exactIdentity = descriptor.exactIdentity;
    collisionIdentity = descriptor.collisionIdentity;
    hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const sessionId = 'tui-remote-history';
    await SessionService.createRemoteSessionMetadata(
      sessionId,
      hostStateRoot,
      descriptor,
      { title: 'Remote TUI history', taskStatus: 'completed' }
    );
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await new JSONLStore(getAcpRemoteSessionFilePath(scope, sessionId)).appendBatch([
        ...messageEvents(sessionId, hostStateRoot, 'one', 'user', 'oldest visible', 1),
        ...messageEvents(
          sessionId,
          hostStateRoot,
          'two',
          'assistant',
          'older reply',
          2
        ),
        ...messageEvents(sessionId, hostStateRoot, 'three', 'user', 'newer prompt', 3),
        ...messageEvents(
          sessionId,
          hostStateRoot,
          'four',
          'assistant',
          'newest reply',
          4
        ),
      ]);
    });
    controller = new SessionHistoryController({
      serviceFactory: () => new SessionSurfaceService({ database }),
      pageLimit: 2,
    });
    clipboard.copyTranscriptText.mockClear();
    getState().session.actions.restoreSession(
      'live-local-session',
      [{ id: 'live-message', role: 'user', content: 'local draft', timestamp: 1 }],
      [],
      '/workspace/live'
    );
    getState().focus.actions.setFocus(FocusId.SESSION_SELECTOR);
  });

  afterEach(async () => {
    __resetProjectionIOForTesting();
    await controller.close();
    database.close();
    if (previousStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    await rm(storageRoot, { recursive: true, force: true });
    getState().session.actions.resetSession();
    getState().focus.actions.setFocus(FocusId.MAIN_INPUT);
    vi.restoreAllMocks();
  });

  it('selects, pages, searches, copies, forks, and closes without replacing local state', async () => {
    const liveSession = getState().session;
    const cleanupAgent = vi.fn(async () => undefined);
    const listLocalSessions = vi.spyOn(SessionService, 'listSessions');
    const routeResult = await processSlashCommand(
      resolvedInput('/resume'),
      getState().app.actions,
      liveSession.actions,
      new AbortController().signal,
      cleanupAgent,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '/workspace/live',
      undefined,
      { list: () => controller.listAll() }
    );
    expect(routeResult).toEqual({
      type: 'handled',
      commandResult: { success: true },
    });
    expect(listLocalSessions).not.toHaveBeenCalled();
    const selectorState = getState().app.sessionSelectorData;
    const remoteSummary = selectorState?.sessions.find(
      (candidate) => candidate.locator.workspace.kind === 'acp-remote'
    );
    if (!selectorState || !remoteSummary) {
      throw new Error('remote selector state was not projected');
    }
    const activeSelector = selectorState;

    const findLocalMetadata = vi.spyOn(SessionService, 'findSessionMetadata');
    const restoreLocalSession = vi.spyOn(liveSession.actions, 'restoreSession');
    const localActivation = vi.fn();
    const stdin = new TestInputStream();
    const stdout = new TestOutputStream();
    const stderr = new TestOutputStream();
    let closed = false;

    function Harness(): React.ReactElement | null {
      const [screen, setScreen] = useState<'selector' | 'history' | 'closed'>(
        'selector'
      );
      const [history, setHistory] = useState(controller.getState());
      useEffect(() => controller.subscribe(setHistory), []);
      useEffect(() => {
        getState().focus.actions.setFocus(
          screen === 'history'
            ? FocusId.SESSION_HISTORY_VIEWER
            : screen === 'selector'
              ? FocusId.SESSION_SELECTOR
              : FocusId.MAIN_INPUT
        );
      }, [screen]);

      if (screen === 'closed') return null;
      if (screen === 'selector') {
        return (
          <SessionSelector
            intent={activeSelector.intent}
            sessions={activeSelector.sessions}
            onSelect={async (selection) => {
              await dispatchSessionSurfaceSelection(selection, activeSelector.intent, {
                openHistory: async (summary, intent) => {
                  getState().app.actions.showSessionHistoryViewer(summary, intent);
                  setScreen('history');
                  await controller.activate(summary, intent);
                },
                activateLocal: async () => {
                  localActivation();
                  cleanupAgent();
                },
              });
            }}
          />
        );
      }
      return (
        <SessionHistoryViewer
          state={history}
          onLoadOlder={(target) => controller.loadOlder(target)}
          onFork={(target) => controller.fork(target)}
          onClose={() => {
            void controller.closeView().then(() => {
              getState().app.actions.closeModal();
              closed = true;
              setScreen('closed');
            });
          }}
        />
      );
    }

    const app = render(
      <TerminalInputRouterProvider>
        <Harness />
      </TerminalInputRouterProvider>,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );
    const exitPromise = app.waitUntilExit();

    try {
      await waitForAssertion(() => {
        expect(stdin.isRaw).toBe(true);
        expect(stdout.output).toContain('[remote · offline · history]');
      });

      stdin.write('\r');
      await waitForAssertion(() => {
        expect(controller.getState().status).toBe('ready');
        expect(stdout.output).toContain('newest reply');
      });
      expect(localActivation).not.toHaveBeenCalled();
      expect(cleanupAgent).not.toHaveBeenCalled();
      expect(findLocalMetadata).not.toHaveBeenCalled();
      expect(restoreLocalSession).not.toHaveBeenCalled();
      expect(getState().session).toBe(liveSession);

      stdin.write('\u001b[5~');
      await waitForAssertion(() => {
        expect(stdout.output).toContain('oldest visible');
      });

      stdin.write('/');
      await new Promise<void>((resolve) => setImmediate(resolve));
      stdin.write('oldest');
      await new Promise<void>((resolve) => setImmediate(resolve));
      stdin.write('\r');
      await waitForAssertion(() => {
        expect(stdout.output).toContain('/oldest 1/1 · loaded pages only');
      });

      stdin.write('y');
      await waitForAssertion(() => {
        expect(clipboard.copyTranscriptText).toHaveBeenCalled();
      });

      const sourceSessionId = controller.getState().session?.locator.sessionId;
      stdin.write('f');
      await waitForAssertion(() => {
        const state = controller.getState();
        expect(state.status).toBe('ready');
        expect(state.session?.locator.sessionId).not.toBe(sourceSessionId);
        expect(state.session?.locator.workspace.kind).toBe('acp-remote');
        expect(state.session?.capabilities.turn.start).toBe(false);
      });

      stdin.write('\u001b');
      await waitForAssertion(() => expect(closed).toBe(true));
      expect(getState().app.activeModal).toBe('none');
      expect(getState().session).toBe(liveSession);

      const output = `${stdout.output}\n${stderr.output}`;
      expect(output).not.toContain(hostStateRoot);
      expect(output).not.toContain(exactIdentity);
      expect(output).not.toContain(collisionIdentity);
      expect(output).not.toContain('remoteWorkspace');
    } finally {
      app.unmount();
      await exitPromise;
      app.cleanup();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });

  it('aborts a real in-flight surface read and ignores its completion after close', async () => {
    const remote = (await controller.listAll()).find(
      (candidate) => candidate.locator.workspace.kind === 'acp-remote'
    );
    if (!remote) throw new Error('remote surface was not projected');

    let readStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let readAborted = (): void => undefined;
    const aborted = new Promise<void>((resolve) => {
      readAborted = resolve;
    });
    __setProjectionIOForTesting({
      async readSession(_store, _remoteScope, signal) {
        readStarted();
        signal.addEventListener('abort', readAborted, { once: true });
        await aborted;
        signal.throwIfAborted();
        return [];
      },
    });

    const opening = controller.open(remote);
    await started;
    const closing = controller.closeView();
    await aborted;
    await expect(opening).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();

    expect(controller.getState()).toMatchObject({
      status: 'idle',
      messages: [],
      truncated: false,
    });
  });
});
