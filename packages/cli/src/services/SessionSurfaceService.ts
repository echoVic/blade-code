import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { AcpServiceContext } from '../acp/AcpServiceContext.js';
import {
  type SessionLocatorV2,
  SessionLocatorV2Schema,
  type SessionSurfaceCapabilities,
  type SessionSurfaceCatalogPage,
  SessionSurfaceCatalogPageSchema,
  type SessionSurfaceErrorCode,
  type SessionSurfaceHistoryPage,
  SessionSurfaceHistoryPageSchema,
  SessionSurfaceMessageSchema,
  type SessionSurfaceOpenResult,
  SessionSurfaceOpenResultSchema,
  type SessionSurfaceSummary,
  SessionSurfaceSummarySchema,
} from '../api/sessionSurfaceSchemas.js';
import { getBladeStorageRoot, isValidSessionId } from '../context/storage/pathUtils.js';
import type { SqliteDb } from '../context/storage/sqlite/driver.js';
import {
  getProjectionDb,
  getSessionSurfaceHistoryByteLimit,
  type ProjectedSurfaceCandidate,
  type ProjectedSurfaceCatalogBoundary,
  projectSessionSurfaceSummaryFields,
  readSessionSurfaceCandidates,
  readSessionSurfaceCatalogPage,
  readSessionSurfaceCatalogRevision,
  readSessionSurfaceHistoryPage,
  removeSessionFromProjection,
  syncAllAcpRemoteScopes,
  syncSession,
} from '../context/storage/sqlite/projection.js';
import type { JsonObject, JsonValue } from '../store/types.js';
import { SessionService } from './SessionService.js';
import {
  SessionSurfaceCursorRegistry,
  type SessionSurfaceCursorRegistryOptions,
} from './SessionSurfaceCursorRegistry.js';
import { projectSessionSurfaceMessages } from './sessionSurfaceProjection.js';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const DEFAULT_MAX_CONCURRENT_OPERATIONS = 16;
const MAX_FALLBACK_CATALOG_ROWS = 10_000;
const MAX_FALLBACK_CATALOG_BYTES = 16 * 1024 * 1024;

export interface SurfaceListOptions {
  archived?: boolean;
  cursor?: string;
  limit?: number;
  workspaceKind?: 'local' | 'acp-remote';
}

export interface SurfaceHistoryPageOptions {
  cursor?: string;
  expectedSnapshot?: string;
  limit?: number;
}

export interface SessionSurfaceServiceOptions {
  database?: SqliteDb | null;
  cursorRegistry?: SessionSurfaceCursorRegistry;
  cursorRegistryOptions?: SessionSurfaceCursorRegistryOptions;
  epochSource?: () => string;
  maxConcurrentOperations?: number;
}

export class SessionSurfaceServiceError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: SessionSurfaceErrorCode) {
    const details = errorDetails(code);
    super(details.message);
    this.name = 'SessionSurfaceServiceError';
    this.retryable = details.retryable;
  }
}

type ResolvedSessionSurface = {
  candidate: ProjectedSurfaceCandidate;
  remoteCandidate?: Awaited<
    ReturnType<typeof SessionService.listValidatedRemoteSurfaceCandidates>
  >[number];
};

type CatalogCursorRequest = JsonObject & {
  archived: boolean;
  limit: number;
  workspaceKind: 'local' | 'acp-remote' | null;
};

type HistoryCursorRequest = JsonObject & {
  expectedSnapshot: string;
  limit: number;
};

type FallbackCatalogEntry = {
  locator: SessionLocatorV2;
  summary: Omit<SessionSurfaceSummary, 'locator' | 'capabilities'>;
};

type FallbackCatalogBoundary = {
  chainId: string;
  entries: readonly FallbackCatalogEntry[];
};

interface CatalogCursorBoundary extends ProjectedSurfaceCatalogBoundary {
  chainId: string;
}

export class SessionSurfaceService {
  private readonly database: SqliteDb | null | undefined;
  private readonly registry: SessionSurfaceCursorRegistry;
  private readonly epoch: string;
  private readonly maxConcurrentOperations: number;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise?: Promise<void>;
  private concurrentOperations = 0;

  constructor(options: SessionSurfaceServiceOptions = {}) {
    this.database = options.database;
    this.registry =
      options.cursorRegistry ??
      new SessionSurfaceCursorRegistry(options.cursorRegistryOptions);
    this.epoch =
      options.epochSource?.() ??
      `session-surface-epoch:${randomBytes(32).toString('base64url')}`;
    this.maxConcurrentOperations =
      options.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT_OPERATIONS;
    if (
      !Number.isSafeInteger(this.maxConcurrentOperations) ||
      this.maxConcurrentOperations < 1 ||
      this.maxConcurrentOperations > 256
    ) {
      throw new Error('maxConcurrentOperations must be an integer from 1 to 256');
    }
  }

