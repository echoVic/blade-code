import { randomBytes } from 'node:crypto';
import type { JsonValue } from '../store/types.js';

export const DEFAULT_SESSION_SURFACE_CURSOR_IDLE_TTL_MS = 10 * 60 * 1_000;
export const MAX_SESSION_SURFACE_CURSOR_ENTRIES = 2_048;
export const MAX_SESSION_SURFACE_CURSOR_ACTIVE_CHAINS = 64;
export const MAX_SESSION_SURFACE_CURSOR_CHAIN_ENTRIES = 32;
export const MAX_SESSION_SURFACE_FROZEN_SNAPSHOT_BYTES = 64 * 1_024 * 1_024;

const DEFAULT_TOKEN_COLLISION_RETRIES = 4;
const TOKEN_PREFIXES = {
  catalog: 'session-surface-catalog:',
  history: 'session-surface-history:',
  snapshot: 'session-surface-snapshot:',
} as const;

export type SessionSurfaceCursorRegistryErrorCode =
  | 'session_surface_cursor_invalid'
  | 'session_surface_snapshot_changed'
  | 'session_surface_capacity'
  | 'session_surface_unavailable';

const ERROR_DETAILS = {
  session_surface_cursor_invalid: {
    message: 'session surface cursor is invalid',
    retryable: false,
  },
  session_surface_snapshot_changed: {
    message: 'session surface snapshot changed',
    retryable: false,
  },
  session_surface_capacity: {
    message: 'session surface cursor capacity exceeded',
    retryable: true,
  },
  session_surface_unavailable: {
    message: 'session surface cursor registry is unavailable',
    retryable: true,
  },
} satisfies Record<
  SessionSurfaceCursorRegistryErrorCode,
  { message: string; retryable: boolean }
>;

export class SessionSurfaceCursorRegistryError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: SessionSurfaceCursorRegistryErrorCode) {
    super(ERROR_DETAILS[code].message);
    this.name = 'SessionSurfaceCursorRegistryError';
    this.retryable = ERROR_DETAILS[code].retryable;
  }
}

type CursorKind = keyof typeof TOKEN_PREFIXES;

export type SessionSurfaceCursorRegistryLimits = {
  idleTtlMs: number;
  maxEntries: number;
  maxChains: number;
  maxEntriesPerChain: number;
  maxFrozenSnapshotBytes: number;
};

export type CatalogLoaderState<TBoundary extends JsonValue = JsonValue> = {
  readonly boundary: TBoundary;
};

export type HistoryLoaderState<TFrozenSnapshot extends JsonValue = JsonValue> = {
  readonly nextSequence: number;
  readonly frozenSnapshot: TFrozenSnapshot | undefined;
};

export type CatalogCursorIssue<
  TBoundary extends JsonValue = JsonValue,
  TRequest extends JsonValue = JsonValue,
> = {
  chainId: string;
  scopeKey: string;
  epoch: string;
  revision: string;
  boundary: TBoundary;
  request: TRequest;
};

export type HistoryCursorIssue<TRequest extends JsonValue = JsonValue> = {
  chainId: string;
  locatorDigest: string;
  transcriptFingerprint: string;
  nextSequence: number;
  snapshotToken: string;
  request: TRequest;
};

export type SnapshotTokenIssue<TFrozenSnapshot extends JsonValue = JsonValue> = {
  chainId: string;
  locatorDigest: string;
  transcriptFingerprint: string;
  frozenSnapshot?: TFrozenSnapshot;
};

export type CatalogCursorRedeem<
  TResult extends JsonValue = JsonValue,
  TBoundary extends JsonValue = JsonValue,
  TRequest extends JsonValue = JsonValue,
> = {
  token: string;
  scopeKey: string;
  epoch: string;
  revision: string;
  request: TRequest;
  loader: (
    state: CatalogLoaderState<TBoundary>,
    signal: AbortSignal
  ) => Promise<TResult>;
};

export type HistoryCursorRedeem<
  TResult extends JsonValue = JsonValue,
  TFrozenSnapshot extends JsonValue = JsonValue,
  TRequest extends JsonValue = JsonValue,
