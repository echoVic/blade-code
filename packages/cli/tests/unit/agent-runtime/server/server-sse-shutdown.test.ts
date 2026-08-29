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
      await stopPromise?.catch(() => undefined);
      await server.stop().catch(() => undefined);
    }
  });
});
