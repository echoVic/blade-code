import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

function surfaceApp(source: string) {
  const app = new Hono();
  app.get('/catalog', (context) => context.json({ source }));
  app.post('/fork', (context) => context.json({ source }));
  return app;
}

function legacyApp(source: string) {
  const app = new Hono();
  app.get('/:sessionId', (context) => context.json({ source }, 418));
  app.post('/:sessionId/fork', (context) => context.json({ source }, 418));
  return app;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BladeServer session surface route ownership', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('mounts /sessions/v2 before the legacy /sessions routes', async () => {
    const surfaceShutdown = vi.fn(async () => undefined);
    const legacyShutdown = vi.fn(async () => undefined);
    vi.doMock('../../../../src/server/routes/sessionSurface.js', () => {
      return {
        createSessionSurfaceRouteController: () => ({
          app: surfaceApp('v2'),
          getStats: () => ({ accepting: true, active: 0, cursors: 0 }),
          shutdown: surfaceShutdown,
        }),
      };
    });
    vi.doMock('../../../../src/server/routes/session.js', () => {
      return {
        createSessionRouteController: () => ({
          app: legacyApp('legacy'),
          dispatchTask: vi.fn(),
          retryTask: vi.fn(),
          updateTask: vi.fn(),
          getTaskDiff: vi.fn(),
          deliverTask: vi.fn(),
          recoverQueuedTasks: vi.fn(async () => undefined),
          getRuntimeResidencyStats: vi.fn(() => ({
            resident: 0,
            reserved: 0,
            pinned: 0,
            maxResident: 0,
          })),
          getProjectionResidencyStats: vi.fn(() => ({
            resident: 0,
            closing: 0,
            reserved: 0,
            pinned: 0,
            retained: 0,
            maxResident: 0,
            idleMs: 0,
          })),
          getCoordinationStats: vi.fn(() => ({
            messageSubmissions: { keys: 0, operations: 0 },
            taskDeliveries: { keys: 0, operations: 0 },
          })),
          getSseConnectionStats: vi.fn(() => ({ accepting: true, active: 0 })),
          shutdown: legacyShutdown,
        }),
      };
    });

    const { BladeServer } = await import('../../../../src/server/server.js');
    const app = BladeServer.getApp();
    const response = await app.request('/sessions/v2/fork', { method: 'POST' });
    const legacyResponse = await app.request('/sessions/local-session/fork', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ source: 'v2' });
    expect(legacyResponse.status).toBe(418);
    await expect(legacyResponse.json()).resolves.toEqual({ source: 'legacy' });
  });

  it('cleans up an owned session surface controller when startup fails after creation', async () => {
    const surfaceShutdown = vi.fn(async () => undefined);
    const sessionShutdown = vi.fn(async () => undefined);
    vi.doMock('../../../../src/server/routes/sessionSurface.js', () => {
      return {
        createSessionSurfaceRouteController: () => ({
          app: surfaceApp('v2'),
          getStats: () => ({ accepting: true, active: 0, cursors: 0 }),
          shutdown: surfaceShutdown,
        }),
      };
    });
    vi.doMock('../../../../src/server/routes/session.js', () => {
      return {
        createSessionRouteController: () => ({
          app: legacyApp('legacy'),
          dispatchTask: vi.fn(),
          retryTask: vi.fn(),
          updateTask: vi.fn(),
          getTaskDiff: vi.fn(),
          deliverTask: vi.fn(),
          recoverQueuedTasks: vi.fn(async () => undefined),
          getRuntimeResidencyStats: vi.fn(() => ({
            resident: 0,
            reserved: 0,
            pinned: 0,
            maxResident: 0,
          })),
          getProjectionResidencyStats: vi.fn(() => ({
            resident: 0,
            closing: 0,
            reserved: 0,
            pinned: 0,
            retained: 0,
            maxResident: 0,
            idleMs: 0,
          })),
          getCoordinationStats: vi.fn(() => ({
            messageSubmissions: { keys: 0, operations: 0 },
            taskDeliveries: { keys: 0, operations: 0 },
          })),
          getSseConnectionStats: vi.fn(() => ({ accepting: true, active: 0 })),
          shutdown: sessionShutdown,
        }),
      };
    });
    vi.doMock('../../../../src/server/routes/events.js', () => {
      return {
        createEventRouteController: () => {
          throw new Error('boom-after-surface');
        },
      };
    });

    const { BladeServer } = await import('../../../../src/server/server.js');
    expect(() => BladeServer.getApp()).toThrow('boom-after-surface');
    await vi.waitFor(() => {
      expect(surfaceShutdown).toHaveBeenCalledWith('server-startup-failure');
      expect(sessionShutdown).toHaveBeenCalledWith('server-startup-failure');
    });
  });

  it('shuts down idempotently, rejects new work, and drains active surface reads', async () => {
    vi.doUnmock('../../../../src/server/routes/sessionSurface.js');
    const { createSessionSurfaceRouteController } = await import(
      '../../../../src/server/routes/sessionSurface.js'
    );
    const readGate = deferred<void>();
    const closeGate = deferred<void>();
    let activeReads = 0;
    const service = {
      listPage: vi.fn(async () => {
        activeReads += 1;
        await readGate.promise;
        activeReads -= 1;
        return { sessions: [] };
      }),
      open: vi.fn(),
      historyPage: vi.fn(),
      fork: vi.fn(),
      close: vi.fn(async () => {
        await closeGate.promise;
      }),
    };
    const controller = createSessionSurfaceRouteController({ service });

    const firstResponsePromise = controller.app.request('/catalog');
    await vi.waitFor(() => {
      expect(service.listPage).toHaveBeenCalledTimes(1);
      expect(controller.getStats()).toEqual({
        accepting: true,
        active: 1,
        cursors: 0,
      });
      expect(activeReads).toBe(1);
    });

    const shutdownPromise = controller.shutdown('server-shutdown');
    expect(controller.getStats()).toEqual({
      accepting: false,
      active: 1,
      cursors: 0,
    });

    const secondResponse = await controller.app.request('/catalog');
    expect(secondResponse.status).toBe(503);
    await expect(secondResponse.json()).resolves.toEqual({
      error: {
        code: 'session_surface_unavailable',
        message: 'Session surface is unavailable',
        retryable: true,
      },
    });

    closeGate.resolve();
    readGate.resolve();
    await shutdownPromise;
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(503);
    await expect(firstResponse.json()).resolves.toEqual({
      error: {
        code: 'session_surface_unavailable',
        message: 'Session surface is unavailable',
        retryable: true,
      },
    });

    await expect(controller.shutdown('duplicate')).resolves.toBeUndefined();
  });

  it('owns and clears the real surface controller across idempotent server stop', async () => {
    vi.doUnmock('../../../../src/server/routes/sessionSurface.js');
    vi.doUnmock('../../../../src/server/routes/session.js');
    vi.doUnmock('../../../../src/server/routes/events.js');
    vi.doUnmock('node:http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const server = await BladeServer.listenAsync({
      hostname: '127.0.0.1',
      port: 0,
    });

    expect(BladeServer.getSessionSurfaceStatsForTests()).toEqual({
      accepting: true,
      active: 0,
      cursors: 0,
    });
    await expect(Promise.all([server.stop(), server.stop()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(BladeServer.isRunning()).toBe(false);
    expect(BladeServer.getSessionSurfaceStatsForTests()).toBeUndefined();
  });

  it('rejects an oversized chunked V2 body before the client finishes sending it', async () => {
    vi.doUnmock('../../../../src/server/routes/sessionSurface.js');
    vi.doUnmock('../../../../src/server/routes/session.js');
    vi.doUnmock('../../../../src/server/routes/events.js');
    vi.doUnmock('node:http');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const { request: createHttpRequest } =
      await vi.importActual<typeof import('node:http')>('node:http');
    const server = await BladeServer.listenAsync({
      hostname: '127.0.0.1',
      port: 0,
    });
    let client: ReturnType<typeof createHttpRequest> | undefined;

    try {
      const responsePromise = new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          client = createHttpRequest(
            new URL('/sessions/v2/open', server.url),
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                connection: 'close',
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.once('end', () =>
                resolve({
                  status: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8'),
                })
              );
            }
          );
          client.once('error', reject);
          client.write(Buffer.alloc(40 * 1024, 0x61));
          client.write(Buffer.alloc(40 * 1024, 0x62));
        }
      );
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('server waited for the unbounded request body')),
            1_000
          )
        ),
      ]);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: {
          code: 'invalid_session_surface_request',
          message: 'Session surface request is invalid',
          retryable: false,
        },
      });
    } finally {
      client?.destroy();
      await server.stop();
    }
  });

  it('cleans surface ownership after a real transport startup failure and can restart', async () => {
    vi.doUnmock('../../../../src/server/routes/sessionSurface.js');
    vi.doUnmock('../../../../src/server/routes/session.js');
    vi.doUnmock('../../../../src/server/routes/events.js');
    vi.doUnmock('node:http');
    const { createServer } =
      await vi.importActual<typeof import('node:http')>('node:http');
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const port = (occupied.address() as AddressInfo).port;
    const surfaceModule = await import(
      '../../../../src/services/SessionSurfaceService.js'
    );
    const closeSpy = vi.spyOn(surfaceModule.SessionSurfaceService.prototype, 'close');
    const { BladeServer } = await import('../../../../src/server/server.js');

    try {
      await expect(
        BladeServer.listenAsync({ hostname: '127.0.0.1', port })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(closeSpy).toHaveBeenCalledWith('server-startup-failure');
      expect(BladeServer.getSessionSurfaceStatsForTests()).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const restarted = await BladeServer.listenAsync({
      hostname: '127.0.0.1',
      port: 0,
    });
    try {
      expect(BladeServer.getSessionSurfaceStatsForTests()?.accepting).toBe(true);
    } finally {
      await restarted.stop();
    }
  });

  it('stops the real transport and controllers when post-listen bootstrap fails', async () => {
    vi.doUnmock('../../../../src/server/routes/sessionSurface.js');
    vi.doUnmock('../../../../src/server/routes/session.js');
    vi.doUnmock('../../../../src/server/routes/events.js');
    vi.doUnmock('node:http');
    const taskSchedulerModule = await import(
      '../../../../src/agent/runtime/TaskScheduler.js'
    );
    const bootstrapFailure = new Error('injected scheduler bootstrap failure');
    const schedulerStart = vi
      .spyOn(taskSchedulerModule.TaskScheduler.prototype, 'start')
      .mockImplementationOnce(() => {
        throw bootstrapFailure;
      });
    const surfaceModule = await import(
      '../../../../src/services/SessionSurfaceService.js'
    );
    const closeSpy = vi.spyOn(surfaceModule.SessionSurfaceService.prototype, 'close');
    const { BladeServer } = await import('../../../../src/server/server.js');
    const { createServer } =
      await vi.importActual<typeof import('node:http')>('node:http');
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => (error ? reject(error) : resolve()));
    });

    await expect(BladeServer.listenAsync({ hostname: '127.0.0.1', port })).rejects.toBe(
      bootstrapFailure
    );
    expect(closeSpy).toHaveBeenCalledWith('server-startup-failure');
    expect(BladeServer.isRunning()).toBe(false);
    expect(BladeServer.getSessionSurfaceStatsForTests()).toBeUndefined();

    schedulerStart.mockRestore();
    const restarted = await BladeServer.listenAsync({
      hostname: '127.0.0.1',
      port,
    });
    try {
      expect(BladeServer.isRunning()).toBe(true);
    } finally {
      await restarted.stop();
    }
  });

  it('cleans the Bun transport and controllers when synchronous bootstrap fails', async () => {
    vi.doUnmock('../../../../src/server/routes/sessionSurface.js');
    vi.doUnmock('../../../../src/server/routes/session.js');
    vi.doUnmock('../../../../src/server/routes/events.js');
    const taskSchedulerModule = await import(
      '../../../../src/agent/runtime/TaskScheduler.js'
    );
    const bootstrapFailure = new Error('injected synchronous bootstrap failure');
    const schedulerStart = vi
      .spyOn(taskSchedulerModule.TaskScheduler.prototype, 'start')
      .mockImplementationOnce(() => {
        throw bootstrapFailure;
      });
    const surfaceModule = await import(
      '../../../../src/services/SessionSurfaceService.js'
    );
    const closeSpy = vi.spyOn(surfaceModule.SessionSurfaceService.prototype, 'close');
    const transportStop = vi.fn();
    vi.stubGlobal('Bun', {
      serve: vi.fn(() => ({
        url: new URL('http://127.0.0.1:4096'),
        port: 4096,
        hostname: '127.0.0.1',
        stop: transportStop,
      })),
    });
    const { BladeServer } = await import('../../../../src/server/server.js');

    expect(() => BladeServer.listen({ hostname: '127.0.0.1', port: 4096 })).toThrow(
      bootstrapFailure
    );
    expect(BladeServer.isRunning()).toBe(false);
    expect(BladeServer.getSessionSurfaceStatsForTests()).toBeUndefined();

    schedulerStart.mockRestore();
    const restarted = BladeServer.listen({ hostname: '127.0.0.1', port: 4096 });
    await vi.waitFor(() => {
      expect(transportStop).toHaveBeenCalledWith(true);
      expect(closeSpy).toHaveBeenCalledWith('server-startup-failure');
    });

    await restarted.stop();
  });
});