> = {
  token: string;
  locatorDigest: string;
  transcriptFingerprint: string;
  request: TRequest;
  loader: (
    state: HistoryLoaderState<TFrozenSnapshot>,
    signal: AbortSignal
  ) => Promise<TResult>;
};

export type SnapshotTokenAssertion = {
  token: string;
  locatorDigest: string;
  transcriptFingerprint: string;
};

export type SnapshotTokenAssertionResult<
  TFrozenSnapshot extends JsonValue = JsonValue,
> = {
  chainId: string;
  locatorDigest: string;
  transcriptFingerprint: string;
  frozenBytes: number;
  frozenSnapshot?: TFrozenSnapshot;
};

type ActiveLoad = {
  controller: AbortController;
  promise: Promise<JsonValue>;
};

type EntryBase = {
  token: string;
  chainId: string;
  kind: CursorKind;
  expiresAt: number;
  lastAccessAt: number;
};

type CatalogEntry = EntryBase & {
  kind: 'catalog';
  scopeKey: string;
  epoch: string;
  revision: string;
  boundary: JsonValue;
  boundaryBytes: number;
  requestHash: string;
  cachedResult?: JsonValue;
  cachedResultBytes: number;
  activeLoad?: ActiveLoad;
};

type HistoryEntry = EntryBase & {
  kind: 'history';
  locatorDigest: string;
  transcriptFingerprint: string;
  nextSequence: number;
  snapshotToken: string;
  requestHash: string;
  cachedResult?: JsonValue;
  cachedResultBytes: number;
  activeLoad?: ActiveLoad;
};

type SnapshotEntry = EntryBase & {
  kind: 'snapshot';
  locatorDigest: string;
  transcriptFingerprint: string;
  frozenBytes: number;
  frozenSnapshot?: JsonValue;
};

type CursorEntry = CatalogEntry | HistoryEntry | SnapshotEntry;

type ChainState = {
  chainId: string;
  tokens: Set<string>;
  completed: boolean;
  lastAccessAt: number;
  issueCount: number;
  activeLoads: number;
  frozenSnapshotBytes: number;
  retainedPayloadBytes: number;
};

type RegistryStats = {
  closed: boolean;
  chainCount: number;
  activeChains: number;
  completedChains: number;
  entryCount: number;
  activeLoads: number;
  frozenSnapshotBytes: number;
  retainedPayloadBytes: number;
  totalIssues: number;
  limits: SessionSurfaceCursorRegistryLimits;
};

export type SessionSurfaceCursorRegistryOptions = {
  now?: () => number;
  tokenSource?: () => string;
  tokenCollisionRetries?: number;
  limits?: Partial<SessionSurfaceCursorRegistryLimits>;
};

export class SessionSurfaceCursorRegistry {
  private readonly now: () => number;
  private readonly tokenSource: () => string;
  private readonly tokenCollisionRetries: number;
  private readonly limitsValue: SessionSurfaceCursorRegistryLimits;
  private readonly entries = new Map<string, CursorEntry>();
  private readonly chains = new Map<string, ChainState>();
  private closed = false;
  private closePromise?: Promise<void>;
  private totalIssues = 0;
  private activeLoads = 0;
  private frozenSnapshotBytes = 0;
  private retainedPayloadBytes = 0;

  constructor(options: SessionSurfaceCursorRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.tokenSource =
      options.tokenSource ?? (() => randomBytes(32).toString('base64url'));
    this.tokenCollisionRetries =
      options.tokenCollisionRetries ?? DEFAULT_TOKEN_COLLISION_RETRIES;
    this.limitsValue = validateLimits(options.limits ?? {});
    if (
      !Number.isSafeInteger(this.tokenCollisionRetries) ||
      this.tokenCollisionRetries < 0
    ) {
      throw new Error('tokenCollisionRetries must be a non-negative safe integer');
    }
  }

