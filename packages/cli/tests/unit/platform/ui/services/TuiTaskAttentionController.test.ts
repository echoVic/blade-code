import { describe, expect, it, vi } from 'vitest';
import type {
  SessionLocatorV2,
  SessionSurfaceCatalogPage,
  SessionSurfaceSummary,
} from '../../../../../src/api/sessionSurfaceSchemas.js';
import type { BusEvent } from '../../../../../src/server/bus.js';
import type { SurfaceListOptions } from '../../../../../src/services/SessionSurfaceService.js';
import {
  type TuiTaskAttentionBus,
  type TuiTaskAttentionCatalogClient,
  TuiTaskAttentionController,
  type TuiTaskAttentionStoreClient,
  type TuiTaskAttentionTimer,
  type TuiTaskAttentionTimerApi,
} from '../../../../../src/ui/services/TuiTaskAttentionController.js';
import type { TuiTaskAttentionSnapshot } from '../../../../../src/ui/services/TuiTaskAttentionStore.js';

const REMOTE_REF_A = `acp-remote-workspace:${'a'.repeat(43)}`;
const REMOTE_REF_B = `acp-remote-workspace:${'b'.repeat(43)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function summary(
  sessionId: string,
  overrides: Partial<SessionSurfaceSummary> = {}
): SessionSurfaceSummary {
  return {
    locator: {
      version: 2,
      sessionId,
      workspace: { kind: 'local', projectPath: `/workspace/${sessionId}` },
    },
    displayCwd: `/workspace/${sessionId}`,
    title: `Task ${sessionId}`,
    rootId: sessionId,
    taskStatus: 'running',
    messageCount: 1,
    firstMessageTime: '2026-09-04T12:00:00.000Z',
    lastMessageTime: '2026-09-04T12:01:00.000Z',
    hasErrors: false,
    capabilities: {
      connection: 'local',
      history: { read: true, fork: true },
      turn: { start: true },
      files: { readText: true, writeText: true, browse: 'tree' },
      terminal: { mode: 'interactive', owner: 'local' },
    },
    ...overrides,
  };
}

function page(
  sessions: readonly SessionSurfaceSummary[],
  nextCursor?: string
): SessionSurfaceCatalogPage {
  return { sessions: [...sessions], ...(nextCursor ? { nextCursor } : {}) };
}

class FakeAttentionStore implements TuiTaskAttentionStoreClient {
  readonly reconciliations: Array<{
    sessions: readonly SessionSurfaceSummary[];
    visibleLocator?: SessionLocatorV2;
  }> = [];
  readonly acknowledgements: SessionSurfaceSummary[] = [];
  unreadKeys: readonly string[] = [];
  readonly reconcileRequests: Array<
    ReturnType<typeof deferred<TuiTaskAttentionSnapshot>>
  > = [];
  deferReconcile = false;

  async reconcile(
    sessions: readonly SessionSurfaceSummary[],
    visibleLocator?: SessionLocatorV2
  ): Promise<TuiTaskAttentionSnapshot> {
    this.reconciliations.push({
      sessions: [...sessions],
      ...(visibleLocator ? { visibleLocator } : {}),
    });
    if (this.deferReconcile) {
      const request = deferred<TuiTaskAttentionSnapshot>();
      this.reconcileRequests.push(request);
      return request.promise;
    }
    return { unreadKeys: [...this.unreadKeys] };
  }

  async acknowledge(
    summaryToAcknowledge: SessionSurfaceSummary
  ): Promise<TuiTaskAttentionSnapshot> {
    this.acknowledgements.push(summaryToAcknowledge);
    return { unreadKeys: [...this.unreadKeys] };
  }

  snapshot(): TuiTaskAttentionSnapshot {
    return { unreadKeys: [...this.unreadKeys] };
  }
}

class DeferredCatalogClient implements TuiTaskAttentionCatalogClient {
  readonly requests: Array<{
    options: SurfaceListOptions;
    request: ReturnType<typeof deferred<SessionSurfaceCatalogPage>>;
  }> = [];
  readonly closeReasons: Array<string | undefined> = [];
  activeRequests = 0;
  maxActiveRequests = 0;

  listPage(options: SurfaceListOptions = {}): Promise<SessionSurfaceCatalogPage> {
    const request = deferred<SessionSurfaceCatalogPage>();
    this.requests.push({ options, request });
    this.activeRequests += 1;
    this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
    return request.promise.finally(() => {
      this.activeRequests -= 1;
    });
  }

  async close(reason?: string): Promise<void> {
    this.closeReasons.push(reason);
  }
}

class FakeBus implements TuiTaskAttentionBus {
  listener?: (event: BusEvent) => void;
  unsubscribeCalls = 0;

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
      this.unsubscribeCalls += 1;
    };
  }

  emit(type: string): void {
    this.listener?.({
      sessionId: 'session-event',
      projectPath: '/workspace/event',
      type,
      properties: {},
    });
  }
}

class FakeTimerApi implements TuiTaskAttentionTimerApi {
  callback?: () => void;
  delay?: number;
  readonly unref = vi.fn();
  readonly clearInterval = vi.fn<(timer: TuiTaskAttentionTimer) => void>();
  readonly timer: TuiTaskAttentionTimer = { unref: this.unref };

  setInterval(callback: () => void, delay: number): TuiTaskAttentionTimer {
    this.callback = callback;
    this.delay = delay;
    return this.timer;
  }
}

async function waitForRequest(
  service: DeferredCatalogClient,
  count: number
): Promise<void> {
  await vi.waitFor(() => expect(service.requests).toHaveLength(count));
}

describe('TuiTaskAttentionController', () => {
  it('reconciles only after exhausting the complete catalog and publishes immutable copies', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    store.unreadKeys = ['digest-a'];
    const controller = new TuiTaskAttentionController({ service, store });
    const states: Parameters<Parameters<typeof controller.subscribe>[0]>[0][] = [];
    controller.subscribe((state) => states.push(state));

    const listed = controller.listAll();
    await waitForRequest(service, 1);
    expect(controller.getState()).toMatchObject({ status: 'loading', sessions: [] });
    service.requests[0]?.request.resolve(page([summary('a')], 'cursor-2'));
    await waitForRequest(service, 2);
    expect(store.reconciliations).toHaveLength(0);
    service.requests[1]?.request.resolve(page([summary('b')]));

    await expect(listed).resolves.toEqual([summary('a'), summary('b')]);
    expect(service.requests.map(({ options }) => options)).toEqual([
      { limit: 100 },
      { cursor: 'cursor-2', limit: 100 },
    ]);
    expect(store.reconciliations).toHaveLength(1);
    expect(store.reconciliations[0]?.sessions).toEqual([summary('a'), summary('b')]);
    expect(controller.getState()).toMatchObject({
      status: 'ready',
      sessions: [summary('a'), summary('b')],
      unreadKeys: ['digest-a'],
    });
    expect(Object.isFrozen(states.at(-1))).toBe(true);
    expect(Object.isFrozen(states.at(-1)?.sessions)).toBe(true);
    expect(Object.isFrozen(states.at(-1)?.unreadKeys)).toBe(true);
    expect(Object.isFrozen(states.at(-1)?.sessions[0])).toBe(true);
    expect(Object.isFrozen(states.at(-1)?.sessions[0]?.locator)).toBe(true);
    expect(Object.isFrozen(states.at(-1)?.sessions[0]?.capabilities.history)).toBe(
      true
    );
    expect(states.at(-1)?.sessions).not.toBe(store.reconciliations[0]?.sessions);

    await controller.close();
  });

  it('does not reconcile a failed page and retains the previous sessions and unread keys', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    store.unreadKeys = ['known-unread'];
    const controller = new TuiTaskAttentionController({ service, store });

    const first = controller.listAll();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([summary('known')]));
    await first;

    const failed = controller.listAll();
    await waitForRequest(service, 2);
    service.requests[1]?.request.resolve(page([summary('replacement')], 'next'));
    await waitForRequest(service, 3);
    service.requests[2]?.request.reject(new Error('catalog page unavailable'));

    await expect(failed).resolves.toEqual([summary('known')]);
    expect(store.reconciliations).toHaveLength(1);
    expect(controller.getState()).toMatchObject({
      status: 'error',
      sessions: [summary('known')],
      unreadKeys: ['known-unread'],
    });

    await controller.close();
  });

  it('treats a store reconciliation failure like a failed catalog refresh', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    store.unreadKeys = ['known-unread'];
    const controller = new TuiTaskAttentionController({ service, store });

    const first = controller.listAll();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([summary('known')]));
    await first;

    store.deferReconcile = true;
    const failed = controller.listAll();
    await waitForRequest(service, 2);
    service.requests[1]?.request.resolve(page([summary('replacement')]));
    await vi.waitFor(() => expect(store.reconcileRequests).toHaveLength(1));
    store.reconcileRequests[0]?.reject(new Error('ledger unavailable'));

    await expect(failed).resolves.toEqual([summary('known')]);
    expect(controller.getState()).toMatchObject({
      status: 'error',
      sessions: [summary('known')],
      unreadKeys: ['known-unread'],
    });
    await controller.close();
  });

  it('coalesces refresh requests into one bounded serial follow-up per dirty scan', async () => {
    const service = new DeferredCatalogClient();
    const bus = new FakeBus();
    const controller = new TuiTaskAttentionController({
      service,
      store: new FakeAttentionStore(),
      bus,
      timerApi: new FakeTimerApi(),
    });

    const first = controller.start();
    await waitForRequest(service, 1);
    bus.emit('task.status');
    bus.emit('session.deleted');
    expect(service.requests).toHaveLength(1);

    service.requests[0]?.request.resolve(page([summary('first')]));
    await waitForRequest(service, 2);
    bus.emit('session.archived');
    bus.emit('task.status');
    expect(service.requests).toHaveLength(2);

    service.requests[1]?.request.resolve(page([summary('second')]));
    await waitForRequest(service, 3);
    service.requests[2]?.request.resolve(page([summary('third')]));
    await first;

    expect(service.requests).toHaveLength(3);
    expect(service.maxActiveRequests).toBe(1);
    expect(controller.getState().sessions).toEqual([summary('third')]);

    await controller.close();
  });

  it('runs a lifecycle refresh queued from the ready listener after finalization', async () => {
    const service = new DeferredCatalogClient();
    const bus = new FakeBus();
    const controller = new TuiTaskAttentionController({
      service,
      store: new FakeAttentionStore(),
      bus,
      timerApi: new FakeTimerApi(),
    });
    let emitted = false;
    controller.subscribe((state) => {
      if (state.status !== 'ready' || emitted) return;
      emitted = true;
      queueMicrotask(() => {
        queueMicrotask(() => bus.emit('task.status'));
      });
    });

    const started = controller.start();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([summary('first')]));
    await started;
    await waitForRequest(service, 2);
    service.requests[1]?.request.resolve(page([summary('follow-up')]));
    await vi.waitFor(() =>
      expect(controller.getState().sessions).toEqual([summary('follow-up')])
    );

    expect(service.maxActiveRequests).toBe(1);
    await controller.close();
  });

  it('shares concurrent listAll calls without forcing a redundant follow-up scan', async () => {
    const service = new DeferredCatalogClient();
    const controller = new TuiTaskAttentionController({
      service,
      store: new FakeAttentionStore(),
    });

    const first = controller.listAll();
    await waitForRequest(service, 1);
    const second = controller.listAll();
    service.requests[0]?.request.resolve(page([summary('shared')]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [summary('shared')],
      [summary('shared')],
    ]);
    expect(service.requests).toHaveLength(1);
    await controller.close();
  });

  it('closes the owned service and fences a late catalog completion', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    const controller = new TuiTaskAttentionController({ service, store });
    const listener = vi.fn();
    controller.subscribe(listener);
    const refresh = controller.listAll();
    await waitForRequest(service, 1);
    const callsBeforeClose = listener.mock.calls.length;

    const closing = controller.close();
    expect(service.closeReasons).toEqual(['tui-task-attention-controller-closed']);
    service.requests[0]?.request.resolve(page([summary('late')]));
    await Promise.all([closing, refresh]);

    expect(store.reconciliations).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it('fences a reconcile that completes after close', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    store.deferReconcile = true;
    const controller = new TuiTaskAttentionController({ service, store });
    const listener = vi.fn();
    controller.subscribe(listener);
    const refresh = controller.listAll();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([summary('late-store')]));
    await vi.waitFor(() => expect(store.reconcileRequests).toHaveLength(1));
    const callsBeforeClose = listener.mock.calls.length;

    const closing = controller.close();
    store.reconcileRequests[0]?.resolve({ unreadKeys: ['late-unread'] });
    await Promise.all([closing, refresh]);

    expect(controller.getState()).toMatchObject({
      status: 'loading',
      sessions: [],
      unreadKeys: [],
    });
    expect(listener).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it('awaits the owned service shutdown while an active scan drains', async () => {
    const service = new DeferredCatalogClient();
    const closeGate = deferred<void>();
    service.close = vi.fn(async (reason?: string) => {
      service.closeReasons.push(reason);
      await closeGate.promise;
    });
    const controller = new TuiTaskAttentionController({
      service,
      store: new FakeAttentionStore(),
    });
    const refresh = controller.listAll();
    await waitForRequest(service, 1);

    let closed = false;
    const closing = controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    service.requests[0]?.request.reject(new Error('aborted by service close'));
    closeGate.resolve();
    await Promise.all([refresh, closing]);
    expect(closed).toBe(true);
  });

  it('refreshes for lifecycle events and ignores unrelated Bus events', async () => {
    const service = new DeferredCatalogClient();
    const bus = new FakeBus();
    const timerApi = new FakeTimerApi();
    const controller = new TuiTaskAttentionController({
      service,
      store: new FakeAttentionStore(),
      bus,
      timerApi,
    });

    const started = controller.start();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([]));
    await started;

    bus.emit('message.updated');
    await Promise.resolve();
    expect(service.requests).toHaveLength(1);

    for (const eventType of ['task.status', 'session.deleted', 'session.archived']) {
      const nextRequestCount = service.requests.length + 1;
      bus.emit(eventType);
      await waitForRequest(service, nextRequestCount);
      service.requests.at(-1)?.request.resolve(page([]));
      await vi.waitFor(() => {
        expect(controller.getState().status).toBe('ready');
        expect(service.activeRequests).toBe(0);
      });
    }
    expect(service.requests).toHaveLength(4);

    await controller.close();
    expect(bus.unsubscribeCalls).toBe(1);
  });

  it('owns an unrefed 30-second poll and cancels it on close', async () => {
    const service = new DeferredCatalogClient();
    const timerApi = new FakeTimerApi();
    const controller = new TuiTaskAttentionController({
      service,
      store: new FakeAttentionStore(),
      bus: new FakeBus(),
      timerApi,
    });

    const started = controller.start();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([]));
    await started;
    expect(timerApi.delay).toBe(30_000);
    expect(timerApi.unref).toHaveBeenCalledOnce();

    timerApi.callback?.();
    await waitForRequest(service, 2);
    service.requests[1]?.request.resolve(page([]));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));

    await controller.close();
    expect(timerApi.clearInterval).toHaveBeenCalledWith(timerApi.timer);
  });

  it('acknowledges and marks visibility using the exact compound Session locator', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    const sameIdRemoteA = summary('shared', {
      locator: {
        version: 2,
        sessionId: 'shared',
        workspace: { kind: 'acp-remote', workspaceRef: REMOTE_REF_A },
      },
    });
    const sameIdRemoteB = summary('shared', {
      locator: {
        version: 2,
        sessionId: 'shared',
        workspace: { kind: 'acp-remote', workspaceRef: REMOTE_REF_B },
      },
    });
    const controller = new TuiTaskAttentionController({ service, store });

    const listed = controller.listAll();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([sameIdRemoteA, sameIdRemoteB]));
    await listed;

    store.unreadKeys = ['remote-b'];
    await controller.acknowledge(sameIdRemoteA);
    expect(store.acknowledgements).toEqual([sameIdRemoteA]);
    expect(controller.getState().unreadKeys).toEqual(['remote-b']);

    store.unreadKeys = [];
    await controller.setVisibleLocator(sameIdRemoteB.locator);
    expect(store.reconciliations.at(-1)?.visibleLocator).toEqual(sameIdRemoteB.locator);
    expect(store.reconciliations.at(-1)?.visibleLocator).not.toEqual(
      sameIdRemoteA.locator
    );
    expect(controller.getState().unreadKeys).toEqual([]);

    await controller.close();
  });

  it('does not prune the ledger when visibility changes before a complete catalog', async () => {
    const store = new FakeAttentionStore();
    store.unreadKeys = ['existing-unread'];
    const controller = new TuiTaskAttentionController({
      service: new DeferredCatalogClient(),
      store,
    });
    const locator = summary('not-yet-listed').locator;

    await controller.setVisibleLocator(locator);

    expect(store.reconciliations).toHaveLength(0);
    expect(controller.getState()).toMatchObject({
      status: 'idle',
      sessions: [],
      unreadKeys: ['existing-unread'],
    });
    await controller.close();
  });

  it('queues visibility behind reconciliation and reuses the newest complete catalog', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    store.deferReconcile = true;
    const controller = new TuiTaskAttentionController({ service, store });
    const oldSession = summary('old');
    const newSession = summary('new');

    const first = controller.listAll();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([oldSession]));
    await vi.waitFor(() => expect(store.reconcileRequests).toHaveLength(1));
    store.reconcileRequests[0]?.resolve({ unreadKeys: [] });
    await first;

    const refresh = controller.listAll();
    await waitForRequest(service, 2);
    service.requests[1]?.request.resolve(page([newSession]));
    await vi.waitFor(() => expect(store.reconcileRequests).toHaveLength(2));
    const visibility = controller.setVisibleLocator(newSession.locator);
    await Promise.resolve();
    expect(store.reconciliations).toHaveLength(2);

    store.reconcileRequests[1]?.resolve({ unreadKeys: ['new'] });
    await vi.waitFor(() => expect(store.reconcileRequests).toHaveLength(3));
    expect(store.reconciliations[2]?.sessions).toEqual([newSession]);
    expect(store.reconciliations[2]?.visibleLocator).toEqual(newSession.locator);
    store.reconcileRequests[2]?.resolve({ unreadKeys: [] });
    await Promise.all([refresh, visibility]);

    expect(controller.getState()).toMatchObject({
      status: 'ready',
      sessions: [newSession],
      unreadKeys: [],
    });
    await controller.close();
  });

  it('keeps an error catalog status when acknowledgement updates unread keys', async () => {
    const service = new DeferredCatalogClient();
    const store = new FakeAttentionStore();
    const controller = new TuiTaskAttentionController({ service, store });
    const known = summary('known');

    const first = controller.listAll();
    await waitForRequest(service, 1);
    service.requests[0]?.request.resolve(page([known]));
    await first;
    const failed = controller.listAll();
    await waitForRequest(service, 2);
    service.requests[1]?.request.reject(new Error('catalog unavailable'));
    await failed;
    expect(controller.getState().status).toBe('error');

    store.unreadKeys = [];
    await controller.acknowledge(known);

    expect(controller.getState()).toMatchObject({
      status: 'error',
      sessions: [known],
      unreadKeys: [],
    });
    await controller.close();
  });
});
