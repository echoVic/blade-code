import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_SURFACE_CURSOR_IDLE_TTL_MS,
  MAX_SESSION_SURFACE_CURSOR_ACTIVE_CHAINS,
  MAX_SESSION_SURFACE_CURSOR_CHAIN_ENTRIES,
  MAX_SESSION_SURFACE_CURSOR_ENTRIES,
  MAX_SESSION_SURFACE_FROZEN_SNAPSHOT_BYTES,
  SessionSurfaceCursorRegistry,
  SessionSurfaceCursorRegistryError,
} from '../../../src/services/SessionSurfaceCursorRegistry.js';

function createClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

function createTokenSource(tokens: readonly string[]) {
  let index = 0;
  return () => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) {
      throw new Error('token source exhausted');
    }
    return token;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function expectRegistryError(
  error: unknown,
  expected: {
    code:
      | 'session_surface_cursor_invalid'
      | 'session_surface_snapshot_changed'
      | 'session_surface_capacity'
      | 'session_surface_unavailable';
    retryable: boolean;
    message: string;
  }
) {
  expect(error).toBeInstanceOf(SessionSurfaceCursorRegistryError);
  if (!(error instanceof SessionSurfaceCursorRegistryError)) {
    throw new Error('expected SessionSurfaceCursorRegistryError');
  }
  expect(error.code).toBe(expected.code);
  expect(error.retryable).toBe(expected.retryable);
  expect(error.message).toBe(expected.message);
}