  async listPage(options: SurfaceListOptions = {}): Promise<SessionSurfaceCatalogPage> {
    return this.runOperation(async (signal) => {
      const limit = normalizeLimit(options.limit);
      const archived = options.archived ?? false;
      const request: CatalogCursorRequest = {
        archived,
        limit,
        workspaceKind: options.workspaceKind ?? null,
      };
      const scopeKey = JSON.stringify([archived, options.workspaceKind ?? null]);
      const database = await this.requireDatabase();
      signal.throwIfAborted();
      if (!database) {
        return this.listFallbackPage(request, scopeKey, signal, options.cursor);
      }
      await this.syncAllSurfaces(database, signal);
      if (options.cursor) {
        const revision = String(readSessionSurfaceCatalogRevision(database));
        return this.registry.redeemCatalogCursor({
          token: options.cursor,
          scopeKey,
          epoch: this.epoch,
          revision,
          request,
          loader: async ({ boundary }) => {
            const parsedBoundary = parseCatalogBoundary(boundary);
            return this.loadCatalogPage(
              database,
              request,
              scopeKey,
              revision,
              parsedBoundary,
              parsedBoundary.chainId,
              signal
            );
          },
        });
      }

      return this.loadCatalogPage(
        database,
        request,
        scopeKey,
        undefined,
        undefined,
        undefined,
        signal
      );
    });
  }

  async open(
    locator: SessionLocatorV2,
    options: SurfaceHistoryPageOptions = {}
  ): Promise<SessionSurfaceOpenResult> {
    return this.runOperation((signal) => this.openInternal(locator, options, signal));
  }

  async historyPage(
    locator: SessionLocatorV2,
    options: SurfaceHistoryPageOptions
  ): Promise<SessionSurfaceHistoryPage> {
    return this.runOperation(async (signal) => {
      const parsedLocator = parseLocator(locator);
      const limit = normalizeLimit(options.limit);
      if (!options.cursor || !options.expectedSnapshot) {
        throw new SessionSurfaceServiceError('invalid_session_surface_request');
      }
      const database = await this.requireDatabase();
      if (!database) {
        return this.readFallbackHistoryPage(parsedLocator, options, signal);
      }
      await this.syncForLocator(database, parsedLocator, signal);
      const resolved = await this.resolveFromProjection(
        database,
        parsedLocator,
        signal
      );
      const current = readSessionSurfaceHistoryPage(database, {
        sourceKind: resolved.candidate.sourceKind,
        projectPath: resolved.candidate.projectPath,
        sessionId: resolved.candidate.sessionId,
        limit: 1,
      });
      const locatorDigest = digestLocator(parsedLocator);
      await this.registry.assertSnapshotToken({
        token: options.expectedSnapshot,
        locatorDigest,
        transcriptFingerprint: current.transcriptFingerprint,
      });
      const request: HistoryCursorRequest = {
        expectedSnapshot: options.expectedSnapshot,
        limit,
      };
      const page = await this.registry.redeemHistoryCursor({
        token: options.cursor,
        locatorDigest,
        transcriptFingerprint: current.transcriptFingerprint,
        request,
        loader: async ({ nextSequence }) => {
          const history = readSessionSurfaceHistoryPage(database, {
            sourceKind: resolved.candidate.sourceKind,
            projectPath: resolved.candidate.projectPath,
            sessionId: resolved.candidate.sessionId,
            beforeSequence: nextSequence,
            limit,
          });
          return this.publicHistoryPage({
            history,
            snapshot: options.expectedSnapshot!,
            chainId: (
              await this.registry.assertSnapshotToken({
                token: options.expectedSnapshot!,
                locatorDigest,
                transcriptFingerprint: current.transcriptFingerprint,
              })
            ).chainId,
            locatorDigest,
            limit,
          });
        },
      });
      return SessionSurfaceHistoryPageSchema.parse(page);
    });
  }

  async fork(locator: SessionLocatorV2): Promise<SessionSurfaceOpenResult> {
    return this.runOperation(async (signal) => {
      const parsedLocator = parseLocator(locator);
      const database = await this.requireDatabase();
      const resolved = database
        ? await this.resolveFromProjectionAfterSync(database, parsedLocator, signal)
        : await this.resolveFallback(parsedLocator, signal);
      if (resolved.candidate.summary.archivedAt) {
        throw new SessionSurfaceServiceError('session_surface_read_only');
      }
      signal.throwIfAborted();
      const forked = await SessionService.forkSession(parsedLocator.sessionId, {
        sourceProjectPath: resolved.candidate.projectPath,
        targetProjectPath: resolved.candidate.projectPath,
        ...(resolved.remoteCandidate
          ? { remote: { expectedDescriptor: resolved.remoteCandidate.descriptor } }
          : {}),
      });
      const childLocator: SessionLocatorV2 = resolved.remoteCandidate
        ? {
            version: 2,
            sessionId: forked.sessionId,
            workspace: {
              kind: 'acp-remote',
              workspaceRef: resolved.candidate.publicWorkspaceRef!,
            },
          }
        : {
            version: 2,
            sessionId: forked.sessionId,
            workspace: { kind: 'local', projectPath: resolved.candidate.projectPath },
          };
      return database
        ? this.openInternal(childLocator, {}, signal)
        : this.openFallback(childLocator, DEFAULT_PAGE_LIMIT, signal);
    });
  }

  private async resolveFromProjectionAfterSync(
    database: SqliteDb,
    locator: SessionLocatorV2,
    signal: AbortSignal
  ): Promise<ResolvedSessionSurface> {
    await this.syncForLocator(database, locator, signal);
    return this.resolveFromProjection(database, locator, signal);
  }

