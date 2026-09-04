import type {
  SessionLocatorV2,
  SessionSurfaceCatalogPage,
  SessionSurfaceSummary,
} from '../../api/sessionSurfaceSchemas.js';
import { Bus, type BusEvent } from '../../server/bus.js';
import {
  SessionSurfaceService,
  type SurfaceListOptions,
} from '../../services/SessionSurfaceService.js';
import {
  type TuiTaskAttentionSnapshot,
  TuiTaskAttentionStore,
} from './TuiTaskAttentionStore.js';

const CATALOG_PAGE_LIMIT = 100;
const POLL_INTERVAL_MS = 30_000;
const REFRESH_EVENT_TYPES = new Set([
  'task.status',
  'session.deleted',
  'session.archived',
]);

export interface TuiTaskAttentionCatalogClient {
  listPage(options?: SurfaceListOptions): Promise<SessionSurfaceCatalogPage>;
  close(reason?: string): Promise<void>;
}

export interface TuiTaskAttentionStoreClient {
  reconcile(
    sessions: readonly SessionSurfaceSummary[],
    visibleLocator?: SessionLocatorV2
  ): Promise<TuiTaskAttentionSnapshot>;
  acknowledge(summary: SessionSurfaceSummary): Promise<TuiTaskAttentionSnapshot>;
  snapshot(): TuiTaskAttentionSnapshot;
}

export interface TuiTaskAttentionBus {
  subscribe(listener: (event: BusEvent) => void): () => void;
}

export interface TuiTaskAttentionTimer {
  unref(): void;
}

export interface TuiTaskAttentionTimerApi {
  setInterval(callback: () => void, delay: number): TuiTaskAttentionTimer;
  clearInterval(timer: TuiTaskAttentionTimer): void;
}

export interface TuiTaskAttentionControllerOptions {
  service?: TuiTaskAttentionCatalogClient;
  store?: TuiTaskAttentionStoreClient;
  bus?: TuiTaskAttentionBus;
  timerApi?: TuiTaskAttentionTimerApi;
}

export interface TuiTaskAttentionState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly sessions: readonly SessionSurfaceSummary[];
  readonly unreadKeys: readonly string[];
}

type TuiTaskAttentionListener = (state: TuiTaskAttentionState) => void;

class NodeTimerApi implements TuiTaskAttentionTimerApi {
  private readonly timers = new WeakMap<TuiTaskAttentionTimer, NodeJS.Timeout>();

  setInterval(callback: () => void, delay: number): TuiTaskAttentionTimer {
    const timeout = setInterval(callback, delay);
    const timer: TuiTaskAttentionTimer = { unref: () => timeout.unref() };
    this.timers.set(timer, timeout);
    return timer;
  }

  clearInterval(timer: TuiTaskAttentionTimer): void {
    const timeout = this.timers.get(timer);
    if (!timeout) return;
    clearInterval(timeout);
    this.timers.delete(timer);
  }
}

const defaultTimerApi = new NodeTimerApi();

export class TuiTaskAttentionController {
  private readonly service: TuiTaskAttentionCatalogClient;
  private readonly store: TuiTaskAttentionStoreClient;
  private readonly bus: TuiTaskAttentionBus;
  private readonly timerApi: TuiTaskAttentionTimerApi;
  private readonly listeners = new Set<TuiTaskAttentionListener>();
  private state: TuiTaskAttentionState;
  private visibleLocator?: SessionLocatorV2;
  private hasCompleteCatalog = false;
  private activeRefresh: Promise<SessionSurfaceSummary[]> | null = null;
  private dirty = false;
  private disposed = false;
  private started = false;
  private unsubscribeBus?: () => void;
  private pollTimer?: TuiTaskAttentionTimer;
  private closePromise?: Promise<void>;

  constructor(options: TuiTaskAttentionControllerOptions = {}) {
    this.service = options.service ?? new SessionSurfaceService();
    this.store = options.store ?? new TuiTaskAttentionStore();
    this.bus = options.bus ?? Bus;
    this.timerApi = options.timerApi ?? defaultTimerApi;
    this.state = immutableState('idle', [], this.store.snapshot().unreadKeys);
  }

  getState(): TuiTaskAttentionState {
    return this.state;
  }

