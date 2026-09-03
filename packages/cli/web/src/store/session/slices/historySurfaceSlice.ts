import {
  type SessionLocatorV2,
  type SessionSurfaceErrorCode,
  SessionSurfaceErrorCodeSchema,
  type SessionSurfaceMessage,
  type SessionSurfaceOpenResult,
  type SessionSurfaceSummary,
} from '@api/schemas';
import { isHttpResponseError } from '@/lib/http';
import { sessionService } from '@/services';
import {
  getHistoryPageRequest,
  registerHistoryPageRequest,
  runBoundedHistoryRead,
} from '../historyReadAdmission';
import { sameSurfaceLocator } from '../sessionIdentity';
import type { HistorySurfaceError, HistorySurfaceSlice, SliceCreator } from '../types';

const HISTORY_PAGE_LIMIT = 50;
const MAX_RETAINED_HISTORY_MESSAGES = 500;
const RECOVERABLE_PAGE_CODES = new Set<SessionSurfaceErrorCode>([
  'session_surface_cursor_invalid',
  'session_surface_snapshot_changed',
]);

function toSurfaceError(error: unknown): HistorySurfaceError {
  let code: SessionSurfaceErrorCode | null = null;
  if (isHttpResponseError(error) && error.code !== undefined) {
    try {
      code = SessionSurfaceErrorCodeSchema.parse(error.code);
    } catch {
      code = null;
    }
  }
  return {
    code,
    message: error instanceof Error ? error.message : 'Session history request failed',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function selectionFromResult(
  result: SessionSurfaceOpenResult
): HistorySurfaceSlice['historySurfaceSelection'] {
  return {
    locator: result.session.locator,
    displayCwd: result.session.displayCwd,
    capabilities: result.session.capabilities,
    mode: 'history-only',
  };
}

function boundedHistory(messages: SessionSurfaceMessage[]): SessionSurfaceMessage[] {
  return messages.length <= MAX_RETAINED_HISTORY_MESSAGES
    ? messages
    : messages.slice(-MAX_RETAINED_HISTORY_MESSAGES);
}

function prependDistinctHistory(
  older: readonly SessionSurfaceMessage[],
  current: readonly SessionSurfaceMessage[]
): SessionSurfaceMessage[] {
  const currentIds = new Set(current.map((message) => message.id));
  return [...older.filter((message) => !currentIds.has(message.id)), ...current]
    .slice(0, MAX_RETAINED_HISTORY_MESSAGES)
    .map((message) => ({ ...message }));
}

function sameSurfaceWorkspace(
  left: SessionLocatorV2,
  right: SessionLocatorV2
): boolean {
  if (left.workspace.kind !== right.workspace.kind) return false;
  return left.workspace.kind === 'local' && right.workspace.kind === 'local'
    ? left.workspace.projectPath === right.workspace.projectPath
    : left.workspace.kind === 'acp-remote' && right.workspace.kind === 'acp-remote'
      ? left.workspace.workspaceRef === right.workspace.workspaceRef
      : false;
}

export const createHistorySurfaceSlice: SliceCreator<HistorySurfaceSlice> = (
  set,
  get
) => {
  let catalogGeneration = 0;
  let navigationGeneration = 0;
  let activeController: AbortController | null = null;

  const isCurrent = (generation: number, locator: SessionLocatorV2): boolean =>
    generation === navigationGeneration &&
    sameSurfaceLocator(get().historySurfaceSelection?.locator, locator);

  const beginNavigation = (): { generation: number; controller: AbortController } => {
    activeController?.abort();
    activeController = new AbortController();
    navigationGeneration += 1;
    return { generation: navigationGeneration, controller: activeController };
  };

  const invalidateHistoryNavigation = (): void => {
    navigationGeneration += 1;
    activeController?.abort();
    activeController = null;
  };

  const commitOpen = (
    result: SessionSurfaceOpenResult,
    generation: number,
    locator: SessionLocatorV2,
    recoveryCode: HistorySurfaceSlice['historySurfaceRecoveryCode'] = null
  ): void => {
    if (generation !== navigationGeneration) return;
    if (!sameSurfaceLocator(locator, result.session.locator)) {
      throw new Error('Session history response locator mismatch');
    }
    set({
      historySurfaceSelection: selectionFromResult(result),
      historySurfaceMessages: boundedHistory(result.history.messages),
      historySurfaceOlderCursor: result.history.olderCursor ?? null,
      historySurfaceSnapshot: result.history.snapshot,
      historySurfaceGeneration: generation,
      historySurfaceLoadState: 'ready',
      historySurfaceError: null,
      historySurfaceRecoveryCode: recoveryCode,
      historySurfaceTruncated: result.history.truncated,
    });
  };

  return {
    surfaceCatalog: [],
    surfaceCatalogLoadState: 'idle',
    surfaceCatalogError: null,
    historySurfaceSelection: null,
    historySurfaceMessages: [],
    historySurfaceOlderCursor: null,
    historySurfaceSnapshot: null,
    historySurfaceGeneration: 0,
    historySurfaceLoadState: 'idle',
    historySurfaceError: null,
    historySurfaceRecoveryCode: null,
    historySurfaceTruncated: false,

    loadSurfaceCatalog: async (options = {}) => {
      const generation = ++catalogGeneration;
      set({ surfaceCatalogLoadState: 'loading', surfaceCatalogError: null });
      try {
        const catalog: SessionSurfaceSummary[] = [];
        let cursor: string | undefined;
        do {
          const page = await sessionService.listSurfaceCatalog({
            ...options,
            cursor,
            limit: HISTORY_PAGE_LIMIT,
          });
          if (generation !== catalogGeneration) return;
          for (const summary of page.sessions) {
            const index = catalog.findIndex((candidate) =>
              sameSurfaceLocator(candidate.locator, summary.locator)
            );
            if (index < 0) catalog.push(summary);
            else catalog[index] = summary;
          }
          cursor = page.nextCursor;
        } while (cursor);
        if (generation !== catalogGeneration) return;
        set({
          surfaceCatalog: catalog,
          surfaceCatalogLoadState: 'ready',
          surfaceCatalogError: null,
        });
      } catch (error) {
        if (generation !== catalogGeneration) return;
        set({
          surfaceCatalogLoadState: 'error',
          surfaceCatalogError: toSurfaceError(error),
        });
      }
    },

    openHistorySurface: async (locator, limit = HISTORY_PAGE_LIMIT) => {
      if (locator.workspace.kind === 'local') {
        await get().selectSession({
          sessionId: locator.sessionId,
          projectPath: locator.workspace.projectPath,
        });
        return;
      }
      const { generation, controller } = beginNavigation();
      const viewSelection = get().claimViewSelection();
      set({
        historySurfaceSelection: null,
        historySurfaceMessages: [],
        historySurfaceOlderCursor: null,
        historySurfaceSnapshot: null,
        historySurfaceGeneration: generation,
        historySurfaceLoadState: 'loading',
        historySurfaceError: null,
        historySurfaceRecoveryCode: null,
        historySurfaceTruncated: false,
      });
      try {
        const result = await sessionService.openSurface(
          locator,
          limit,
          controller.signal
        );
        if (viewSelection !== get().getViewSelectionVersion()) return;
        commitOpen(result, generation, locator);
      } catch (error) {
        if (generation !== navigationGeneration || isAbortError(error)) return;
        set({
          historySurfaceLoadState: 'error',
          historySurfaceError: toSurfaceError(error),
        });
      }
    },

    loadOlderSurfaceHistory: async (limit = HISTORY_PAGE_LIMIT) => {
      const state = get();
      if (
        state.historySurfaceSelection &&
        !state.historySurfaceSelection.capabilities.history.read
      ) {
        set({
          historySurfaceError: {
            code: 'session_surface_capability_unavailable',
            message: 'Session history read is unavailable',
          },
        });
        return;
      }
      const locator = state.historySurfaceSelection?.locator;
      const cursor = state.historySurfaceOlderCursor;
      const snapshot = state.historySurfaceSnapshot;
      if (!locator || !cursor || !snapshot) return;
      const existing = getHistoryPageRequest(locator);
      if (existing) return existing;
      const generation = navigationGeneration;
      const controller = activeController;
      if (!controller) return;

      const request = registerHistoryPageRequest(
        locator,
        controller.signal,
        async () => {
          set({ historySurfaceLoadState: 'loading-older', historySurfaceError: null });
          try {
            const page = await runBoundedHistoryRead(controller.signal, () =>
              sessionService.loadSurfaceHistoryPage(
                locator,
                cursor,
                snapshot,
                limit,
                controller.signal
              )
            );
            if (!isCurrent(generation, locator)) return;
            if (page.snapshot !== snapshot) {
              throw new Error('Session history response snapshot mismatch');
            }
            set((current) => ({
              historySurfaceMessages: prependDistinctHistory(
                page.messages,
                current.historySurfaceMessages
              ),
              historySurfaceOlderCursor: page.olderCursor ?? null,
              historySurfaceSnapshot: page.snapshot,
              historySurfaceLoadState: 'ready',
              historySurfaceError: null,
              historySurfaceRecoveryCode: null,
              historySurfaceTruncated:
                current.historySurfaceTruncated || page.truncated,
            }));
          } catch (error) {
            if (!isCurrent(generation, locator) || isAbortError(error)) return;
            const surfaceError = toSurfaceError(error);
            if (surfaceError.code && RECOVERABLE_PAGE_CODES.has(surfaceError.code)) {
              const recoveryCode = surfaceError.code as
                | 'session_surface_cursor_invalid'
                | 'session_surface_snapshot_changed';
              set({
                historySurfaceMessages: [],
                historySurfaceOlderCursor: null,
                historySurfaceSnapshot: null,
                historySurfaceLoadState: 'loading',
                historySurfaceError: null,
                historySurfaceRecoveryCode: recoveryCode,
                historySurfaceTruncated: false,
              });
              try {
                const reopened = await sessionService.openSurface(
                  locator,
                  limit,
                  controller.signal
                );
                commitOpen(reopened, generation, locator, recoveryCode);
              } catch (reopenError) {
                if (!isCurrent(generation, locator) || isAbortError(reopenError))
                  return;
                set({
                  historySurfaceLoadState: 'error',
                  historySurfaceError: toSurfaceError(reopenError),
                });
              }
              return;
            }
            set({
              historySurfaceLoadState: 'error',
              historySurfaceError: surfaceError,
            });
          }
        }
      );
      return request;
    },

    forkHistorySurface: async () => {
      const selection = get().historySurfaceSelection;
      const locator = selection?.locator;
      if (!locator) return;
      if (!selection.capabilities.history.fork) {
        set({
          historySurfaceError: {
            code: 'session_surface_capability_unavailable',
            message: 'Session history fork is unavailable',
          },
        });
        return;
      }
      const { generation, controller } = beginNavigation();
      set({
        historySurfaceGeneration: generation,
        historySurfaceLoadState: 'forking',
        historySurfaceError: null,
        historySurfaceRecoveryCode: null,
      });
      try {
        const result = await sessionService.forkSurface(locator, controller.signal);
        if (!sameSurfaceWorkspace(locator, result.session.locator)) {
          throw new Error('Forked Session workspace mismatch');
        }
        commitOpen(result, generation, result.session.locator);
      } catch (error) {
        if (generation !== navigationGeneration || isAbortError(error)) return;
        set({
          historySurfaceLoadState: 'error',
          historySurfaceError: toSurfaceError(error),
        });
      }
    },

    closeHistorySurface: () => {
      invalidateHistoryNavigation();
      set({
        historySurfaceSelection: null,
        historySurfaceMessages: [],
        historySurfaceOlderCursor: null,
        historySurfaceSnapshot: null,
        historySurfaceGeneration: navigationGeneration,
        historySurfaceLoadState: 'idle',
        historySurfaceError: null,
        historySurfaceRecoveryCode: null,
        historySurfaceTruncated: false,
      });
    },
  };
};