  async close(reason?: string): Promise<void> {
    void reason;
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const controller of this.activeControllers) {
      controller.abort(new SessionSurfaceServiceError('session_surface_unavailable'));
    }
    this.closePromise = Promise.allSettled([
      ...this.activeOperations,
      this.registry.close(),
    ]).then(() => undefined);
    return this.closePromise;
  }

  private async openInternal(
    locator: SessionLocatorV2,
    options: SurfaceHistoryPageOptions = {},
    signal?: AbortSignal
  ): Promise<SessionSurfaceOpenResult> {
    const parsedLocator = parseLocator(locator);
    const limit = normalizeLimit(options.limit);
    if (options.cursor !== undefined || options.expectedSnapshot !== undefined) {
      throw new SessionSurfaceServiceError('invalid_session_surface_request');
    }
    const database = await this.requireDatabase();
    if (!database) {
      return this.openFallback(parsedLocator, limit, signal);
    }
    await this.syncForLocator(database, parsedLocator, signal);
    const resolved = await this.resolveFromProjection(database, parsedLocator, signal);
    const history = readSessionSurfaceHistoryPage(database, {
      sourceKind: resolved.candidate.sourceKind,
      projectPath: resolved.candidate.projectPath,
      sessionId: resolved.candidate.sessionId,
      limit,
    });
    const chainId = `history-chain:${randomBytes(16).toString('base64url')}`;
    const locatorDigest = digestLocator(parsedLocator);
    const snapshot = this.registry.issueSnapshotToken({
      chainId,
      locatorDigest,
      transcriptFingerprint: history.transcriptFingerprint,
    });
    const result: SessionSurfaceOpenResult = {
      session: this.toSummary(resolved),
      history: this.publicHistoryPage({
        history,
        snapshot,
        chainId,
        locatorDigest,
        limit,
      }),
    };
    return SessionSurfaceOpenResultSchema.parse(result);
  }

  private runOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertAvailable();
    if (this.concurrentOperations >= this.maxConcurrentOperations) {
      throw new SessionSurfaceServiceError('session_surface_capacity');
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    this.concurrentOperations += 1;
    let tracked: Promise<T>;
    tracked = Promise.resolve()
      .then(() => operation(controller.signal))
      .then((value) => {
        if (controller.signal.aborted || this.closed) {
          throw new SessionSurfaceServiceError('session_surface_unavailable');
        }
        return value;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.closed) {
          throw new SessionSurfaceServiceError('session_surface_unavailable');
        }
        throw normalizeSurfaceError(error);
      })
      .finally(() => {
        this.activeControllers.delete(controller);
        this.activeOperations.delete(tracked);
        this.concurrentOperations -= 1;
      });
    this.activeOperations.add(tracked);
    return tracked;
  }

  private async loadCatalogPage(
    database: SqliteDb,
    request: CatalogCursorRequest,
    scopeKey: string,
    expectedRevision?: string,
    boundary?: ProjectedSurfaceCatalogBoundary,
    chainId?: string,
    signal?: AbortSignal
  ): Promise<SessionSurfaceCatalogPage> {
    const page = readSessionSurfaceCatalogPage(database, {
      archived: request.archived,
      limit: request.limit,
      ...(request.workspaceKind ? { workspaceKind: request.workspaceKind } : {}),
      ...(boundary ? { boundary } : {}),
    });
    const revision = String(page.revision);
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new SessionSurfaceServiceError('session_surface_snapshot_changed');
    }
    const activeChainId =
      chainId ?? `catalog-chain:${randomBytes(16).toString('base64url')}`;
    const result: SessionSurfaceCatalogPage = {
      sessions: await Promise.all(
        page.sessions.map(async (candidate) =>
          this.toSummary(await this.resolveCandidate(candidate, signal))
        )
      ),
      ...(page.nextBoundary
        ? {
            nextCursor: this.registry.issueCatalogCursor({
              chainId: activeChainId,
              scopeKey,
              epoch: this.epoch,
              revision,
              boundary: {
                ...page.nextBoundary,
                chainId: activeChainId,
              } as JsonValue,
              request,
            }),
          }
        : {}),
    };
    if (!page.nextBoundary) this.registry.completeChain(activeChainId);
    return SessionSurfaceCatalogPageSchema.parse(result);
  }

  private publicHistoryPage(input: {
    history: ReturnType<typeof readSessionSurfaceHistoryPage>;
    snapshot: string;
    chainId: string;
    locatorDigest: string;
    limit: number;
  }): SessionSurfaceHistoryPage {
    const boundedMessages = boundHistoryMessages(
      input.history.messages,
      getSessionSurfaceHistoryByteLimit()
    );
    const result: SessionSurfaceHistoryPage = {
      messages: boundedMessages.messages,
      snapshot: input.snapshot,
      truncated:
        input.history.hasOlder ||
        boundedMessages.truncated ||
        boundedMessages.messages.some((message) => message.truncated === true),
      ...(input.history.hasOlder && input.history.nextSequence !== undefined
        ? {
            olderCursor: this.registry.issueHistoryCursor({
              chainId: input.chainId,
              locatorDigest: input.locatorDigest,
              transcriptFingerprint: input.history.transcriptFingerprint,
              nextSequence: input.history.nextSequence,
              snapshotToken: input.snapshot,
              request: { expectedSnapshot: input.snapshot, limit: input.limit },
            }),
          }
        : {}),
    };
    if (!input.history.hasOlder) this.registry.completeChain(input.chainId);
    return SessionSurfaceHistoryPageSchema.parse(result);
  }

  private async syncForLocator(
    database: SqliteDb,
    locator: SessionLocatorV2,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    if (locator.workspace.kind === 'local') {
      await syncSession(
        database,
        locator.sessionId,
        locator.workspace.projectPath,
        SessionService.projectionDeriverForSearch(),
        undefined,
        'local',
        signal
      );
      return;
    }
    await syncAllAcpRemoteScopes(
      database,
      SessionService.projectionDeriverForSearch(),
      signal
    );
  }

  private async syncAllSurfaces(
    database: SqliteDb,
    signal?: AbortSignal
  ): Promise<void> {
    const derive = SessionService.projectionDeriverForSearch();
    const localCandidates =
      await SessionService.listValidatedLocalSurfaceCandidates(signal);
    const liveLocalKeys = new Set(
      localCandidates.map(
        (candidate) => `${candidate.projectPath}\0${candidate.sessionId}`
      )
    );
    const projectedLocalRows = database
      .prepare(
        `SELECT project_path, session_id FROM sessions WHERE source_kind='local'`
      )
      .all<{ project_path: string; session_id: string }>();
    for (const row of projectedLocalRows) {
      if (!liveLocalKeys.has(`${row.project_path}\0${row.session_id}`)) {
        removeSessionFromProjection(
          database,
          row.session_id,
          row.project_path,
          'local'
        );
      }
    }
    for (const candidate of localCandidates) {
      signal?.throwIfAborted();
      await syncSession(
        database,
        candidate.sessionId,
        candidate.projectPath,
        derive,
        undefined,
        'local',
        signal
      );
    }
    await syncAllAcpRemoteScopes(database, derive, signal);
  }

  private async listFallbackPage(
    request: CatalogCursorRequest,
    scopeKey: string,
    signal: AbortSignal,
    cursor?: string
  ): Promise<SessionSurfaceCatalogPage> {
    if (cursor) {
      return this.registry.redeemCatalogCursor({
        token: cursor,
        scopeKey,
        epoch: this.epoch,
        revision: 'fallback',
        request,
        loader: async ({ boundary }) => {
          const parsedBoundary = parseFallbackCatalogBoundary(boundary);
          return this.pageFallbackCatalog(
            parsedBoundary.entries,
            request,
            scopeKey,
            parsedBoundary.chainId
          );
        },
      });
    }
    const snapshot = await this.loadFallbackCatalog(request, signal);
    return this.pageFallbackCatalog(
      snapshot,
      request,
      scopeKey,
      `catalog-fallback:${randomBytes(16).toString('base64url')}`
    );
  }

  private async loadFallbackCatalog(
    request: CatalogCursorRequest,
    signal?: AbortSignal
  ): Promise<readonly FallbackCatalogEntry[]> {
    const entries: FallbackCatalogEntry[] = [];
    if (request.workspaceKind !== 'acp-remote') {
      for (const candidate of await SessionService.listValidatedLocalSurfaceCandidates(
        signal
      )) {
        signal?.throwIfAborted();
        const snapshot = await SessionService.readValidatedLocalSurfaceSnapshot(
          candidate.sessionId,
          candidate.projectPath,
          signal
        );
        const summary = snapshot.summary;
        if (Boolean(summary.archivedAt) !== request.archived) continue;
        entries.push({
          locator: {
            version: 2,
            sessionId: candidate.sessionId,
            workspace: { kind: 'local', projectPath: candidate.projectPath },
          },
          summary,
        });
      }
    }
    if (request.workspaceKind !== 'local') {
      for (const candidate of await SessionService.listValidatedRemoteSurfaceCandidates(
        signal
      )) {
        signal?.throwIfAborted();
        const snapshot = await SessionService.readValidatedRemoteSurfaceSnapshot(
          candidate,
          signal
        );
        const summary = snapshot.summary;
        if (Boolean(summary.archivedAt) !== request.archived) continue;
        entries.push({
          locator: {
            version: 2,
            sessionId: candidate.sessionId,
            workspace: {
              kind: 'acp-remote',
              workspaceRef: candidate.workspaceRef,
            },
          },
          summary,
        });
      }
    }
    entries.sort(compareFallbackCatalogEntries);
    const bytes = Buffer.byteLength(JSON.stringify(entries));
    if (
      entries.length > MAX_FALLBACK_CATALOG_ROWS ||
      bytes > MAX_FALLBACK_CATALOG_BYTES
    ) {
      throw new SessionSurfaceServiceError('session_surface_capacity');
    }
    return entries;
  }

  private async pageFallbackCatalog(
    snapshot: readonly FallbackCatalogEntry[],
    request: CatalogCursorRequest,
    scopeKey: string,
    chainId: string
  ): Promise<SessionSurfaceCatalogPage> {
    const pageEntries = snapshot.slice(0, request.limit);
    const remaining = snapshot.slice(pageEntries.length);
    const sessions = pageEntries.map((entry) =>
      SessionSurfaceSummarySchema.parse({
        locator: entry.locator,
        ...entry.summary,
        capabilities:
          entry.locator.workspace.kind === 'local'
            ? localCapabilities(Boolean(entry.summary.archivedAt))
            : remoteFallbackCapabilities(Boolean(entry.summary.archivedAt)),
      })
    );
    const result: SessionSurfaceCatalogPage = {
      sessions,
      ...(remaining.length > 0
        ? {
            nextCursor: this.registry.issueCatalogCursor({
              chainId,
              scopeKey,
              epoch: this.epoch,
              revision: 'fallback',
              boundary: { chainId, entries: remaining } as JsonValue,
              request,
            }),
          }
        : {}),
    };
    if (remaining.length === 0) this.registry.completeChain(chainId);
    return SessionSurfaceCatalogPageSchema.parse(result);
  }

  private async openFallback(
    locator: SessionLocatorV2,
    limit: number,
    signal?: AbortSignal
  ): Promise<SessionSurfaceOpenResult> {
    const resolved = await this.resolveFallback(locator, signal);
    const snapshot = resolved.remoteCandidate
      ? await SessionService.readValidatedRemoteSurfaceSnapshot(
          resolved.remoteCandidate,
          signal
        )
      : await SessionService.readValidatedLocalSurfaceSnapshot(
          resolved.candidate.sessionId,
          resolved.candidate.projectPath,
          signal
        );
    const messages = projectSessionSurfaceMessages(snapshot.entries, {
      privateRoots: resolved.remoteCandidate
        ? [resolved.remoteCandidate.hostStateRoot]
        : [],
      bladeStorageRoots: [getBladeStorageRoot()],
    });
    const selected = boundHistoryMessages(
      messages.slice(-limit),
      getSessionSurfaceHistoryByteLimit()
    );
    const chainId = `history-fallback:${randomBytes(16).toString('base64url')}`;
    const locatorDigest = digestLocator(locator);
    const transcriptFingerprint = createHash('sha256')
      .update(JSON.stringify(snapshot.entries))
      .digest('hex');
    const snapshotToken = this.registry.issueSnapshotToken({
      chainId,
      locatorDigest,
      transcriptFingerprint,
      frozenSnapshot: messages as JsonValue,
    });
    const result: SessionSurfaceOpenResult = {
      session: this.toSummary(resolved),
      history: SessionSurfaceHistoryPageSchema.parse({
        messages: selected.messages,
        snapshot: snapshotToken,
        truncated:
          selected.messages.length < messages.length ||
          selected.truncated ||
          selected.messages.some((message) => message.truncated === true),
        ...(messages.length > selected.messages.length && selected.messages[0]
          ? {
              olderCursor: this.registry.issueHistoryCursor({
                chainId,
                locatorDigest,
                transcriptFingerprint,
                nextSequence: surfaceMessageSequence(selected.messages[0].id),
                snapshotToken,
                request: { expectedSnapshot: snapshotToken, limit },
              }),
            }
          : {}),
      }),
    };
    if (messages.length <= selected.messages.length)
      this.registry.completeChain(chainId);
    return SessionSurfaceOpenResultSchema.parse(result);
  }

  private async readFallbackHistoryPage(
    locator: SessionLocatorV2,
    options: SurfaceHistoryPageOptions,
    signal?: AbortSignal
  ): Promise<SessionSurfaceHistoryPage> {
    const limit = normalizeLimit(options.limit);
    if (!options.cursor || !options.expectedSnapshot) {
      throw new SessionSurfaceServiceError('invalid_session_surface_request');
    }
    const locatorDigest = digestLocator(locator);
    const resolved = await this.resolveFallback(locator, signal);
    const snapshot = resolved.remoteCandidate
      ? await SessionService.readValidatedRemoteSurfaceSnapshot(
          resolved.remoteCandidate,
          signal
        )
      : await SessionService.readValidatedLocalSurfaceSnapshot(
          resolved.candidate.sessionId,
          resolved.candidate.projectPath,
          signal
        );
    const currentFingerprint = createHash('sha256')
      .update(JSON.stringify(snapshot.entries))
      .digest('hex');
    await this.registry.assertSnapshotToken({
      token: options.expectedSnapshot,
      locatorDigest,
      transcriptFingerprint: currentFingerprint,
    });
    const request: HistoryCursorRequest = {
      expectedSnapshot: options.expectedSnapshot,
      limit,
    };
    return this.registry.redeemHistoryCursor<
      SessionSurfaceHistoryPage,
      JsonValue,
      HistoryCursorRequest
    >({
      token: options.cursor,
      locatorDigest,
      transcriptFingerprint: currentFingerprint,
      request,
      loader: async ({ nextSequence, frozenSnapshot }) => {
        const messages = parseFallbackMessages(frozenSnapshot).filter(
          (message) => surfaceMessageSequence(message.id) < nextSequence
        );
        const selected = boundHistoryMessages(
          messages.slice(-limit),
          getSessionSurfaceHistoryByteLimit()
        );
        const snapshotState = await this.registry.assertSnapshotToken({
          token: options.expectedSnapshot!,
          locatorDigest,
          transcriptFingerprint: currentFingerprint,
        });
        const hasOlder = selected.messages.length < messages.length;
        const page: SessionSurfaceHistoryPage = {
          messages: selected.messages,
          snapshot: options.expectedSnapshot!,
          truncated:
            hasOlder ||
            selected.truncated ||
            selected.messages.some((message) => message.truncated === true),
          ...(hasOlder && selected.messages[0]
            ? {
                olderCursor: this.registry.issueHistoryCursor({
                  chainId: snapshotState.chainId,
                  locatorDigest,
                  transcriptFingerprint: currentFingerprint,
                  nextSequence: surfaceMessageSequence(selected.messages[0].id),
                  snapshotToken: options.expectedSnapshot!,
                  request,
                }),
              }
            : {}),
        };
        if (!hasOlder) this.registry.completeChain(snapshotState.chainId);
        return SessionSurfaceHistoryPageSchema.parse(page);
      },
    });
  }

  private async resolveFallback(
    locator: SessionLocatorV2,
    signal?: AbortSignal
  ): Promise<ResolvedSessionSurface> {
    const entries: FallbackCatalogEntry[] = [];
    for (const archived of [false, true]) {
      const request: CatalogCursorRequest = {
        archived,
        limit: MAX_PAGE_LIMIT,
        workspaceKind: locator.workspace.kind,
      };
      entries.push(
        ...(await this.loadFallbackCatalog(request, signal)).filter(
          (entry) => JSON.stringify(entry.locator) === JSON.stringify(locator)
        )
      );
    }
    if (entries.length !== 1) {
      throw new SessionSurfaceServiceError('session_surface_not_found');
    }
    const entry = entries[0]!;
    let remoteCandidate: ResolvedSessionSurface['remoteCandidate'];
    if (locator.workspace.kind === 'acp-remote') {
      const workspaceRef = locator.workspace.workspaceRef;
      remoteCandidate = (
        await SessionService.listValidatedRemoteSurfaceCandidates(signal)
      ).find(
        (candidate) =>
          candidate.sessionId === locator.sessionId &&
          candidate.workspaceRef === workspaceRef
      );
      if (!remoteCandidate) {
        throw new SessionSurfaceServiceError('workspace_binding_mismatch');
      }
    }
    return {
      candidate: {
        sourceKind: locator.workspace.kind,
        projectPath:
          locator.workspace.kind === 'local'
            ? locator.workspace.projectPath
            : remoteCandidate!.hostStateRoot,
        sessionId: locator.sessionId,
        ...(locator.workspace.kind === 'acp-remote'
          ? { publicWorkspaceRef: locator.workspace.workspaceRef }
          : {}),
        publicWorkspaceSortKey: '',
        surfaceDigest: transcriptFallbackDigest(entry),
        transcriptFingerprint: transcriptFallbackDigest(entry),
        lastMessageTime: entry.summary.lastMessageTime,
        sessionSortKey: '',
        summary: entry.summary,
      },
      ...(remoteCandidate ? { remoteCandidate } : {}),
    };
  }

  private async resolveFromProjection(
    database: SqliteDb,
    locator: SessionLocatorV2,
    signal?: AbortSignal
  ): Promise<ResolvedSessionSurface> {
    let remoteMatches:
      | Awaited<ReturnType<typeof SessionService.listValidatedRemoteSurfaceCandidates>>
      | undefined;
    if (locator.workspace.kind === 'acp-remote') {
      const requestedWorkspaceRef = locator.workspace.workspaceRef;
      remoteMatches = (
        await SessionService.listValidatedRemoteSurfaceCandidates(signal)
      ).filter(
        (remote) =>
          remote.sessionId === locator.sessionId &&
          remote.workspaceRef === requestedWorkspaceRef
      );
      if (remoteMatches.length === 0) {
        throw new SessionSurfaceServiceError('workspace_binding_mismatch');
      }
      if (remoteMatches.length > 1) {
        throw new SessionSurfaceServiceError('session_surface_state_invalid');
      }
    }
    const candidates = readSessionSurfaceCandidates(database, locator.sessionId).filter(
      (candidate) =>
        locator.workspace.kind === 'local'
          ? candidate.sourceKind === 'local' &&
            candidate.projectPath === path.resolve(locator.workspace.projectPath)
          : candidate.sourceKind === 'acp-remote' &&
            candidate.publicWorkspaceRef === locator.workspace.workspaceRef
    );
    if (candidates.length !== 1) {
      throw new SessionSurfaceServiceError(
        candidates.length === 0
          ? 'session_surface_not_found'
          : 'workspace_binding_mismatch'
      );
    }
    return remoteMatches
      ? { candidate: candidates[0]!, remoteCandidate: remoteMatches[0]! }
      : { candidate: candidates[0]! };
  }

  private async resolveCandidate(
    candidate: ProjectedSurfaceCandidate,
    signal?: AbortSignal
  ): Promise<ResolvedSessionSurface> {
    if (candidate.sourceKind === 'local') return { candidate };
    const matches = (
      await SessionService.listValidatedRemoteSurfaceCandidates(signal)
    ).filter(
      (remote) =>
        remote.sessionId === candidate.sessionId &&
        remote.workspaceRef === candidate.publicWorkspaceRef
    );
    if (matches.length !== 1) {
      throw new SessionSurfaceServiceError(
        matches.length === 0
          ? 'workspace_binding_mismatch'
          : 'session_surface_state_invalid'
      );
    }
    return { candidate, remoteCandidate: matches[0]! };
  }

  private toSummary(resolved: ResolvedSessionSurface): SessionSurfaceSummary {
    const candidate = resolved.candidate;
    const locator: SessionLocatorV2 =
      candidate.sourceKind === 'local'
        ? {
            version: 2,
            sessionId: candidate.sessionId,
            workspace: { kind: 'local', projectPath: candidate.projectPath },
          }
        : {
            version: 2,
            sessionId: candidate.sessionId,
            workspace: {
              kind: 'acp-remote',
              workspaceRef: candidate.publicWorkspaceRef!,
            },
          };
    return SessionSurfaceSummarySchema.parse({
      locator,
      ...candidate.summary,
      capabilities: this.capabilitiesFor(resolved),
    });
  }

  private capabilitiesFor(
    resolved: ResolvedSessionSurface
  ): SessionSurfaceCapabilities {
    const archived = resolved.candidate.summary.archivedAt !== undefined;
    if (!resolved.remoteCandidate) {
      return {
        connection: 'local',
        history: { read: true, fork: !archived },
        turn: archived ? { start: false, reason: 'archived' } : { start: true },
        files: archived
          ? {
              readText: false,
              writeText: false,
              browse: 'none',
              reason: 'archived',
            }
          : { readText: true, writeText: true, browse: 'tree' },
        terminal: archived
          ? { mode: 'none', owner: 'none', reason: 'archived' }
          : { mode: 'interactive', owner: 'local' },
      };
    }
    const owner = AcpServiceContext.getRemoteSurfaceOwnerSnapshot(
      resolved.candidate.sessionId,
      resolved.remoteCandidate.descriptor
    );
    return {
      connection: owner.connection,
      history: { read: true, fork: !archived },
      turn: { start: false, reason: archived ? 'archived' : 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: archived ? 'archived' : 'history-only',
      },
      terminal: {
        mode: 'none',
        owner: 'none',
        reason: archived ? 'archived' : 'history-only',
      },
    };
  }

  private async requireDatabase(): Promise<SqliteDb | null> {
    if (this.database === null) return null;
    return this.database ?? (await getProjectionDb());
  }

  private assertAvailable(): void {
    if (this.closed) {
      throw new SessionSurfaceServiceError('session_surface_unavailable');
    }
  }
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new SessionSurfaceServiceError('invalid_session_surface_request');
  }
  return limit;
}

