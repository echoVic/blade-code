// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionLocatorV2,
  SessionSurfaceCatalogPage,
  SessionSurfaceHistoryPage,
  SessionSurfaceOpenResult,
  SessionSurfaceSummary,
} from '../../../../src/api/sessionSurfaceSchemas.js';
import { SessionSurfaceServiceError } from '../../../../src/services/SessionSurfaceService.js';
import type {
  SessionHistoryActionTarget,
  SessionHistoryServiceClient,
  SessionHistoryViewState,
} from '../../../../src/ui/services/SessionHistoryController.js';

let inputHandler:
  | ((input: string, key: Record<string, boolean>) => boolean | void)
  | undefined;

const clipboard = vi.hoisted(() => ({
  copyTranscriptText: vi.fn<
    (
      text: string,
      options?: { writeTerminal?: (value: string) => void }
    ) => Promise<{ success: boolean; method: 'native' }>
  >(async () => ({
    success: true,
    method: 'native',
  })),
}));
const focus = vi.hoisted(() => ({ current: 'session-history-viewer' }));

vi.mock('ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  useStdout: () => ({ stdout: { write: vi.fn() } }),
}));

vi.mock('../../../../src/ui/hooks/useTerminalDimensions.js', () => ({
  useTerminalDimensions: () => ({ width: 80, height: 12 }),
}));

vi.mock('../../../../src/ui/input/TerminalInputRouter.js', () => ({
  useTerminalInput: (
    handler: (input: string, key: Record<string, boolean>) => boolean | void,
    options: { isActive?: boolean }
  ) => {
    inputHandler = options.isActive === false ? undefined : handler;
  },
}));

vi.mock('../../../../src/ui/utils/clipboard.js', () => ({
  copyTranscriptText: clipboard.copyTranscriptText,
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useCurrentFocus: () => focus.current,
}));

const REMOTE_WORKSPACE_REF = `acp-remote-workspace:${'R'.repeat(43)}`;

function createRemoteLocator(sessionId = 'remote-session-1'): SessionLocatorV2 {
  return {
    version: 2,
    sessionId,
    workspace: { kind: 'acp-remote', workspaceRef: REMOTE_WORKSPACE_REF },
  };
}

function createRemoteSummary(sessionId = 'remote-session-1'): SessionSurfaceSummary {
  return {
    locator: createRemoteLocator(sessionId),
    displayCwd: 'C:\\Remote\\Repo',
    pathStyle: 'win32',
    title: 'Remote history',
    rootId: 'root-1',
    taskStatus: 'completed',
    messageCount: 4,
    firstMessageTime: '2026-09-02T08:00:00.000Z',
    lastMessageTime: '2026-09-02T09:00:00.000Z',
    hasErrors: false,
    capabilities: {
      connection: 'offline',
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'history-only',
      },
      terminal: { mode: 'none', owner: 'none', reason: 'history-only' },
    },
  };
}

function createHistoryPage(
  ids: readonly string[],
  options: { olderCursor?: string; snapshot?: string; prefix?: string } = {}
): SessionSurfaceHistoryPage {
  const sequenceById = new Map([
    ['one', 1],
    ['two', 2],
    ['three', 3],
    ['four', 4],
  ]);
  return {
    messages: ids.map((id, index) => ({
      id: `surface-message:${sequenceById.get(id) ?? index + 1}:${id}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${options.prefix ?? 'message'} ${id}`,
      timestamp: `2026-09-02T08:0${index}:00.000Z`,
    })),
    olderCursor: options.olderCursor,
    snapshot: options.snapshot ?? 'history-snapshot',
    truncated: false,
  };
}

