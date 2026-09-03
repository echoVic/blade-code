import type {
  SessionLocatorV2,
  SessionSurfaceCatalogPage,
  SessionSurfaceErrorCode,
  SessionSurfaceHistoryPage,
  SessionSurfaceMessage,
  SessionSurfaceOpenResult,
  SessionSurfaceSummary,
} from '../../api/sessionSurfaceSchemas.js';
import {
  SessionSurfaceService,
  SessionSurfaceServiceError,
  type SurfaceHistoryPageOptions,
  type SurfaceListOptions,
} from '../../services/SessionSurfaceService.js';

const HISTORY_PAGE_LIMIT = 50;
const MAX_RETAINED_HISTORY_MESSAGES = 500;
const RECOVERABLE_PAGE_ERRORS = new Set<SessionSurfaceErrorCode>([
  'session_surface_cursor_invalid',
  'session_surface_snapshot_changed',
]);

export interface SessionHistoryServiceClient {
  listPage(options?: SurfaceListOptions): Promise<SessionSurfaceCatalogPage>;
  open(
    locator: SessionLocatorV2,
    options?: SurfaceHistoryPageOptions
  ): Promise<SessionSurfaceOpenResult>;
  historyPage(
    locator: SessionLocatorV2,
    options: SurfaceHistoryPageOptions
  ): Promise<SessionSurfaceHistoryPage>;
  fork(locator: SessionLocatorV2): Promise<SessionSurfaceOpenResult>;
  close(reason?: string): Promise<void>;
}

export interface SessionHistoryViewError {
  code: SessionSurfaceErrorCode | null;
  message: string;
}

export interface SessionHistoryViewState {
  viewGeneration: number;
  status: 'idle' | 'loading' | 'ready' | 'loading-older' | 'forking' | 'error';
  session?: SessionSurfaceSummary;
  messages: SessionSurfaceMessage[];
  olderCursor?: string;
  snapshot?: string;
  truncated: boolean;
  error?: SessionHistoryViewError;
}

export interface SessionHistoryActionTarget {
  viewGeneration: number;
  locator: SessionLocatorV2;
  snapshot?: string;
  olderCursor?: string;
}

export interface SessionHistoryControllerOptions {
  serviceFactory?: () => SessionHistoryServiceClient;
  pageLimit?: number;
}

type SessionHistoryListener = (state: SessionHistoryViewState) => void;

function createIdleState(viewGeneration = 0): SessionHistoryViewState {
  return {
    viewGeneration,
    status: 'idle',
    messages: [],
    truncated: false,
  };
}

function sameLocator(left: SessionLocatorV2, right: SessionLocatorV2): boolean {
  if (left.version !== right.version || left.sessionId !== right.sessionId)
    return false;
  if (left.workspace.kind !== right.workspace.kind) return false;
  if (left.workspace.kind === 'local' && right.workspace.kind === 'local') {
    return left.workspace.projectPath === right.workspace.projectPath;
  }
  return (
    left.workspace.kind === 'acp-remote' &&
    right.workspace.kind === 'acp-remote' &&
    left.workspace.workspaceRef === right.workspace.workspaceRef
  );
}

function sameWorkspace(left: SessionLocatorV2, right: SessionLocatorV2): boolean {
  if (left.workspace.kind !== right.workspace.kind) return false;
  if (left.workspace.kind === 'local' && right.workspace.kind === 'local') {
    return left.workspace.projectPath === right.workspace.projectPath;
  }
  return (
    left.workspace.kind === 'acp-remote' &&
    right.workspace.kind === 'acp-remote' &&
    left.workspace.workspaceRef === right.workspace.workspaceRef
  );
}

function fixedErrorMessage(code: SessionSurfaceErrorCode | null): string {
  switch (code) {
    case 'session_surface_not_found':
      return 'Session history is no longer available.';
    case 'session_surface_cursor_invalid':
    case 'session_surface_snapshot_changed':
      return 'Session history changed. Reopen it to continue.';
    case 'session_surface_capability_unavailable':
    case 'session_surface_read_only':
      return 'This action is unavailable in history-only mode.';
    case 'session_surface_capacity':
      return 'Session history is busy. Try again.';
    default:
      return 'Session history is unavailable.';
  }
}

function toViewError(error: unknown): SessionHistoryViewError {
  const code = error instanceof SessionSurfaceServiceError ? error.code : null;
  return { code, message: fixedErrorMessage(code) };
}