  issueCatalogCursor<
    TBoundary extends JsonValue = JsonValue,
    TRequest extends JsonValue = JsonValue,
  >(input: CatalogCursorIssue<TBoundary, TRequest>): string {
    this.assertAvailable();
    this.cleanup();
    const measuredBoundary = measureRetainedJsonValue(input.boundary);
    if (measuredBoundary.value === undefined) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    const requestHash = stableStringify(input.request);
    this.ensureCapacity({
      requestedEntries: 1,
      requestedRetainedBytes: measuredBoundary.bytes,
      chainId: input.chainId,
    });
    const token = this.createToken('catalog');
    const now = this.now();
    const chain = this.ensureChain(input.chainId, now);
    const entry: CatalogEntry = {
      token,
      chainId: input.chainId,
      kind: 'catalog',
      expiresAt: now + this.limitsValue.idleTtlMs,
      lastAccessAt: now,
      scopeKey: input.scopeKey,
      epoch: input.epoch,
      revision: input.revision,
      boundary: measuredBoundary.value,
      boundaryBytes: measuredBoundary.bytes,
      requestHash,
      cachedResultBytes: 0,
    };
    this.storeEntry(chain, entry);
    this.retainedPayloadBytes += measuredBoundary.bytes;
    chain.retainedPayloadBytes += measuredBoundary.bytes;
    return token;
  }

  issueHistoryCursor<TRequest extends JsonValue = JsonValue>(
    input: HistoryCursorIssue<TRequest>
  ): string {
    this.assertAvailable();
    this.cleanup();
    const requestHash = stableStringify(input.request);
    const snapshotEntry = this.assertSnapshotIssuableForHistory(input);
    this.ensureCapacity({
      requestedEntries: 1,
      requestedRetainedBytes: 0,
      chainId: input.chainId,
    });
    const token = this.createToken('history');
    const now = this.now();
    const chain = this.ensureChain(input.chainId, now);
    this.touch(snapshotEntry);
    const entry: HistoryEntry = {
      token,
      chainId: input.chainId,
      kind: 'history',
      expiresAt: now + this.limitsValue.idleTtlMs,
      lastAccessAt: now,
      locatorDigest: input.locatorDigest,
      transcriptFingerprint: input.transcriptFingerprint,
      nextSequence: input.nextSequence,
      snapshotToken: input.snapshotToken,
      requestHash,
      cachedResultBytes: 0,
    };
    this.storeEntry(chain, entry);
    return token;
  }

  issueSnapshotToken<TFrozenSnapshot extends JsonValue = JsonValue>(
    input: SnapshotTokenIssue<TFrozenSnapshot>
  ): string {
    this.assertAvailable();
    this.cleanup();
    const measuredSnapshot =
      input.frozenSnapshot === undefined
        ? { value: undefined, bytes: 0 }
        : measureRetainedJsonValue(input.frozenSnapshot);
    this.ensureCapacity({
      requestedEntries: 1,
      requestedRetainedBytes: measuredSnapshot.bytes,
      chainId: input.chainId,
    });
    const token = this.createToken('snapshot');
    const now = this.now();
    const chain = this.ensureChain(input.chainId, now);
    const entry: SnapshotEntry = {
      token,
      chainId: input.chainId,
      kind: 'snapshot',
      expiresAt: now + this.limitsValue.idleTtlMs,
      lastAccessAt: now,
      locatorDigest: input.locatorDigest,
      transcriptFingerprint: input.transcriptFingerprint,
      frozenBytes: measuredSnapshot.bytes,
      frozenSnapshot: measuredSnapshot.value,
    };
    this.storeEntry(chain, entry);
    this.frozenSnapshotBytes += measuredSnapshot.bytes;
    this.retainedPayloadBytes += measuredSnapshot.bytes;
    chain.frozenSnapshotBytes += measuredSnapshot.bytes;
    chain.retainedPayloadBytes += measuredSnapshot.bytes;
    return token;
  }