function parseLocator(value: unknown): SessionLocatorV2 {
  try {
    const locator = SessionLocatorV2Schema.parse(value);
    if (
      !isValidSessionId(locator.sessionId) ||
      (locator.workspace.kind === 'local' &&
        (!path.isAbsolute(locator.workspace.projectPath) ||
          path.resolve(locator.workspace.projectPath) !==
            locator.workspace.projectPath))
    ) {
      throw new Error('invalid');
    }
    return locator;
  } catch {
    throw new SessionSurfaceServiceError('invalid_session_locator');
  }
}

function digestLocator(locator: SessionLocatorV2): string {
  return createHash('sha256')
    .update('session-surface-locator-v2\0')
    .update(JSON.stringify(locator))
    .digest('hex');
}

function parseCatalogBoundary(value: JsonValue): CatalogCursorBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionSurfaceServiceError('session_surface_cursor_invalid');
  }
  const candidate = value as JsonObject;
  if (
    typeof candidate.lastMessageTime !== 'string' ||
    (candidate.sourceKind !== 'local' && candidate.sourceKind !== 'acp-remote') ||
    typeof candidate.publicWorkspaceSortKey !== 'string' ||
    typeof candidate.sessionSortKey !== 'string' ||
    typeof candidate.chainId !== 'string' ||
    !candidate.chainId
  ) {
    throw new SessionSurfaceServiceError('session_surface_cursor_invalid');
  }
  return {
    lastMessageTime: candidate.lastMessageTime,
    sourceKind: candidate.sourceKind,
    publicWorkspaceSortKey: candidate.publicWorkspaceSortKey,
    sessionSortKey: candidate.sessionSortKey,
    chainId: candidate.chainId,
  };
}