describe('SessionSurfaceCursorRegistry', () => {
  it('freezes the production defaults and emits opaque prefixed tokens', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['catalog-1', 'snapshot-1', 'history-1']),
    });

    expect(registry.stats().limits).toEqual({
      idleTtlMs: DEFAULT_SESSION_SURFACE_CURSOR_IDLE_TTL_MS,
      maxEntries: MAX_SESSION_SURFACE_CURSOR_ENTRIES,
      maxChains: MAX_SESSION_SURFACE_CURSOR_ACTIVE_CHAINS,
      maxEntriesPerChain: MAX_SESSION_SURFACE_CURSOR_CHAIN_ENTRIES,
      maxFrozenSnapshotBytes: MAX_SESSION_SURFACE_FROZEN_SNAPSHOT_BYTES,
    });

    const catalogToken = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'workspace:/secret/path',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: { after: 'message-1' },
      request: { limit: 20, includeSensitive: '/secret/path' },
    });
    const snapshotToken = registry.issueSnapshotToken({
      chainId: 'chain-a',
      locatorDigest: 'locator-secret',
      transcriptFingerprint: 'fingerprint-secret',
      frozenSnapshot: { page: ['secret-transcript'] },
    });
    const historyToken = registry.issueHistoryCursor({
      chainId: 'chain-a',
      locatorDigest: 'locator-secret',
      transcriptFingerprint: 'fingerprint-secret',
      nextSequence: 7,
      snapshotToken,
      request: { direction: 'forward' },
    });

    expect(catalogToken).toBe('session-surface-catalog:catalog-1');
    expect(historyToken).toBe('session-surface-history:history-1');
    expect(snapshotToken).toBe('session-surface-snapshot:snapshot-1');
    expect(catalogToken).not.toContain('/secret/path');
    expect(historyToken).not.toContain('locator-secret');
    expect(snapshotToken).not.toContain('secret-transcript');
    expect(registry.stats()).toMatchObject({
      chainCount: 1,
      entryCount: 3,
      totalIssues: 3,
    });

    await registry.close();
  });

  it('rejects malformed, unknown, wrong-kind, and expired tokens with fixed cursor_invalid errors', async () => {
    const clock = createClock(10);
    const registry = new SessionSurfaceCursorRegistry({
      now: clock.now,
      tokenSource: createTokenSource(['catalog-1']),
      limits: {
        idleTtlMs: 50,
      },
    });

    const token = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });

    const fixedMessage = 'session surface cursor is invalid';

    await expect(
      registry.redeemCatalogCursor({
        token: 'not-a-session-surface-token',
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: fixedMessage,
      });
      return true;
    });

    await expect(
      registry.redeemHistoryCursor({
        token,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        request: { limit: 1 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: fixedMessage,
      });
      return true;
    });

    await expect(
      registry.redeemCatalogCursor({
        token: 'session-surface-catalog:missing',
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: fixedMessage,
      });
      return true;
    });

    clock.advance(51);
    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: fixedMessage,
      });
      return true;
    });
  });

  it('replays catalog pages idempotently, single-flights concurrent redemption, refreshes TTL on access, and passes stored catalog state to the loader', async () => {
    const clock = createClock(1_000);
    const registry = new SessionSurfaceCursorRegistry({
      now: clock.now,
      tokenSource: createTokenSource(['catalog-1']),
      limits: {
        idleTtlMs: 20,
      },
    });
    const token = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: { after: 'message-1' },
      request: { limit: 2 },
    });
    const page = deferred<{ page: string[] }>();
    const loader = vi.fn(
      async (state: { readonly boundary: unknown }, _signal: AbortSignal) => {
        expect(state).toEqual({
          boundary: { after: 'message-1' },
        });
        return page.promise;
      }
    );

    const first = registry.redeemCatalogCursor({
      token,
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      request: { limit: 2 },
      loader,
    });
    const second = registry.redeemCatalogCursor({
      token,
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      request: { limit: 2 },
      loader,
    });

    await flushMicrotasks();
    expect(loader).toHaveBeenCalledTimes(1);

    page.resolve({ page: ['m1', 'm2'] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { page: ['m1', 'm2'] },
      { page: ['m1', 'm2'] },
    ]);

    const mutableReplay = await registry.redeemCatalogCursor({
      token,
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      request: { limit: 2 },
      loader: vi.fn(async () => ({ page: ['unexpected-after-cache'] })),
    });
    mutableReplay.page.push('mutated-by-caller');

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 2 },
        loader: vi.fn(async () => ({ page: ['unexpected-after-mutation'] })),
      })
    ).resolves.toEqual({ page: ['m1', 'm2'] });

    clock.advance(19);
    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 2 },
        loader: vi.fn(async () => ({ page: ['unexpected'] })),
      })
    ).resolves.toEqual({ page: ['m1', 'm2'] });

    clock.advance(19);
    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 2 },
        loader: vi.fn(async () => ({ page: ['still-unexpected'] })),
      })
    ).resolves.toEqual({ page: ['m1', 'm2'] });

    clock.advance(21);
    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 2 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toBeInstanceOf(SessionSurfaceCursorRegistryError);
  });

  it('bounds cached catalog pages by retained bytes, keeps single-flight semantics, and does not cache caller mutations', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['catalog-1']),
      limits: {
        maxFrozenSnapshotBytes: 48,
      },
    });
    const token = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: { after: 'message-1' },
      request: { limit: 1 },
    });

    const oversizedResult = deferred<{ page: string[] }>();
    const oversizedLoader = vi.fn(
      async (_state: { readonly boundary: unknown }, _signal: AbortSignal) =>
        oversizedResult.promise
    );

    const first = registry.redeemCatalogCursor({
      token,
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      request: { limit: 1 },
      loader: oversizedLoader,
    });
    const second = registry.redeemCatalogCursor({
      token,
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      request: { limit: 1 },
      loader: oversizedLoader,
    });

    await flushMicrotasks();
    expect(oversizedLoader).toHaveBeenCalledTimes(1);

    oversizedResult.resolve({
      page: ['this-cached-page-is-intentionally-too-large-for-the-budget'],
    });

    await expect(Promise.all([first, second])).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_capacity',
        retryable: true,
        message: 'session surface cursor capacity exceeded',
      });
      return true;
    });
    expect(registry.stats().frozenSnapshotBytes).toBe(0);

    const recovered = await registry.redeemCatalogCursor({
      token,
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      request: { limit: 1 },
      loader: vi.fn(async () => ({ page: ['ok'] })),
    });
    recovered.page.push('caller-mutation');

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader: vi.fn(async () => ({ page: ['unexpected'] })),
      })
    ).resolves.toEqual({ page: ['ok'] });
    expect(registry.stats().frozenSnapshotBytes).toBe(0);
    expect(registry.stats().retainedPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify({ page: ['ok'] }), 'utf8')
    );
  });

  it('rejects catalog public binding mismatches and revision drift with fixed errors', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['catalog-1']),
    });
    const token = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: { after: 'message-1' },
      request: { limit: 2 },
    });

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-b',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 2 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      return true;
    });

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-2',
        revision: 'revision-1',
        request: { limit: 2 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
      return true;
    });

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-2',
        request: { limit: 2 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
      return true;
    });

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 3 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      return true;
    });
  });

  it('binds history cursors to real snapshot entries and passes stored history state to the loader', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource([
        'snapshot-1',
        'history-1',
        'snapshot-2',
        'history-2',
      ]),
    });
    const snapshotToken = registry.issueSnapshotToken({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      frozenSnapshot: { lines: ['a', 'b'] },
    });
    const historyToken = registry.issueHistoryCursor({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      nextSequence: 3,
      snapshotToken,
      request: { direction: 'forward', limit: 2 },
    });

    await expect(
      registry.assertSnapshotToken({
        token: snapshotToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
      })
    ).resolves.toEqual({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      frozenBytes: Buffer.byteLength(JSON.stringify({ lines: ['a', 'b'] }), 'utf8'),
      frozenSnapshot: { lines: ['a', 'b'] },
    });

    await expect(
      registry.redeemHistoryCursor({
        token: historyToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        request: { direction: 'forward', limit: 2 },
        loader: async (
          state: {
            readonly nextSequence: number;
            readonly frozenSnapshot: unknown;
          },
          _signal: AbortSignal
        ) => {
          expect(state).toEqual({
            nextSequence: 3,
            frozenSnapshot: { lines: ['a', 'b'] },
          });
          return { items: ['h1', 'h2'] };
        },
      })
    ).resolves.toEqual({ items: ['h1', 'h2'] });

    await expect(
      registry.assertSnapshotToken({
        token: snapshotToken,
        locatorDigest: 'locator-b',
        transcriptFingerprint: 'fingerprint-a',
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      return true;
    });

    await expect(
      registry.redeemHistoryCursor({
        token: historyToken,
        locatorDigest: 'locator-b',
        transcriptFingerprint: 'fingerprint-a',
        request: { direction: 'forward', limit: 2 },
        loader: async () => ({ items: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
      return true;
    });

    await expect(
      registry.redeemHistoryCursor({
        token: historyToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-b',
        request: { direction: 'forward', limit: 2 },
        loader: async () => ({ items: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
      return true;
    });

    await expect(
      registry.redeemHistoryCursor({
        token: historyToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        request: { direction: 'forward', limit: 1 },
        loader: async () => ({ items: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      return true;
    });

    const noFrozenSnapshotToken = registry.issueSnapshotToken({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
    });
    const historyWithoutFrozenSnapshot = registry.issueHistoryCursor({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      nextSequence: 9,
      snapshotToken: noFrozenSnapshotToken,
      request: { direction: 'forward', limit: 1 },
    });

    await expect(
      registry.assertSnapshotToken({
        token: noFrozenSnapshotToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
      })
    ).resolves.toEqual({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      frozenBytes: 0,
      frozenSnapshot: undefined,
    });

    await expect(
      registry.redeemHistoryCursor({
        token: historyWithoutFrozenSnapshot,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        request: { direction: 'forward', limit: 1 },
        loader: async (
          state: {
            readonly nextSequence: number;
            readonly frozenSnapshot: unknown;
          },
          _signal: AbortSignal
        ) => {
          expect(state).toEqual({
            nextSequence: 9,
            frozenSnapshot: undefined,
          });
          return { items: ['h3'] };
        },
      })
    ).resolves.toEqual({ items: ['h3'] });

    const mutableReplay = await registry.redeemHistoryCursor({
      token: historyToken,
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      request: { direction: 'forward', limit: 2 },
      loader: async () => ({ items: ['unexpected-after-cache'] }),
    });
    mutableReplay.items.push('mutated-by-caller');

    await expect(
      registry.redeemHistoryCursor({
        token: historyToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        request: { direction: 'forward', limit: 2 },
        loader: async () => ({ items: ['unexpected-after-mutation'] }),
      })
    ).resolves.toEqual({ items: ['h1', 'h2'] });
  });

  it('rejects non-JSON request, boundary, snapshot, and cached history payloads with fixed safe errors', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['catalog-1', 'snapshot-1', 'history-1']),
      limits: {
        maxFrozenSnapshotBytes: 256,
      },
    });
    const issueCatalogCursorUnsafe = Reflect.get(registry, 'issueCatalogCursor') as (
      this: SessionSurfaceCursorRegistry,
      input: unknown
    ) => string;
    const redeemCatalogCursorUnsafe = Reflect.get(registry, 'redeemCatalogCursor') as (
      this: SessionSurfaceCursorRegistry,
      input: unknown
    ) => Promise<unknown>;
    const issueSnapshotTokenUnsafe = Reflect.get(registry, 'issueSnapshotToken') as (
      this: SessionSurfaceCursorRegistry,
      input: unknown
    ) => string;
    const redeemHistoryCursorUnsafe = Reflect.get(registry, 'redeemHistoryCursor') as (
      this: SessionSurfaceCursorRegistry,
      input: unknown
    ) => Promise<unknown>;

    expect(() =>
      issueCatalogCursorUnsafe.call(registry, {
        chainId: 'chain-a',
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        boundary: new Map([['after', 'message-1']]),
        request: { limit: 1 },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      issueCatalogCursorUnsafe.call(registry, {
        chainId: 'chain-a',
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        boundary: new Map([['after', 'message-1']]),
        request: { limit: 1 },
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      expect(String(error)).not.toContain('Map');
    }

    const catalogToken = registry.issueCatalogCursor({
      chainId: 'chain-b',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: { after: 'message-1' },
      request: { limit: 1 },
    });
    const circularRequest: { self?: unknown } = {};
    circularRequest.self = circularRequest;

    await expect(
      redeemCatalogCursorUnsafe.call(registry, {
        token: catalogToken,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: circularRequest,
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      expect(String(error)).not.toContain('self');
      return true;
    });

    expect(() =>
      issueSnapshotTokenUnsafe.call(registry, {
        chainId: 'chain-c',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        frozenSnapshot: { count: 1n },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      issueSnapshotTokenUnsafe.call(registry, {
        chainId: 'chain-c',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        frozenSnapshot: { count: 1n },
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      expect(String(error)).not.toContain('count');
      expect(String(error)).not.toContain('1n');
    }

    const snapshotToken = registry.issueSnapshotToken({
      chainId: 'chain-d',
      locatorDigest: 'locator-d',
      transcriptFingerprint: 'fingerprint-d',
      frozenSnapshot: { lines: ['a', 'b'] },
    });
    const historyToken = registry.issueHistoryCursor({
      chainId: 'chain-d',
      locatorDigest: 'locator-d',
      transcriptFingerprint: 'fingerprint-d',
      nextSequence: 4,
      snapshotToken,
      request: { direction: 'forward', limit: 2 },
    });

    await expect(
      redeemHistoryCursorUnsafe.call(registry, {
        token: historyToken,
        locatorDigest: 'locator-d',
        transcriptFingerprint: 'fingerprint-d',
        request: { direction: 'forward', limit: 2 },
        loader: async () => new Map([['items', ['h1']]]),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      expect(String(error)).not.toContain('Map');
      return true;
    });

    await expect(
      registry.redeemHistoryCursor({
        token: historyToken,
        locatorDigest: 'locator-d',
        transcriptFingerprint: 'fingerprint-d',
        request: { direction: 'forward', limit: 2 },
        loader: async () => ({ items: ['h1'] }),
      })
    ).resolves.toEqual({ items: ['h1'] });
  });

  it('treats missing, expired, or wrong-kind referenced history snapshots as snapshot_changed', async () => {
    const clock = createClock(0);
    const registry = new SessionSurfaceCursorRegistry({
      now: clock.now,
      tokenSource: createTokenSource([
        'snapshot-1',
        'history-1',
        'catalog-1',
        'history-2',
        'history-3',
      ]),
      limits: {
        idleTtlMs: 50,
      },
    });

    const expiringSnapshotToken = registry.issueSnapshotToken({
      chainId: 'chain-expired',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      frozenSnapshot: { lines: ['expired'] },
    });
    clock.advance(40);
    const entryCountBeforeExpiredIssue = registry.stats().entryCount;
    clock.advance(11);

    expect(() =>
      registry.issueHistoryCursor({
        chainId: 'chain-expired',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 9,
        snapshotToken: expiringSnapshotToken,
        request: { direction: 'forward' },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      registry.issueHistoryCursor({
        chainId: 'chain-expired',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 9,
        snapshotToken: expiringSnapshotToken,
        request: { direction: 'forward' },
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
    }
    expect(registry.stats().entryCount).toBe(entryCountBeforeExpiredIssue - 1);

    const wrongKindToken = registry.issueCatalogCursor({
      chainId: 'chain-wrong-kind',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });
    const entryCountBeforeWrongKindIssue = registry.stats().entryCount;

    expect(() =>
      registry.issueHistoryCursor({
        chainId: 'chain-wrong-kind',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 3,
        snapshotToken: wrongKindToken,
        request: { direction: 'forward' },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      registry.issueHistoryCursor({
        chainId: 'chain-wrong-kind',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 3,
        snapshotToken: wrongKindToken,
        request: { direction: 'forward' },
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
    }
    expect(registry.stats().entryCount).toBe(entryCountBeforeWrongKindIssue);

    const entryCountBeforeMissingIssue = registry.stats().entryCount;

    expect(() =>
      registry.issueHistoryCursor({
        chainId: 'chain-missing',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 4,
        snapshotToken: 'session-surface-snapshot:missing',
        request: { direction: 'forward' },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      registry.issueHistoryCursor({
        chainId: 'chain-missing',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 4,
        snapshotToken: 'session-surface-snapshot:missing',
        request: { direction: 'forward' },
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
    }
    expect(registry.stats().entryCount).toBe(entryCountBeforeMissingIssue);

    const mismatchedSnapshotToken = registry.issueSnapshotToken({
      chainId: 'chain-snapshot',
      locatorDigest: 'locator-z',
      transcriptFingerprint: 'fingerprint-z',
      frozenSnapshot: { lines: ['mismatch'] },
    });
    const entryCountBeforeMismatchIssue = registry.stats().entryCount;

    expect(() =>
      registry.issueHistoryCursor({
        chainId: 'chain-history',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 5,
        snapshotToken: mismatchedSnapshotToken,
        request: { direction: 'forward' },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      registry.issueHistoryCursor({
        chainId: 'chain-history',
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        nextSequence: 5,
        snapshotToken: mismatchedSnapshotToken,
        request: { direction: 'forward' },
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_snapshot_changed',
        retryable: false,
        message: 'session surface snapshot changed',
      });
    }
    expect(registry.stats().entryCount).toBe(entryCountBeforeMismatchIssue);
  });

  it('refreshes the referenced snapshot TTL when issuing a history cursor', async () => {
    const clock = createClock(0);
    const registry = new SessionSurfaceCursorRegistry({
      now: clock.now,
      tokenSource: createTokenSource(['snapshot-1', 'history-1']),
      limits: { idleTtlMs: 50 },
    });
    const snapshotToken = registry.issueSnapshotToken({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
    });
    clock.advance(40);
    const historyToken = registry.issueHistoryCursor({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      nextSequence: 3,
      snapshotToken,
      request: { limit: 1 },
    });
    clock.advance(15);

    await expect(
      registry.redeemHistoryCursor({
        token: historyToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
        request: { limit: 1 },
        loader: async (state) => ({
          nextSequence: state.nextSequence,
          hasFrozenSnapshot: state.frozenSnapshot !== undefined,
        }),
      })
    ).resolves.toEqual({ nextSequence: 3, hasFrozenSnapshot: false });
  });

  it('allows retry after loader rejection instead of poisoning the token', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['catalog-1']),
    });
    const token = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });
    const loader = vi
      .fn<
        (
          state: { readonly boundary: unknown },
          signal: AbortSignal
        ) => Promise<{ page: string[] }>
      >()
      .mockRejectedValueOnce(new Error('loader failed'))
      .mockResolvedValueOnce({ page: ['ok'] });

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader,
      })
    ).rejects.toThrow('loader failed');

    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader,
      })
    ).resolves.toEqual({ page: ['ok'] });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('reclaims completed chains by LRU before reporting capacity and never evicts active chains', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['a-1', 'b-1', 'c-1']),
      limits: {
        maxChains: 2,
        maxEntries: 2,
        maxEntriesPerChain: 1,
      },
    });

    const firstToken = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });
    registry.completeChain('chain-a');
    const secondToken = registry.issueCatalogCursor({
      chainId: 'chain-b',
      scopeKey: 'scope-b',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });

    expect(secondToken).toBe('session-surface-catalog:b-1');
    registry.issueCatalogCursor({
      chainId: 'chain-c',
      scopeKey: 'scope-c',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });
    expect(registry.stats()).toMatchObject({
      chainCount: 2,
      entryCount: 2,
      activeChains: 2,
      completedChains: 0,
      totalIssues: 3,
    });

    await expect(
      registry.redeemCatalogCursor({
        token: firstToken,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      return true;
    });

    expect(() =>
      registry.issueCatalogCursor({
        chainId: 'chain-d',
        scopeKey: 'scope-d',
        epoch: 'epoch-1',
        revision: 'revision-1',
        boundary: null,
        request: { limit: 1 },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      registry.issueCatalogCursor({
        chainId: 'chain-d',
        scopeKey: 'scope-d',
        epoch: 'epoch-1',
        revision: 'revision-1',
        boundary: null,
        request: { limit: 1 },
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_capacity',
        retryable: true,
        message: 'session surface cursor capacity exceeded',
      });
    }
  });

  it('reclaims frozen snapshot bytes from completed chains before failing capacity', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['snapshot-1', 'snapshot-2', 'snapshot-3']),
      limits: {
        maxFrozenSnapshotBytes: 20,
        maxChains: 2,
        maxEntries: 3,
        maxEntriesPerChain: 2,
      },
    });

    const firstToken = registry.issueSnapshotToken({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      frozenSnapshot: { values: [1] },
    });
    registry.completeChain('chain-a');

    registry.issueSnapshotToken({
      chainId: 'chain-b',
      locatorDigest: 'locator-b',
      transcriptFingerprint: 'fingerprint-b',
      frozenSnapshot: { values: [2] },
    });
    expect(registry.stats().frozenSnapshotBytes).toBe(
      Buffer.byteLength(JSON.stringify({ values: [2] }), 'utf8')
    );

    await expect(
      registry.assertSnapshotToken({
        token: firstToken,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      return true;
    });

    expect(() =>
      registry.issueSnapshotToken({
        chainId: 'chain-c',
        locatorDigest: 'locator-c',
        transcriptFingerprint: 'fingerprint-c',
        frozenSnapshot: {
          values: ['this', 'string', 'payload', 'is', 'too', 'large'],
        },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
  });

  it('measures frozen snapshot bytes from an internal clone and rejects non-JSON snapshots without leaking internals', async () => {
    const sourceSnapshot = {
      label: 'alpha',
      nested: ['one', 'two'],
    };
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['snapshot-1']),
      limits: {
        maxFrozenSnapshotBytes: 128,
      },
    });

    const token = registry.issueSnapshotToken({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      frozenSnapshot: sourceSnapshot,
    });
    sourceSnapshot.label = 'mutated';
    sourceSnapshot.nested.push('three');

    await expect(
      registry.assertSnapshotToken({
        token,
        locatorDigest: 'locator-a',
        transcriptFingerprint: 'fingerprint-a',
      })
    ).resolves.toEqual({
      chainId: 'chain-a',
      locatorDigest: 'locator-a',
      transcriptFingerprint: 'fingerprint-a',
      frozenBytes: Buffer.byteLength(
        JSON.stringify({ label: 'alpha', nested: ['one', 'two'] }),
        'utf8'
      ),
      frozenSnapshot: { label: 'alpha', nested: ['one', 'two'] },
    });

    const circular: { self?: unknown } = {};
    circular.self = circular;
    const issueSnapshotTokenUnsafe = Reflect.get(registry, 'issueSnapshotToken') as (
      this: SessionSurfaceCursorRegistry,
      input: unknown
    ) => string;
    expect(() =>
      issueSnapshotTokenUnsafe.call(registry, {
        chainId: 'chain-b',
        locatorDigest: 'locator-b',
        transcriptFingerprint: 'fingerprint-b',
        frozenSnapshot: circular,
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
    try {
      issueSnapshotTokenUnsafe.call(registry, {
        chainId: 'chain-b',
        locatorDigest: 'locator-b',
        transcriptFingerprint: 'fingerprint-b',
        frozenSnapshot: circular,
      });
    } catch (error) {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      expect(String(error)).not.toContain('circular');
    }
  });

  it('retries token collisions finitely and reports capacity when the source never yields a unique token', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['dup', 'dup', 'dup', 'dup']),
      tokenCollisionRetries: 2,
    });

    registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });

    expect(() =>
      registry.issueCatalogCursor({
        chainId: 'chain-b',
        scopeKey: 'scope-b',
        epoch: 'epoch-1',
        revision: 'revision-1',
        boundary: null,
        request: { limit: 1 },
      })
    ).toThrowError(SessionSurfaceCursorRegistryError);
  });

  it('aborts active loaders, drains close, clears state, and converts private close reasons into fixed unavailable failures', async () => {
    const registry = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['catalog-1']),
    });
    const token = registry.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });
    const aborted = deferred<void>();
    let observedAbortReason = 'missing';

    const redemption = registry.redeemCatalogCursor({
      token,
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      request: { limit: 1 },
      loader: async (_state, signal) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbortReason = String(signal.reason);
            aborted.resolve();
          },
          { once: true }
        );
        return new Promise<{ page: string[] }>((resolve) => {
          setTimeout(() => resolve({ page: ['late-success'] }), 5);
        });
      },
    });

    await flushMicrotasks();
    const closing = registry.close('/private/state/closing-reason');

    await aborted.promise;
    await expect(
      registry.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_unavailable',
        retryable: true,
        message: 'session surface cursor registry is unavailable',
      });
      return true;
    });

    await expect(redemption).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_unavailable',
        retryable: true,
        message: 'session surface cursor registry is unavailable',
      });
      expect(String(error)).not.toContain('/private/state/closing-reason');
      return true;
    });
    await expect(closing).resolves.toBeUndefined();
    await expect(registry.close('ignored')).resolves.toBeUndefined();
    expect(observedAbortReason).not.toContain('/private/state/closing-reason');
    expect(registry.stats()).toMatchObject({
      closed: true,
      entryCount: 0,
      chainCount: 0,
      activeLoads: 0,
      frozenSnapshotBytes: 0,
    });
  });

  it('invalidates tokens across registry restarts because state is instance-owned', async () => {
    const first = new SessionSurfaceCursorRegistry({
      tokenSource: createTokenSource(['catalog-1']),
    });
    const token = first.issueCatalogCursor({
      chainId: 'chain-a',
      scopeKey: 'scope-a',
      epoch: 'epoch-1',
      revision: 'revision-1',
      boundary: null,
      request: { limit: 1 },
    });
    const second = new SessionSurfaceCursorRegistry();

    await expect(
      second.redeemCatalogCursor({
        token,
        scopeKey: 'scope-a',
        epoch: 'epoch-1',
        revision: 'revision-1',
        request: { limit: 1 },
        loader: async () => ({ page: [] }),
      })
    ).rejects.toSatisfy((error: unknown) => {
      expectRegistryError(error, {
        code: 'session_surface_cursor_invalid',
        retryable: false,
        message: 'session surface cursor is invalid',
      });
      return true;
    });
  });
});