function boundedMessages(
  messages: readonly SessionSurfaceMessage[]
): SessionSurfaceMessage[] {
  const retained = messages.slice(-MAX_RETAINED_HISTORY_MESSAGES);
  return retained.map((message) => ({ ...message }));
}

function prependDistinctMessages(
  older: readonly SessionSurfaceMessage[],
  current: readonly SessionSurfaceMessage[]
): SessionSurfaceMessage[] {
  const currentIds = new Set(current.map((message) => message.id));
  return [...older.filter((message) => !currentIds.has(message.id)), ...current]
    .slice(0, MAX_RETAINED_HISTORY_MESSAGES)
    .map((message) => ({ ...message }));
}

export class SessionHistoryController {
  private readonly serviceFactory: () => SessionHistoryServiceClient;
  private readonly pageLimit: number;
  private readonly listeners = new Set<SessionHistoryListener>();
  private service: SessionHistoryServiceClient | null = null;
  private pendingServiceClose: Promise<void> | null = null;
  private ownerClosePromise: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private generation = 0;
  private pageRequest: Promise<void> | null = null;
  private activeActivation: { key: string; promise: Promise<void> } | null = null;
  private disposed = false;
  private state: SessionHistoryViewState = createIdleState();

  constructor(options: SessionHistoryControllerOptions = {}) {
    this.serviceFactory = options.serviceFactory ?? (() => new SessionSurfaceService());
    this.pageLimit = options.pageLimit ?? HISTORY_PAGE_LIMIT;
  }

  getState(): SessionHistoryViewState {
    return this.state;
  }

