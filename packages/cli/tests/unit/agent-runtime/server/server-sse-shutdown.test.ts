import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SseEvent = {
  type: string;
  seq?: number;
  properties: Record<string, unknown>;
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder
): Promise<SseEvent> {
  let buffer = '';
  while (true) {
    const result = await withTimeout(
      reader.read(),
      2000,
      'Timed out waiting for SSE event'
    );
    if (result.done) {
      throw new Error('SSE stream ended before the next event was received');
    }
    buffer += decoder.decode(result.value, { stream: true });
    const delimiterIndex = buffer.indexOf('\n\n');
    if (delimiterIndex === -1) {
      continue;
    }
    const rawEvent = buffer.slice(0, delimiterIndex);
    buffer = buffer.slice(delimiterIndex + 2);
    const data = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) {
      continue;
    }
    return JSON.parse(data) as SseEvent;
  }
}

describe('BladeServer real Node SSE shutdown', () => {
  let storageRoot: string;
  let workspace: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-sse-stop-store-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-sse-stop-workspace-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  it('stops the real Node server and drains both SSE readers without client abort', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');

    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });
    const globalAbort = new AbortController();
    const sessionAbort = new AbortController();
    let stopPromise: Promise<void> | undefined;
    let globalReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sessionReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const createSessionResponse = await fetch(`${server.url}sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace }),
      });
      expect(createSessionResponse.status).toBe(200);
      const created = (await createSessionResponse.json()) as {
        sessionId: string;
        projectPath: string;
      };

      const [globalResponse, sessionResponse] = await Promise.all([
        fetch(`${server.url}events`, {
          signal: globalAbort.signal,
        }),
        fetch(
          `${server.url}sessions/${created.sessionId}/events?projectPath=${encodeURIComponent(
            created.projectPath
          )}`,
          {
            signal: sessionAbort.signal,
          }
        ),
      ]);

      expect(globalResponse.status).toBe(200);
      expect(sessionResponse.status).toBe(200);
      globalReader = globalResponse.body?.getReader();
      sessionReader = sessionResponse.body?.getReader();
      if (!globalReader || !sessionReader) {
        throw new Error('Expected SSE response bodies');
      }
      const globalDecoder = new TextDecoder();
      const sessionDecoder = new TextDecoder();

      await expect(readSseEvent(globalReader, globalDecoder)).resolves.toMatchObject({
        type: 'connected',
      });
      await expect(readSseEvent(sessionReader, sessionDecoder)).resolves.toMatchObject({
        type: 'connected',
        properties: {
          sessionId: created.sessionId,
          projectPath: created.projectPath,
        },
      });

      stopPromise = server.stop();
      const [stopResult, globalDone, sessionDone] = await Promise.all([
        withTimeout(
          stopPromise,
          1000,
          'Timed out waiting for server.stop() to finish while SSE clients remain connected'
        ),
        withTimeout(
          globalReader.read(),
          1000,
          'Timed out waiting for global SSE reader completion during server.stop()'
        ),
        withTimeout(
          sessionReader.read(),
          1000,
          'Timed out waiting for session SSE reader completion during server.stop()'
        ),
      ]);

      expect(stopResult).toBeUndefined();
      expect(globalDone).toMatchObject({ done: true });
      expect(sessionDone).toMatchObject({ done: true });
    } finally {
      globalAbort.abort();
      sessionAbort.abort();
      await globalReader?.cancel().catch(() => undefined);
      await sessionReader?.cancel().catch(() => undefined);
      if (stopPromise) {
        await withTimeout(
          stopPromise,
          2000,
          'Timed out cleaning up stopped server'
        ).catch(() => undefined);
      }
      await withTimeout(
        server.stop(),
        2000,
        'Timed out cleaning up SSE shutdown test server'
      ).catch(() => undefined);
    }
  });

  it('releases both SSE route leases when Node clients disconnect', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    const maybeServer = BladeServer as typeof BladeServer & {
      getSseConnectionStatsForTests?: () => {
        global: { accepting: boolean; active: number } | undefined;
        session: { accepting: boolean; active: number } | undefined;
      };
    };
    if (!maybeServer.getSseConnectionStatsForTests) {
      throw new Error('Expected BladeServer SSE connection stats');
    }

    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });
    const globalAbort = new AbortController();
    const sessionAbort = new AbortController();
    let globalReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sessionReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const baselineSubscribers = Bus.listenerCount('event');

    try {
      const createSessionResponse = await fetch(`${server.url}sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: workspace }),
      });
      const created = (await createSessionResponse.json()) as {
        sessionId: string;
        projectPath: string;
      };

      const [globalResponse, sessionResponse] = await Promise.all([
        fetch(`${server.url}events`, { signal: globalAbort.signal }),
        fetch(
          `${server.url}sessions/${created.sessionId}/events?projectPath=${encodeURIComponent(
            created.projectPath
          )}`,
          { signal: sessionAbort.signal }
        ),
      ]);
      globalReader = globalResponse.body?.getReader();
      sessionReader = sessionResponse.body?.getReader();
      if (!globalReader || !sessionReader) {
        throw new Error('Expected SSE response bodies');
      }
      await Promise.all([
        readSseEvent(globalReader, new TextDecoder()),
        readSseEvent(sessionReader, new TextDecoder()),
      ]);
      expect(maybeServer.getSseConnectionStatsForTests()).toEqual({
        global: { accepting: true, active: 1 },
        session: { accepting: true, active: 1 },
      });
      expect(Bus.listenerCount('event')).toBe(baselineSubscribers + 2);

      globalAbort.abort('client-disconnected');
      sessionAbort.abort('client-disconnected');
      const disconnectedReads = await Promise.allSettled([
        globalReader.read(),
        sessionReader.read(),
      ]);
      for (const result of disconnectedReads) {
        if (result.status === 'fulfilled') {
          expect(result.value).toMatchObject({ done: true });
        } else {
          expect(result.reason).toBe('client-disconnected');
        }
      }
      await vi.waitFor(() => {
        expect(maybeServer.getSseConnectionStatsForTests()).toEqual({
          global: { accepting: true, active: 0 },
          session: { accepting: true, active: 0 },
        });
        expect(Bus.listenerCount('event')).toBe(baselineSubscribers);
      });
      expect(BladeServer.isRunning()).toBe(true);
    } finally {
      globalAbort.abort('test-cleanup');
      sessionAbort.abort('test-cleanup');
      await globalReader?.cancel().catch(() => undefined);
      await sessionReader?.cancel().catch(() => undefined);
      await withTimeout(
        server.stop(),
        2000,
        'Timed out cleaning up SSE disconnect test server'
      ).catch(() => undefined);
    }
  });

  it('retains server ownership so a failed cleanup can be retried', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    const resources = await import(
      '../../../../src/agent/resources/WorkspaceAgentResources.js'
    );
    const cleanupFailure = new Error('injected workspace cleanup failure');
    const resetResources = vi
      .spyOn(resources, 'resetWorkspaceAgentResources')
      .mockImplementationOnce(() => {
        throw cleanupFailure;
      });
    const { BladeServer } = await import('../../../../src/server/server.js');
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      await expect(server.stop()).rejects.toBe(cleanupFailure);
      expect(BladeServer.isRunning()).toBe(true);
      await expect(
        withTimeout(server.stop(), 2000, 'Timed out retrying server cleanup')
      ).resolves.toBeUndefined();
      expect(resetResources).toHaveBeenCalledTimes(2);
      expect(BladeServer.isRunning()).toBe(false);
    } finally {
      resetResources.mockRestore();
      await withTimeout(
        server.stop(),
        2000,
        'Timed out cleaning up retryable stop test server'
      ).catch(() => undefined);
    }
  });
});