function boundHistoryMessages(
  messages: readonly SessionSurfaceHistoryPage['messages'][number][],
  maxBytes: number
): { messages: SessionSurfaceHistoryPage['messages']; truncated: boolean } {
  const selected: SessionSurfaceHistoryPage['messages'] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const candidate = [message, ...selected];
    if (
      selected.length > 0 &&
      Buffer.byteLength(JSON.stringify(candidate)) > maxBytes
    ) {
      break;
    }
    selected.unshift(message);
  }
  return { messages: selected, truncated: selected.length < messages.length };
}

function surfaceMessageSequence(id: string): number {
  const match = /^surface-message:([0-9]+):/.exec(id);
  const sequence = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new SessionSurfaceServiceError('session_surface_state_invalid');
  }
  return sequence;
}

function parseFallbackMessages(value: JsonValue | undefined) {
  if (!Array.isArray(value)) {
    throw new SessionSurfaceServiceError('session_surface_snapshot_changed');
  }
  return value.map((message) => {
    try {
      return SessionSurfaceMessageSchema.parse(message);
    } catch {
      throw new SessionSurfaceServiceError('session_surface_snapshot_changed');
    }
  });
}

function parseFallbackCatalogBoundary(value: JsonValue): FallbackCatalogBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionSurfaceServiceError('session_surface_cursor_invalid');
  }
  const boundary = value as JsonObject;
  if (
    typeof boundary.chainId !== 'string' ||
    boundary.chainId.length === 0 ||
    !Array.isArray(boundary.entries)
  ) {
    throw new SessionSurfaceServiceError('session_surface_cursor_invalid');
  }
  const entries = boundary.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SessionSurfaceServiceError('session_surface_cursor_invalid');
    }
    const candidate = entry as JsonObject;
    return {
      locator: parseLocator(candidate.locator),
      summary: parseFallbackSummary(candidate.summary),
    };
  });
  return { chainId: boundary.chainId, entries };
}