  subscribe(listener: SessionHistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listPage(options: SurfaceListOptions = {}): Promise<SessionSurfaceCatalogPage> {
    const generation = this.generation;
    await this.waitForPendingServiceClose();
    this.assertOpen();
    if (!this.isCurrent(generation)) {
      throw new SessionSurfaceServiceError('session_surface_unavailable');
    }
    const service = this.service ?? this.createService();
    const page = await service.listPage(options);
    if (!this.isCurrent(generation, service)) {
      throw new SessionSurfaceServiceError('session_surface_unavailable');
    }
    return page;
  }

  async listAll(): Promise<SessionSurfaceSummary[]> {
    const generation = this.generation;
    const sessions: SessionSurfaceSummary[] = [];
    const keys = new Set<string>();
    let cursor: string | undefined;
    do {
      if (!this.isCurrent(generation)) {
        throw new SessionSurfaceServiceError('session_surface_unavailable');
      }
      const page = await this.listPage({ cursor, limit: this.pageLimit });
      if (!this.isCurrent(generation)) {
        throw new SessionSurfaceServiceError('session_surface_unavailable');
      }
      for (const session of page.sessions) {
        const key = locatorKey(session.locator);
        if (keys.has(key)) continue;
        keys.add(key);
        sessions.push(session);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }

  async open(summary: SessionSurfaceSummary): Promise<void> {
    this.assertOpen();
    if (summary.locator.workspace.kind !== 'acp-remote') {
      throw new SessionSurfaceServiceError('invalid_session_locator');
    }

    const generation = ++this.generation;
    this.abortActiveRequest('history-view-replaced');
    const previousService = this.service;
    this.service = null;
    if (!summary.capabilities.history.read) {
      this.setState({
        status: 'error',
        session: summary,
        messages: [],
        truncated: false,
        error: {
          code: 'session_surface_capability_unavailable',
          message: fixedErrorMessage('session_surface_capability_unavailable'),
        },
      });
      await this.closeService(previousService, 'history-view-replaced');
      return;
    }
    this.setState({
      status: 'loading',
      session: summary,
      messages: [],
      truncated: false,
    });
    await this.closeService(previousService, 'history-view-replaced');
    if (!this.isCurrent(generation)) return;

    const service = this.createService();
    const controller = this.beginRequest();
    try {
      const result = await service.open(summary.locator, { limit: this.pageLimit });
      if (!this.isCurrent(generation, service, controller)) return;
      if (!sameLocator(summary.locator, result.session.locator)) {
        throw new SessionSurfaceServiceError('workspace_binding_mismatch');
      }
      this.commitResult(result, 'ready');
    } catch (error) {
      if (!this.isCurrent(generation, service, controller)) return;
      this.setState({
        status: 'error',
        session: summary,
        messages: [],
        truncated: false,
        error: toViewError(error),
      });
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  activate(summary: SessionSurfaceSummary, intent: 'resume' | 'fork'): Promise<void> {
    const key = `${intent}\0${locatorKey(summary.locator)}`;
    if (this.activeActivation?.key === key) return this.activeActivation.promise;
    const promise = this.activateUnshared(summary, intent).finally(() => {
      if (this.activeActivation?.promise === promise) this.activeActivation = null;
    });
    this.activeActivation = { key, promise };
    return promise;
  }

  private async activateUnshared(
    summary: SessionSurfaceSummary,
    intent: 'resume' | 'fork'
  ): Promise<void> {
    if (intent === 'resume') return this.open(summary);
    this.assertOpen();
    if (
      summary.locator.workspace.kind !== 'acp-remote' ||
      !summary.capabilities.history.fork
    ) {
      throw new SessionSurfaceServiceError('session_surface_capability_unavailable');
    }

    const generation = ++this.generation;
    this.abortActiveRequest('history-view-replaced');
    this.setState({
      status: 'forking',
      session: summary,
      messages: [],
      truncated: false,
    });
    const previousService = this.service;
    this.service = null;
    await this.closeService(previousService, 'history-view-replaced');
    if (!this.isCurrent(generation)) return;

    const service = this.createService();
    const controller = this.beginRequest();
    try {
      const result = await service.fork(summary.locator);
      if (!this.isCurrent(generation, service, controller)) return;
      if (
        result.session.locator.workspace.kind !== 'acp-remote' ||
        !sameWorkspace(summary.locator, result.session.locator)
      ) {
        throw new SessionSurfaceServiceError('workspace_binding_mismatch');
      }
      this.commitResult(result, 'ready');
    } catch (error) {
      if (!this.isCurrent(generation, service, controller)) return;
      this.setState({
        status: 'error',
        session: summary,
        messages: [],
        truncated: false,
        error: toViewError(error),
      });
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  loadOlder(target: SessionHistoryActionTarget): Promise<void> {
    if (this.pageRequest) return this.pageRequest;
    if (this.state.status !== 'ready' && this.state.status !== 'error') {
      return Promise.resolve();
    }
    const { session, olderCursor, snapshot } = this.state;
    const service = this.service;
    if (
      !service ||
      !session ||
      !olderCursor ||
      !snapshot ||
      !session.capabilities.history.read ||
      !this.matchesActionTarget(target) ||
      target.olderCursor !== olderCursor
    ) {
      return Promise.resolve();
    }

    const generation = this.generation;
    const controller = this.beginRequest();
    this.setState({ ...this.state, status: 'loading-older', error: undefined });
    const request = service
      .historyPage(session.locator, {
        cursor: olderCursor,
        expectedSnapshot: snapshot,
        limit: this.pageLimit,
      })
      .then((page) => {
        if (!this.isCurrent(generation, service, controller)) return;
        if (page.snapshot !== snapshot) {
          throw new SessionSurfaceServiceError('session_surface_snapshot_changed');
        }
        this.setState({
          ...this.state,
          status: 'ready',
          messages: prependDistinctMessages(page.messages, this.state.messages),
          olderCursor: page.olderCursor,
          snapshot: page.snapshot,
          truncated: this.state.truncated || page.truncated,
          error: undefined,
        });
      })
      .catch(async (error: unknown) => {
        if (!this.isCurrent(generation, service, controller)) return;
        if (
          error instanceof SessionSurfaceServiceError &&
          RECOVERABLE_PAGE_ERRORS.has(error.code)
        ) {
          this.setState({
            status: 'loading',
            session,
            messages: [],
            truncated: false,
          });
          try {
            const reopened = await service.open(session.locator, {
              limit: this.pageLimit,
            });
            if (!this.isCurrent(generation, service, controller)) return;
            if (!sameLocator(session.locator, reopened.session.locator)) {
              throw new SessionSurfaceServiceError('workspace_binding_mismatch');
            }
            this.commitResult(reopened, 'ready');
          } catch (reopenError) {
            if (!this.isCurrent(generation, service, controller)) return;
            this.setState({
              status: 'error',
              session,
              messages: [],
              truncated: false,
              error: toViewError(reopenError),
            });
          }
          return;
        }
        this.setState({ ...this.state, status: 'error', error: toViewError(error) });
      })
      .finally(() => {
        if (this.activeController === controller) this.activeController = null;
        if (this.pageRequest === request) this.pageRequest = null;
      });
    this.pageRequest = request;
    return request;
  }

  async fork(target: SessionHistoryActionTarget): Promise<void> {
    if (this.state.status !== 'ready') return;
    const session = this.state.session;
    const previousService = this.service;
    if (!session || !previousService || !this.matchesActionTarget(target)) return;
    if (!session.capabilities.history.fork) {
      this.setState({
        ...this.state,
        status: 'error',
        error: {
          code: 'session_surface_capability_unavailable',
          message: fixedErrorMessage('session_surface_capability_unavailable'),
        },
      });
      return;
    }

    const generation = ++this.generation;
    this.abortActiveRequest('history-fork');
    this.setState({ ...this.state, status: 'forking', error: undefined });
    this.service = null;
    await this.closeService(previousService, 'history-fork');
    if (!this.isCurrent(generation)) return;
    const service = this.createService();
    const controller = this.beginRequest();
    try {
      const result = await service.fork(session.locator);
      if (!this.isCurrent(generation, service, controller)) return;
      if (
        result.session.locator.workspace.kind !== 'acp-remote' ||
        !sameWorkspace(session.locator, result.session.locator)
      ) {
        throw new SessionSurfaceServiceError('workspace_binding_mismatch');
      }
      this.commitResult(result, 'ready');
    } catch (error) {
      if (!this.isCurrent(generation, service, controller)) return;
      this.setState({ ...this.state, status: 'error', error: toViewError(error) });
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  async closeView(): Promise<void> {
    this.generation += 1;
    this.activeActivation = null;
    this.abortActiveRequest('history-view-closed');
    this.pageRequest = null;
    const service = this.service;
    this.service = null;
    this.setState(createIdleState(this.generation));
    await this.closeService(service, 'history-view-closed');
  }

  close(): Promise<void> {
    if (this.ownerClosePromise) return this.ownerClosePromise;
    this.disposed = true;
    this.listeners.clear();
    this.ownerClosePromise = this.closeView();
    return this.ownerClosePromise;
  }

  private createService(): SessionHistoryServiceClient {
    const service = this.serviceFactory();
    this.service = service;
    return service;
  }

  private closeService(
    service: SessionHistoryServiceClient | null,
    reason: string
  ): Promise<void> {
    if (!service) return this.waitForPendingServiceClose();
    const previousClose = this.pendingServiceClose;
    const closing = (async () => {
      if (previousClose) await previousClose;
      await service.close(reason);
    })();
    this.pendingServiceClose = closing;
    const clearPendingClose = () => {
      if (this.pendingServiceClose === closing) this.pendingServiceClose = null;
    };
    void closing.then(clearPendingClose, clearPendingClose);
    return closing;
  }

  private waitForPendingServiceClose(): Promise<void> {
    return this.pendingServiceClose ?? Promise.resolve();
  }

  private matchesActionTarget(target: SessionHistoryActionTarget): boolean {
    const session = this.state.session;
    return (
      session !== undefined &&
      target.viewGeneration === this.state.viewGeneration &&
      sameLocator(target.locator, session.locator) &&
      target.snapshot === this.state.snapshot
    );
  }

  private beginRequest(): AbortController {
    this.abortActiveRequest('history-request-replaced');
    const controller = new AbortController();
    this.activeController = controller;
    return controller;
  }

  private abortActiveRequest(reason: string): void {
    this.activeController?.abort(reason);
    this.activeController = null;
  }

  private isCurrent(
    generation: number,
    service?: SessionHistoryServiceClient,
    controller?: AbortController
  ): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      (service === undefined || service === this.service) &&
      (controller === undefined || !controller.signal.aborted)
    );
  }

  private commitResult(
    result: SessionSurfaceOpenResult,
    status: SessionHistoryViewState['status']
  ): void {
    this.setState({
      status,
      session: result.session,
      messages: boundedMessages(result.history.messages),
      olderCursor: result.history.olderCursor,
      snapshot: result.history.snapshot,
      truncated: result.history.truncated,
    });
  }

  private setState(
    state: Omit<SessionHistoryViewState, 'viewGeneration'> & { viewGeneration?: number }
  ): void {
    this.state = {
      ...state,
      viewGeneration: state.viewGeneration ?? this.generation,
    };
    for (const listener of this.listeners) listener(this.state);
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new SessionSurfaceServiceError('session_surface_unavailable');
    }
  }
}

function locatorKey(locator: SessionLocatorV2): string {
  return locator.workspace.kind === 'local'
    ? `${locator.version}\0local\0${locator.workspace.projectPath}\0${locator.sessionId}`
    : `${locator.version}\0acp-remote\0${locator.workspace.workspaceRef}\0${locator.sessionId}`;
}