  subscribe(listener: TuiTaskAttentionListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.started) {
      this.started = true;
      this.unsubscribeBus = this.bus.subscribe((event) => {
        if (REFRESH_EVENT_TYPES.has(event.type)) void this.requestRefresh(true);
      });
      this.pollTimer = this.timerApi.setInterval(() => {
        void this.requestRefresh(true);
      }, POLL_INTERVAL_MS);
      this.pollTimer.unref();
    }
    await this.requestRefresh(false);
  }

  listAll(): Promise<SessionSurfaceSummary[]> {
    return this.requestRefresh(false);
  }

  private requestRefresh(markDirty: boolean): Promise<SessionSurfaceSummary[]> {
    if (this.disposed) return Promise.resolve(copySessions(this.state.sessions));
    if (this.activeRefresh) {
      if (markDirty) this.dirty = true;
      return this.activeRefresh;
    }
    const refresh = this.runRefreshLoop().finally(() => {
      if (this.activeRefresh === refresh) this.activeRefresh = null;
    });
    this.activeRefresh = refresh;
    return refresh;
  }

  async acknowledge(summary: SessionSurfaceSummary): Promise<void> {
    if (this.disposed) return;
    const snapshot = await this.store.acknowledge(summary);
    if (this.disposed) return;
    this.publish('ready', this.state.sessions, snapshot.unreadKeys);
  }

  async setVisibleLocator(locator?: SessionLocatorV2): Promise<void> {
    if (this.disposed) return;
    this.visibleLocator = locator ? copyLocator(locator) : undefined;
    if (!this.hasCompleteCatalog) return;
    const snapshot = await this.store.reconcile(
      this.state.sessions,
      this.visibleLocator
    );
    if (this.disposed) return;
    this.publish(this.state.status, this.state.sessions, snapshot.unreadKeys);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.disposed = true;
    this.dirty = false;
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
    if (this.pollTimer) {
      this.timerApi.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.listeners.clear();
    this.closePromise = this.service.close('tui-task-attention-controller-closed');
    return this.closePromise;
  }

  private async runRefreshLoop(): Promise<SessionSurfaceSummary[]> {
    let latest = copySessions(this.state.sessions);
    do {
      this.dirty = false;
      latest = await this.refreshOnce();
    } while (!this.disposed && this.dirty);
    return latest;
  }

  private async refreshOnce(): Promise<SessionSurfaceSummary[]> {
    this.publish('loading', this.state.sessions, this.state.unreadKeys);
    try {
      const sessions = await this.readCompleteCatalog();
      if (this.disposed) return copySessions(this.state.sessions);
      const snapshot = await this.store.reconcile(sessions, this.visibleLocator);
      if (this.disposed) return copySessions(this.state.sessions);
      this.hasCompleteCatalog = true;
      this.publish('ready', sessions, snapshot.unreadKeys);
      return copySessions(sessions);
    } catch {
      if (!this.disposed) {
        this.publish('error', this.state.sessions, this.state.unreadKeys);
      }
      return copySessions(this.state.sessions);
    }
  }

  private async readCompleteCatalog(): Promise<SessionSurfaceSummary[]> {
    const sessions: SessionSurfaceSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.service.listPage({
        ...(cursor ? { cursor } : {}),
        limit: CATALOG_PAGE_LIMIT,
      });
      if (this.disposed) return [];
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }

  private publish(
    status: TuiTaskAttentionState['status'],
    sessions: readonly SessionSurfaceSummary[],
    unreadKeys: readonly string[]
  ): void {
    if (this.disposed) return;
    this.state = immutableState(status, sessions, unreadKeys);
    for (const listener of this.listeners) listener(this.state);
  }
}

function immutableState(
  status: TuiTaskAttentionState['status'],
  sessions: readonly SessionSurfaceSummary[],
  unreadKeys: readonly string[]
): TuiTaskAttentionState {
  return Object.freeze({
    status,
    sessions: Object.freeze(copySessions(sessions).map(freezeSummary)),
    unreadKeys: Object.freeze([...unreadKeys]),
  });
}

function freezeSummary(summary: SessionSurfaceSummary): SessionSurfaceSummary {
  Object.freeze(summary.locator.workspace);
  Object.freeze(summary.locator);
  Object.freeze(summary.capabilities.history);
  Object.freeze(summary.capabilities.turn);
  Object.freeze(summary.capabilities.files);
  Object.freeze(summary.capabilities.terminal);
  Object.freeze(summary.capabilities);
  return Object.freeze(summary);
}

function copySessions(
  sessions: readonly SessionSurfaceSummary[]
): SessionSurfaceSummary[] {
  return sessions.map((session) => ({
    ...session,
    locator: copyLocator(session.locator),
    capabilities: {
      ...session.capabilities,
      history: { ...session.capabilities.history },
      turn: { ...session.capabilities.turn },
      files: { ...session.capabilities.files },
      terminal: { ...session.capabilities.terminal },
    },
  }));
}

function copyLocator(locator: SessionLocatorV2): SessionLocatorV2 {
  return locator.workspace.kind === 'local'
    ? {
        ...locator,
        workspace: { ...locator.workspace },
      }
    : {
        ...locator,
        workspace: { ...locator.workspace },
      };
}