function createOpenResult(
  sessionId = 'remote-session-1',
  history = createHistoryPage(['three', 'four'], { olderCursor: 'older-1' })
): SessionSurfaceOpenResult {
  return { session: createRemoteSummary(sessionId), history };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createService(
  overrides: Partial<SessionHistoryServiceClient> = {}
): SessionHistoryServiceClient {
  return {
    listPage: async (): Promise<SessionSurfaceCatalogPage> => ({ sessions: [] }),
    open: async (): Promise<SessionSurfaceOpenResult> => createOpenResult(),
    historyPage: async (): Promise<SessionSurfaceHistoryPage> =>
      createHistoryPage(['one', 'two']),
    fork: async (): Promise<SessionSurfaceOpenResult> =>
      createOpenResult('remote-child'),
    close: async (): Promise<void> => undefined,
    ...overrides,
  };
}

function actionTarget(state: SessionHistoryViewState): SessionHistoryActionTarget {
  if (!state.session) throw new Error('history view has no active session');
  return {
    viewGeneration: state.viewGeneration,
    locator: state.session.locator,
    snapshot: state.snapshot,
    olderCursor: state.olderCursor,
  };
}

describe('SessionHistoryController', () => {
  it('loads the complete catalog through bounded pages and deduplicates locators', async () => {
    const local = createRemoteSummary('local-session');
    local.locator = {
      version: 2,
      sessionId: 'local-session',
      workspace: { kind: 'local', projectPath: '/workspace/local' },
    };
    local.displayCwd = '/workspace/local';
    const remote = createRemoteSummary();
    const listPage = vi
      .fn<
        (options?: {
          cursor?: string;
          limit?: number;
        }) => Promise<SessionSurfaceCatalogPage>
      >()
      .mockResolvedValueOnce({ sessions: [local, remote], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ sessions: [remote] });
    const service = createService({ listPage });
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({ serviceFactory: () => service });

    await expect(controller.listAll()).resolves.toEqual([local, remote]);
    expect(listPage).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 50 });
    expect(listPage).toHaveBeenNthCalledWith(2, { cursor: 'page-2', limit: 50 });

    await controller.close();
  });

  it('does not create a catalog service after closeView wins the await boundary', async () => {
    const first = createService();
    const listPage = vi.fn(
      async (): Promise<SessionSurfaceCatalogPage> => ({
        sessions: [],
      })
    );
    const second = createService({ listPage });
    const services = [first, second];
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({
      serviceFactory: () => services.shift()!,
    });
    await controller.open(createRemoteSummary());

    const listing = controller.listPage();
    await controller.closeView();

    await expect(listing).rejects.toMatchObject({
      code: 'session_surface_unavailable',
    });
    expect(listPage).not.toHaveBeenCalled();
    await controller.close();
  });

  it('retains the newly loaded older window when history exceeds five hundred messages', async () => {
    const currentIds = Array.from({ length: 450 }, (_, index) => `current-${index}`);
    const olderIds = Array.from({ length: 100 }, (_, index) => `older-${index}`);
    const initial = createOpenResult(
      'remote-session-1',
      createHistoryPage(currentIds, { olderCursor: 'older-1' })
    );
    const historyPage = vi.fn(async () => createHistoryPage(olderIds));
    const service = createService({ open: async () => initial, historyPage });
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({ serviceFactory: () => service });

    await controller.open(createRemoteSummary());
    await controller.loadOlder(actionTarget(controller.getState()));

    const retained = controller.getState().messages;
    expect(retained).toHaveLength(500);
    expect(retained[0]?.content).toBe('message older-0');
    expect(retained.at(-1)?.content).toBe('message current-399');
    await controller.close();
  });

  it('rejects an unavailable history read before opening the service', async () => {
    const open = vi.fn(async () => createOpenResult());
    const service = createService({ open });
    const summary = createRemoteSummary();
    summary.capabilities.history.read = false;
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({ serviceFactory: () => service });

    await controller.open(summary);

    expect(open).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      status: 'error',
      session: summary,
      messages: [],
      error: {
        code: 'session_surface_capability_unavailable',
        message: 'This action is unavailable in history-only mode.',
      },
    });
    await controller.close();
  });

  it('deduplicates repeated activation of the same remote fork intent', async () => {
    const deferred = createDeferred<SessionSurfaceOpenResult>();
    const fork = vi.fn(() => deferred.promise);
    const service = createService({ fork });
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({ serviceFactory: () => service });
    const summary = createRemoteSummary();

    const first = controller.activate(summary, 'fork');
    const second = controller.activate(summary, 'fork');
    deferred.resolve(createOpenResult('remote-child'));
    await Promise.all([first, second]);

    expect(fork).toHaveBeenCalledOnce();
    expect(controller.getState().session?.locator.sessionId).toBe('remote-child');
    await controller.close();
  });

  it('rejects stale controller actions while a fork is in flight', async () => {
    const deferred = createDeferred<SessionSurfaceOpenResult>();
    const historyPage = vi.fn(async () => createHistoryPage(['older']));
    const fork = vi.fn(() => deferred.promise);
    const first = createService({ historyPage });
    const second = createService({ fork, historyPage });
    const services = [first, second];
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({
      serviceFactory: () => services.shift()!,
    });
    await controller.open(createRemoteSummary());

    const target = actionTarget(controller.getState());
    const forking = controller.fork(target);
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce());
    await controller.loadOlder(target);
    await controller.fork(target);

    expect(historyPage).not.toHaveBeenCalled();
    expect(fork).toHaveBeenCalledOnce();
    deferred.resolve(createOpenResult('remote-child'));
    await forking;
    await controller.close();
  });

  it('rejects callbacks captured by a replaced history view', async () => {
    const first = createService();
    const historyPage = vi.fn(async () => createHistoryPage(['older']));
    const second = createService({
      open: async () => createOpenResult('remote-session-2'),
      historyPage,
    });
    const fork = vi.fn(async () => createOpenResult('unexpected-child'));
    const third = createService({ fork });
    const services = [first, second, third];
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({
      serviceFactory: () => services.shift()!,
    });
    await controller.open(createRemoteSummary());
    const firstState = controller.getState();
    const staleTarget = {
      viewGeneration: firstState.viewGeneration,
      locator: firstState.session!.locator,
      snapshot: firstState.snapshot,
      olderCursor: firstState.olderCursor,
    };
    await controller.open(createRemoteSummary('remote-session-2'));

    await controller.loadOlder(staleTarget);
    await controller.fork(staleTarget);

    expect(historyPage).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
    expect(controller.getState().session?.locator.sessionId).toBe('remote-session-2');
    await controller.close();
  });

  it('reopens the latest snapshot after an older-page cursor becomes stale', async () => {
    const refreshed = createOpenResult(
      'remote-session-1',
      createHistoryPage(['fresh'], { snapshot: 'fresh-snapshot' })
    );
    const open = vi
      .fn<() => Promise<SessionSurfaceOpenResult>>()
      .mockResolvedValueOnce(createOpenResult())
      .mockResolvedValueOnce(refreshed);
    const historyPage = vi.fn(async () => {
      throw new SessionSurfaceServiceError('session_surface_snapshot_changed');
    });
    const service = createService({ open, historyPage });
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({ serviceFactory: () => service });

    await controller.open(createRemoteSummary());
    await controller.loadOlder(actionTarget(controller.getState()));

    expect(open).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({
      status: 'ready',
      messages: refreshed.history.messages,
      snapshot: 'fresh-snapshot',
    });
    await controller.close();
  });

  it('closes the owned service and ignores a late open completion', async () => {
    const deferred = createDeferred<SessionSurfaceOpenResult>();
    const close = vi.fn(async () => undefined);
    const open = vi.fn(() => deferred.promise);
    const service = createService({ open, close });
    const { SessionHistoryController } = await import(
      '../../../../src/ui/services/SessionHistoryController.js'
    );
    const controller = new SessionHistoryController({ serviceFactory: () => service });

    const pending = controller.open(createRemoteSummary());
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    await controller.closeView();
    deferred.resolve(createOpenResult());
    await pending;

    expect(close).toHaveBeenCalledOnce();
    expect(controller.getState().status).toBe('idle');
    expect(controller.getState().session).toBeUndefined();

    await controller.close();
  });
});