function parseFallbackSummary(
  value: JsonValue | undefined
): Omit<SessionSurfaceSummary, 'locator' | 'capabilities'> {
  const placeholderLocator: SessionLocatorV2 = {
    version: 2,
    sessionId: 'placeholder',
    workspace: { kind: 'local', projectPath: '/' },
  };
  const parsed = SessionSurfaceSummarySchema.parse({
    ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    locator: placeholderLocator,
    capabilities: localCapabilities(false),
  });
  const { locator: _locator, capabilities: _capabilities, ...summary } = parsed;
  return summary;
}

function compareFallbackCatalogEntries(
  left: FallbackCatalogEntry,
  right: FallbackCatalogEntry
): number {
  if (left.summary.lastMessageTime > right.summary.lastMessageTime) return -1;
  if (left.summary.lastMessageTime < right.summary.lastMessageTime) return 1;
  if (left.locator.workspace.kind !== right.locator.workspace.kind) {
    return left.locator.workspace.kind === 'local' ? -1 : 1;
  }
  const leftWorkspace =
    left.locator.workspace.kind === 'local'
      ? left.locator.workspace.projectPath
      : left.locator.workspace.workspaceRef;
  const rightWorkspace =
    right.locator.workspace.kind === 'local'
      ? right.locator.workspace.projectPath
      : right.locator.workspace.workspaceRef;
  if (leftWorkspace < rightWorkspace) return -1;
  if (leftWorkspace > rightWorkspace) return 1;
  return left.locator.sessionId < right.locator.sessionId
    ? -1
    : left.locator.sessionId > right.locator.sessionId
      ? 1
      : 0;
}