  async redeemCatalogCursor<
    TResult extends JsonValue = JsonValue,
    TBoundary extends JsonValue = JsonValue,
    TRequest extends JsonValue = JsonValue,
  >(input: CatalogCursorRedeem<TResult, TBoundary, TRequest>): Promise<TResult> {
    this.assertAvailable();
    this.cleanup();
    const entry = this.getEntry(input.token, 'catalog');
    if (entry.scopeKey !== input.scopeKey) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    if (entry.epoch !== input.epoch || entry.revision !== input.revision) {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    if (entry.requestHash !== stableStringify(input.request)) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    this.touch(entry);
    if (entry.cachedResult !== undefined) {
      return cloneCanonicalJsonValue<TResult>(entry.cachedResult);
    }
    if (entry.activeLoad) {
      return this.cloneActiveLoadResult<TResult>(entry.activeLoad);
    }
    return this.startCatalogLoad(entry, input.loader);
  }

  async redeemHistoryCursor<
    TResult extends JsonValue = JsonValue,
    TFrozenSnapshot extends JsonValue = JsonValue,
    TRequest extends JsonValue = JsonValue,
  >(input: HistoryCursorRedeem<TResult, TFrozenSnapshot, TRequest>): Promise<TResult> {
    this.assertAvailable();
    this.cleanup();
    const entry = this.getEntry(input.token, 'history');
    if (entry.locatorDigest !== input.locatorDigest) {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    if (entry.transcriptFingerprint !== input.transcriptFingerprint) {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    if (entry.requestHash !== stableStringify(input.request)) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    const snapshotEntry = this.resolveHistorySnapshot(entry);
    this.touch(entry);
    this.touch(snapshotEntry);
    if (entry.cachedResult !== undefined) {
      return cloneCanonicalJsonValue<TResult>(entry.cachedResult);
    }
    if (entry.activeLoad) {
      return this.cloneActiveLoadResult<TResult>(entry.activeLoad);
    }
    return this.startHistoryLoad(entry, snapshotEntry, input.loader);
  }

  async assertSnapshotToken<TFrozenSnapshot extends JsonValue = JsonValue>(
    input: SnapshotTokenAssertion
  ): Promise<SnapshotTokenAssertionResult<TFrozenSnapshot>> {
    this.assertAvailable();
    this.cleanup();
    const entry = this.getEntry(input.token, 'snapshot');
    if (entry.locatorDigest !== input.locatorDigest) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    if (entry.transcriptFingerprint !== input.transcriptFingerprint) {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    this.touch(entry);
    return {
      chainId: entry.chainId,
      locatorDigest: entry.locatorDigest,
      transcriptFingerprint: entry.transcriptFingerprint,
      frozenBytes: entry.frozenBytes,
      frozenSnapshot:
        entry.frozenSnapshot === undefined
          ? undefined
          : cloneCanonicalJsonValue<TFrozenSnapshot>(entry.frozenSnapshot),
    };
  }

  completeChain(chainId: string): void {
    this.cleanup();
    const chain = this.chains.get(chainId);
    if (!chain) return;
    chain.completed = true;
    chain.lastAccessAt = this.now();
  }

  stats(): RegistryStats {
    this.cleanup();
    let completedChains = 0;
    for (const chain of this.chains.values()) {
      if (chain.completed) {
        completedChains += 1;
      }
    }
    return {
      closed: this.closed,
      chainCount: this.chains.size,
      activeChains: this.chains.size - completedChains,
      completedChains,
      entryCount: this.entries.size,
      activeLoads: this.activeLoads,
      frozenSnapshotBytes: this.frozenSnapshotBytes,
      retainedPayloadBytes: this.retainedPayloadBytes,
      totalIssues: this.totalIssues,
      limits: { ...this.limitsValue },
    };
  }

  async close(reason?: unknown): Promise<void> {
    void reason;
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    const activePromises: Promise<unknown>[] = [];
    for (const entry of this.entries.values()) {
      if ((entry.kind === 'catalog' || entry.kind === 'history') && entry.activeLoad) {
        activePromises.push(entry.activeLoad.promise);
        entry.activeLoad.controller.abort(createUnavailableError());
      }
    }
    this.closePromise = Promise.allSettled(activePromises).then(() => {
      this.entries.clear();
      this.chains.clear();
      this.activeLoads = 0;
      this.frozenSnapshotBytes = 0;
      this.retainedPayloadBytes = 0;
    });
    return this.closePromise;
  }

  private startCatalogLoad<TResult extends JsonValue, TBoundary extends JsonValue>(
    entry: CatalogEntry,
    loader: (
      state: CatalogLoaderState<TBoundary>,
      signal: AbortSignal
    ) => Promise<TResult>
  ): Promise<TResult> {
    const chain = this.requireChain(entry.chainId);
    const controller = new AbortController();
    this.activeLoads += 1;
    chain.activeLoads += 1;
    const loadPromise: Promise<JsonValue> = Promise.resolve()
      .then(() =>
        loader(
          {
            boundary: cloneCanonicalJsonValue<TBoundary>(entry.boundary),
          },
          controller.signal
        )
      )
      .then((value) => {
        this.assertLoadAvailable(controller.signal);
        return this.admitCachedResult(entry, value);
      })
      .catch((error: unknown) => {
        if (this.closed || controller.signal.aborted) {
          throw createUnavailableError();
        }
        throw error;
      })
      .finally(() => {
        entry.activeLoad = undefined;
        this.activeLoads -= 1;
        chain.activeLoads -= 1;
      });
    entry.activeLoad = {
      controller,
      promise: loadPromise,
    };
    return this.cloneActiveLoadResult<TResult>(entry.activeLoad);
  }

  private startHistoryLoad<
    TResult extends JsonValue,
    TFrozenSnapshot extends JsonValue,
  >(
    entry: HistoryEntry,
    snapshotEntry: SnapshotEntry,
    loader: (
      state: HistoryLoaderState<TFrozenSnapshot>,
      signal: AbortSignal
    ) => Promise<TResult>
  ): Promise<TResult> {
    const chain = this.requireChain(entry.chainId);
    const controller = new AbortController();
    this.activeLoads += 1;
    chain.activeLoads += 1;
    const loadPromise = Promise.resolve()
      .then(() =>
        loader(
          {
            nextSequence: entry.nextSequence,
            frozenSnapshot:
              snapshotEntry.frozenSnapshot === undefined
                ? undefined
                : cloneCanonicalJsonValue<TFrozenSnapshot>(
                    snapshotEntry.frozenSnapshot
                  ),
          },
          controller.signal
        )
      )
      .then((value) => {
        this.assertLoadAvailable(controller.signal);
        return this.admitCachedResult(entry, value);
      })
      .catch((error: unknown) => {
        if (this.closed || controller.signal.aborted) {
          throw createUnavailableError();
        }
        throw error;
      })
      .finally(() => {
        entry.activeLoad = undefined;
        this.activeLoads -= 1;
        chain.activeLoads -= 1;
      });
    entry.activeLoad = {
      controller,
      promise: loadPromise,
    };
    return this.cloneActiveLoadResult<TResult>(entry.activeLoad);
  }

  private resolveHistorySnapshot(entry: HistoryEntry): SnapshotEntry {
    const snapshotToken = entry.snapshotToken;
    if (parseTokenKind(snapshotToken) !== 'snapshot') {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    const snapshotEntry = this.entries.get(snapshotToken);
    if (!snapshotEntry || snapshotEntry.kind !== 'snapshot') {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    if (snapshotEntry.expiresAt <= this.now()) {
      this.removeEntry(snapshotEntry);
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    if (
      snapshotEntry.locatorDigest !== entry.locatorDigest ||
      snapshotEntry.transcriptFingerprint !== entry.transcriptFingerprint
    ) {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    return snapshotEntry;
  }

  private assertSnapshotIssuableForHistory(input: {
    chainId: string;
    locatorDigest: string;
    transcriptFingerprint: string;
    snapshotToken: string;
  }): SnapshotEntry {
    const snapshotToken = input.snapshotToken;
    if (parseTokenKind(snapshotToken) !== 'snapshot') {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    const snapshotEntry = this.entries.get(snapshotToken);
    if (!snapshotEntry || snapshotEntry.kind !== 'snapshot') {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    if (snapshotEntry.expiresAt <= this.now()) {
      this.removeEntry(snapshotEntry);
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    if (
      snapshotEntry.chainId !== input.chainId ||
      snapshotEntry.locatorDigest !== input.locatorDigest ||
      snapshotEntry.transcriptFingerprint !== input.transcriptFingerprint
    ) {
      throw new SessionSurfaceCursorRegistryError('session_surface_snapshot_changed');
    }
    return snapshotEntry;
  }

  private requireChain(chainId: string): ChainState {
    const chain = this.chains.get(chainId);
    if (!chain) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    return chain;
  }

  private assertLoadAvailable(signal: AbortSignal): void {
    if (this.closed || signal.aborted) {
      throw createUnavailableError();
    }
  }

  private getEntry(token: string, expectedKind: 'catalog'): CatalogEntry;
  private getEntry(token: string, expectedKind: 'history'): HistoryEntry;
  private getEntry(token: string, expectedKind: 'snapshot'): SnapshotEntry;
  private getEntry(token: string, expectedKind: CursorKind): CursorEntry {
    const parsedKind = parseTokenKind(token);
    if (parsedKind !== expectedKind) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    const entry = this.entries.get(token);
    if (!entry) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    if (entry.kind !== expectedKind) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    if (entry.expiresAt <= this.now() && !hasActiveLoad(entry)) {
      this.removeEntry(entry);
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    return entry;
  }

  private touch(entry: CursorEntry): void {
    const now = this.now();
    entry.lastAccessAt = now;
    entry.expiresAt = now + this.limitsValue.idleTtlMs;
    const chain = this.chains.get(entry.chainId);
    if (chain) {
      chain.lastAccessAt = now;
    }
  }

  private storeEntry(chain: ChainState, entry: CursorEntry): void {
    if (chain.tokens.size >= this.limitsValue.maxEntriesPerChain) {
      throw new SessionSurfaceCursorRegistryError('session_surface_capacity');
    }
    this.entries.set(entry.token, entry);
    chain.tokens.add(entry.token);
    chain.completed = false;
    chain.lastAccessAt = entry.lastAccessAt;
    chain.issueCount += 1;
    this.totalIssues += 1;
  }

  private ensureChain(chainId: string, now: number): ChainState {
    const existing = this.chains.get(chainId);
    if (existing) {
      existing.lastAccessAt = now;
      return existing;
    }
    const chain: ChainState = {
      chainId,
      tokens: new Set<string>(),
      completed: false,
      lastAccessAt: now,
      issueCount: 0,
      activeLoads: 0,
      frozenSnapshotBytes: 0,
      retainedPayloadBytes: 0,
    };
    this.chains.set(chainId, chain);
    return chain;
  }

  private cloneActiveLoadResult<TResult extends JsonValue>(
    activeLoad: ActiveLoad
  ): Promise<TResult> {
    return activeLoad.promise.then((value) => cloneCanonicalJsonValue<TResult>(value));
  }

  private admitCachedResult(
    entry: CatalogEntry | HistoryEntry,
    value: JsonValue
  ): JsonValue {
    const measured = measureRetainedJsonValue(value);
    const chain = this.requireChain(entry.chainId);
    const additionalBytes = measured.bytes - entry.cachedResultBytes;
    this.ensureCapacity({
      requestedEntries: 0,
      requestedRetainedBytes: Math.max(0, additionalBytes),
      chainId: entry.chainId,
    });
    this.releaseCachedResult(entry, chain);
    if (measured.value === undefined) {
      throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
    }
    entry.cachedResult = measured.value;
    entry.cachedResultBytes = measured.bytes;
    this.retainedPayloadBytes += measured.bytes;
    chain.retainedPayloadBytes += measured.bytes;
    return entry.cachedResult;
  }

  private createToken(kind: CursorKind): string {
    const prefix = TOKEN_PREFIXES[kind];
    for (let attempt = 0; attempt <= this.tokenCollisionRetries; attempt += 1) {
      this.assertAvailable();
      const token = `${prefix}${this.tokenSource()}`;
      if (!this.entries.has(token)) {
        return token;
      }
    }
    throw new SessionSurfaceCursorRegistryError('session_surface_capacity');
  }

  private ensureCapacity(request: {
    requestedEntries: number;
    requestedRetainedBytes: number;
    chainId: string;
  }): void {
    this.reclaimCompletedChains(request);
    const projectedEntries = this.entries.size + request.requestedEntries;
    const projectedChains =
      this.chains.size + (this.chains.has(request.chainId) ? 0 : 1);
    const projectedRetainedPayloadBytes =
      this.retainedPayloadBytes + request.requestedRetainedBytes;
    const projectedChainEntries =
      (this.chains.get(request.chainId)?.tokens.size ?? 0) + request.requestedEntries;
    if (
      projectedEntries > this.limitsValue.maxEntries ||
      projectedChains > this.limitsValue.maxChains ||
      projectedChainEntries > this.limitsValue.maxEntriesPerChain ||
      projectedRetainedPayloadBytes > this.limitsValue.maxFrozenSnapshotBytes
    ) {
      throw new SessionSurfaceCursorRegistryError('session_surface_capacity');
    }
  }

  private reclaimCompletedChains(request: {
    requestedEntries: number;
    requestedRetainedBytes: number;
    chainId: string;
  }): void {
    const reclaimable = [...this.chains.values()]
      .filter((chain) => chain.completed && chain.activeLoads === 0)
      .sort((left, right) => left.lastAccessAt - right.lastAccessAt);
    for (const chain of reclaimable) {
      const needsReclaim =
        this.entries.size + request.requestedEntries > this.limitsValue.maxEntries ||
        this.chains.size +
          (request.chainId !== '' && this.chains.has(request.chainId) ? 0 : 1) >
          this.limitsValue.maxChains ||
        this.retainedPayloadBytes + request.requestedRetainedBytes >
          this.limitsValue.maxFrozenSnapshotBytes;
      if (!needsReclaim) {
        break;
      }
      this.removeChain(chain.chainId);
    }
  }

  private cleanup(): void {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt > now || hasActiveLoad(entry)) {
        continue;
      }
      this.removeEntry(entry);
    }
    for (const chain of [...this.chains.values()]) {
      if (chain.tokens.size === 0 && chain.activeLoads === 0) {
        this.chains.delete(chain.chainId);
      }
    }
  }

  private removeEntry(entry: CursorEntry): void {
    this.entries.delete(entry.token);
    const chain = this.chains.get(entry.chainId);
    if (chain) {
      chain.tokens.delete(entry.token);
      this.releaseEntryRetainedPayload(entry, chain);
      if (chain.tokens.size === 0 && chain.activeLoads === 0) {
        this.chains.delete(chain.chainId);
      }
    } else {
      this.releaseEntryRetainedPayload(entry);
    }
  }

  private removeChain(chainId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) {
      return;
    }
    for (const token of chain.tokens) {
      const entry = this.entries.get(token);
      if (!entry || hasActiveLoad(entry)) {
        continue;
      }
      this.entries.delete(token);
      this.releaseEntryRetainedPayload(entry, chain);
    }
    this.chains.delete(chainId);
  }

  private releaseEntryRetainedPayload(entry: CursorEntry, chain?: ChainState): void {
    if (entry.kind === 'snapshot') {
      this.frozenSnapshotBytes -= entry.frozenBytes;
      this.retainedPayloadBytes -= entry.frozenBytes;
      if (chain) {
        chain.frozenSnapshotBytes -= entry.frozenBytes;
        chain.retainedPayloadBytes -= entry.frozenBytes;
      }
      return;
    }
    if (entry.kind === 'catalog') {
      this.retainedPayloadBytes -= entry.boundaryBytes;
      if (chain) {
        chain.retainedPayloadBytes -= entry.boundaryBytes;
      }
    }
    this.releaseCachedResult(entry, chain);
  }

  private releaseCachedResult(
    entry: CatalogEntry | HistoryEntry,
    chain?: ChainState
  ): void {
    if (entry.cachedResultBytes === 0) {
      entry.cachedResult = undefined;
      return;
    }
    this.retainedPayloadBytes -= entry.cachedResultBytes;
    if (chain) {
      chain.retainedPayloadBytes -= entry.cachedResultBytes;
    }
    entry.cachedResult = undefined;
    entry.cachedResultBytes = 0;
  }

  private assertAvailable(): void {
    if (this.closed) {
      throw createUnavailableError();
    }
  }
}

function parseTokenKind(token: string): CursorKind | undefined {
  if (token.startsWith(TOKEN_PREFIXES.catalog)) {
    return 'catalog';
  }
  if (token.startsWith(TOKEN_PREFIXES.history)) {
    return 'history';
  }
  if (token.startsWith(TOKEN_PREFIXES.snapshot)) {
    return 'snapshot';
  }
  return undefined;
}

function hasActiveLoad(entry: CursorEntry): boolean {
  return entry.kind !== 'snapshot' && entry.activeLoad !== undefined;
}

function validateLimits(
  overrides: Partial<SessionSurfaceCursorRegistryLimits>
): SessionSurfaceCursorRegistryLimits {
  const limits: SessionSurfaceCursorRegistryLimits = {
    idleTtlMs: overrides.idleTtlMs ?? DEFAULT_SESSION_SURFACE_CURSOR_IDLE_TTL_MS,
    maxEntries: overrides.maxEntries ?? MAX_SESSION_SURFACE_CURSOR_ENTRIES,
    maxChains: overrides.maxChains ?? MAX_SESSION_SURFACE_CURSOR_ACTIVE_CHAINS,
    maxEntriesPerChain:
      overrides.maxEntriesPerChain ?? MAX_SESSION_SURFACE_CURSOR_CHAIN_ENTRIES,
    maxFrozenSnapshotBytes:
      overrides.maxFrozenSnapshotBytes ?? MAX_SESSION_SURFACE_FROZEN_SNAPSHOT_BYTES,
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        'session surface cursor registry limits must be positive safe integers'
      );
    }
  }
  return limits;
}

function createUnavailableError(): SessionSurfaceCursorRegistryError {
  return new SessionSurfaceCursorRegistryError('session_surface_unavailable');
}

function stableStringify(value: unknown): string {
  return stringifyCanonicalJsonValue(cloneCanonicalJsonValue(value));
}

function cloneCanonicalJsonValue<T extends JsonValue = JsonValue>(value: unknown): T {
  try {
    return cloneCanonicalJsonValueInternal(value, new Set<object>()) as T;
  } catch {
    throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
  }
}

function cloneCanonicalJsonValueInternal(value: unknown, seen: Set<object>): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('invalid number');
    }
    return value;
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw new Error('invalid JSON type');
  }
  if (!value || typeof value !== 'object') {
    throw new Error('invalid JSON value');
  }
  if (seen.has(value)) {
    throw new Error('cycle');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new Error('sparse array');
        }
        result.push(cloneCanonicalJsonValueInternal(value[index], seen));
      }
      return result;
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('symbol keys');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('non-plain object');
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const propertyValue = Reflect.get(value, key);
      if (propertyValue === undefined) {
        throw new Error('undefined object value');
      }
      result[key] = cloneCanonicalJsonValueInternal(propertyValue, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function stringifyCanonicalJsonValue(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonicalJsonValue(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonicalJsonValue(value[key])}`)
    .join(',')}}`;
}

function measureRetainedJsonValue(
  value: unknown,
  options: { allowUndefined?: boolean } = {}
): { value: JsonValue | undefined; bytes: number } {
  if (value === undefined) {
    if (options.allowUndefined) {
      return { value: undefined, bytes: 0 };
    }
    throw new SessionSurfaceCursorRegistryError('session_surface_cursor_invalid');
  }
  const cloned = cloneCanonicalJsonValue(value);
  return {
    value: cloned,
    bytes: Buffer.byteLength(stringifyCanonicalJsonValue(cloned), 'utf8'),
  };
}