describe('SessionHistoryViewer', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let onLoadOlder: ReturnType<
    typeof vi.fn<(target: SessionHistoryActionTarget) => void>
  >;
  let onFork: ReturnType<typeof vi.fn<(target: SessionHistoryActionTarget) => void>>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  const readyState: SessionHistoryViewState = {
    viewGeneration: 1,
    status: 'ready',
    session: createRemoteSummary(),
    messages: createHistoryPage(['one', 'two'], { olderCursor: 'older-1' }).messages,
    olderCursor: 'older-1',
    snapshot: 'history-snapshot',
    truncated: false,
  };

  beforeEach(async () => {
    inputHandler = undefined;
    focus.current = 'session-history-viewer';
    clipboard.copyTranscriptText.mockClear();
    onLoadOlder = vi.fn<(target: SessionHistoryActionTarget) => void>();
    onFork = vi.fn<(target: SessionHistoryActionTarget) => void>();
    onClose = vi.fn<() => void>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    const { SessionHistoryViewer } = await import(
      '../../../../src/ui/components/SessionHistoryViewer.js'
    );
    act(() => {
      root.render(
        <SessionHistoryViewer
          state={readyState}
          onLoadOlder={onLoadOlder}
          onFork={onFork}
          onClose={onClose}
        />
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('requests one older page only when navigation reaches the loaded top', () => {
    act(() => {
      inputHandler?.('g', {});
      inputHandler?.('', { pageUp: true });
      inputHandler?.('', { pageUp: true });
    });

    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it('shows unavailable history actions and blocks their handlers by capability', async () => {
    const { SessionHistoryViewer } = await import(
      '../../../../src/ui/components/SessionHistoryViewer.js'
    );
    const unavailableState: SessionHistoryViewState = {
      ...readyState,
      session: {
        ...readyState.session!,
        capabilities: {
          ...readyState.session!.capabilities,
          history: { read: false, fork: false },
        },
      },
    };
    act(() => {
      root.render(
        <SessionHistoryViewer
          state={unavailableState}
          onLoadOlder={onLoadOlder}
          onFork={onFork}
          onClose={onClose}
        />
      );
    });

    act(() => {
      inputHandler?.('g', {});
      inputHandler?.('', { pageUp: true });
      inputHandler?.('f', {});
    });

    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Older history unavailable');
    expect(container.textContent).toContain('Fork unavailable');
  });

  it('allows retrying the same older cursor after an error state', async () => {
    const { SessionHistoryViewer } = await import(
      '../../../../src/ui/components/SessionHistoryViewer.js'
    );

    act(() => {
      inputHandler?.('g', {});
    });
    expect(onLoadOlder).toHaveBeenCalledOnce();

    act(() => {
      root.render(
        <SessionHistoryViewer
          state={{
            ...readyState,
            status: 'error',
            error: { code: null, message: 'Session history is unavailable.' },
          }}
          onLoadOlder={onLoadOlder}
          onFork={onFork}
          onClose={onClose}
        />
      );
    });
    act(() => {
      inputHandler?.('g', {});
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });
});