function transcriptFallbackDigest(entry: FallbackCatalogEntry): string {
  return createHash('sha256')
    .update('session-surface-fallback-entry\0')
    .update(JSON.stringify(entry))
    .digest('hex');
}

function localCapabilities(archived: boolean): SessionSurfaceCapabilities {
  return {
    connection: 'local',
    history: { read: true, fork: !archived },
    turn: archived ? { start: false, reason: 'archived' } : { start: true },
    files: archived
      ? { readText: false, writeText: false, browse: 'none', reason: 'archived' }
      : { readText: true, writeText: true, browse: 'tree' },
    terminal: archived
      ? { mode: 'none', owner: 'none', reason: 'archived' }
      : { mode: 'interactive', owner: 'local' },
  };
}

function remoteFallbackCapabilities(archived: boolean): SessionSurfaceCapabilities {
  return {
    connection: 'offline',
    history: { read: true, fork: !archived },
    turn: { start: false, reason: archived ? 'archived' : 'history-only' },
    files: {
      readText: false,
      writeText: false,
      browse: 'none',
      reason: archived ? 'archived' : 'history-only',
    },
    terminal: {
      mode: 'none',
      owner: 'none',
      reason: archived ? 'archived' : 'history-only',
    },
  };
}

function errorDetails(code: SessionSurfaceErrorCode): {
  message: string;
  retryable: boolean;
} {
  if (code === 'session_surface_cursor_invalid') {
    return { message: 'Session surface cursor is invalid', retryable: false };
  }
  if (code === 'session_surface_snapshot_changed') {
    return { message: 'Session surface snapshot changed', retryable: false };
  }
  if (code === 'session_surface_state_invalid') {
    return { message: 'Session surface state is invalid', retryable: false };
  }
  if (code === 'session_surface_capability_unavailable') {
    return { message: 'Session surface capability is unavailable', retryable: false };
  }
  if (code === 'session_surface_unavailable') {
    return { message: 'Session surface is unavailable', retryable: true };
  }
  if (code === 'session_surface_not_found') {
    return { message: 'Session surface was not found', retryable: false };
  }
  if (code === 'workspace_binding_mismatch') {
    return { message: 'Session workspace binding changed', retryable: false };
  }
  if (code === 'session_surface_read_only') {
    return { message: 'Session surface is read only', retryable: false };
  }
  if (code === 'session_surface_capacity') {
    return { message: 'Session surface capacity is exhausted', retryable: true };
  }
  if (code === 'invalid_session_locator') {
    return { message: 'Session locator is invalid', retryable: false };
  }
  return { message: 'Session surface request is invalid', retryable: false };
}

function normalizeSurfaceError(error: unknown): Error {
  if (error instanceof SessionSurfaceServiceError) return error;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    const code = error.code;
    if (
      code === 'session_surface_cursor_invalid' ||
      code === 'session_surface_snapshot_changed' ||
      code === 'session_surface_capacity' ||
      code === 'session_surface_unavailable' ||
      code === 'session_surface_state_invalid'
    ) {
      return new SessionSurfaceServiceError(code);
    }
    if (code === 'acp_remote_workspace_state_invalid') {
      return new SessionSurfaceServiceError('session_surface_state_invalid');
    }
  }
  return error instanceof Error
    ? error
    : new SessionSurfaceServiceError('session_surface_state_invalid');
}
