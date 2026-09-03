import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';

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

function createProtectedHostStateRoot(storageRoot: string): string {
  const descriptor = createAcpRemoteWorkspaceDescriptor(
    createAcpRemotePathProfile('/remote/workspace')
  );
  return deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity, storageRoot);
}

describe('terminal routes', () => {
  let previousStorageRoot: string | undefined;
  let storageRoot: string;
  let localWorkspace: string;
  let protectedHostStateRoot: string;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-terminal-routes-store-'));
    localWorkspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-terminal-routes-workspace-')
    );
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    protectedHostStateRoot = createProtectedHostStateRoot(storageRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('http');
    delete (globalThis as Record<string, unknown>).Bun;
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(localWorkspace, { recursive: true, force: true }),
    ]);
  });

  it('rejects protected ACP host-state cwd before Bun websocket upgrade or spawn', async () => {
    const upgradeWebSocket = vi.fn(
      (
        factory: (
          context: RequestContext
        ) =>
          | Response
          | Record<string, unknown>
          | Promise<Response | Record<string, unknown>>
      ) => {
        return async (context: RequestContext) => {
          const result = await factory(context);
          if (result instanceof Response) {
            return result;
          }
          const upgraded = serverUpgrade(context.req.raw, { data: result });
          return upgraded ? new Response(null) : undefined;
        };
      }
    );
    const serverUpgrade = vi.fn(
      (_request: Request, _options: { data: Record<string, unknown> }) => true
    );
    const spawn = vi.fn();

    type RequestContext = {
      req: {
        query(name: string): string | undefined;
        raw: Request;
        url: string;
        header(name: string): string | undefined;
      };
      get(name: 'directory'): string;
      json(body: unknown, status?: number): Response;
      text(body: string, status?: number): Response;
    };

    vi.doMock('hono/bun', () => ({
      createBunWebSocket: () => ({
        upgradeWebSocket,
        websocket: {},
      }),
    }));
    vi.doMock('bun-pty', () => ({
      spawn,
    }));
    (globalThis as Record<string, unknown>).Bun = {
      serve: vi.fn(),
    };

    const { TerminalRoutes } = await import(
      '../../../../src/server/routes/terminal.js'
    );
    const app = TerminalRoutes();

    const response = await app.request(
      `http://localhost/ws?cwd=${encodeURIComponent(protectedHostStateRoot)}`,
      {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      },
      {
        directory: localWorkspace,
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('cwd must reference a local workspace');
    expect(serverUpgrade).not.toHaveBeenCalled();
    expect(upgradeWebSocket).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still upgrades Bun websocket requests for ordinary local cwd values', async () => {
    const upgradeWebSocket = vi.fn(
      (
        factory: (
          context: RequestContext
        ) =>
          | Response
          | Record<string, unknown>
          | Promise<Response | Record<string, unknown>>
      ) => {
        return async (context: RequestContext) => {
          const result = await factory(context);
          if (result instanceof Response) {
            return result;
          }
          const upgraded = serverUpgrade(context.req.raw, { data: result });
          return upgraded ? new Response(null) : undefined;
        };
      }
    );
    const serverUpgrade = vi.fn(
      (_request: Request, _options: { data: Record<string, unknown> }) => true
    );

    type RequestContext = {
      req: {
        query(name: string): string | undefined;
        raw: Request;
        url: string;
        header(name: string): string | undefined;
      };
      get(name: 'directory'): string;
      json(body: unknown, status?: number): Response;
      text(body: string, status?: number): Response;
    };

    vi.doMock('hono/bun', () => ({
      createBunWebSocket: () => ({
        upgradeWebSocket,
        websocket: {},
      }),
    }));
    (globalThis as Record<string, unknown>).Bun = {
      serve: vi.fn(),
    };

    const { TerminalRoutes } = await import(
      '../../../../src/server/routes/terminal.js'
    );
    const app = TerminalRoutes();

    const response = await app.request(
      `http://localhost/ws?cwd=${encodeURIComponent(localWorkspace)}`,
      {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      },
      {
        directory: localWorkspace,
      }
    );

    expect(response.status).toBe(200);
    expect(serverUpgrade).toHaveBeenCalledOnce();
  });

  it('returns fixed HTTP 400 before Node handleUpgrade for protected ACP host-state cwd', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    delete (globalThis as Record<string, unknown>).Bun;
    const wsModule = await import('ws');
    const handleUpgradeSpy = vi.spyOn(
      wsModule.WebSocketServer.prototype,
      'handleUpgrade'
    );
    const { BladeServer } = await import('../../../../src/server/server.js');
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const socket = net.createConnection({
        host: '127.0.0.1',
        port: server.port,
      });

      const response = await withTimeout(
        new Promise<string>((resolve, reject) => {
          let data = '';
          socket.setEncoding('utf8');
          socket.on('connect', () => {
            socket.write(
              [
                `GET /terminal/ws?cwd=${encodeURIComponent(protectedHostStateRoot)} HTTP/1.1`,
                `Host: 127.0.0.1:${server.port}`,
                'Connection: Upgrade',
                'Upgrade: websocket',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                '',
                '',
              ].join('\r\n')
            );
          });
          socket.on('data', (chunk: string) => {
            data += chunk;
            if (data.includes('\r\n\r\n')) {
              resolve(data);
            }
          });
          socket.on('error', reject);
          socket.on('close', () => {
            if (!data) {
              reject(new Error('Socket closed before receiving a response'));
            }
          });
        }),
        2000,
        'Timed out waiting for terminal websocket rejection'
      );

      expect(response).toContain('HTTP/1.1 400 Bad Request');
      expect(response).toContain('Connection: close');
      expect(handleUpgradeSpy).not.toHaveBeenCalled();
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  it('returns fixed HTTP 400 before Node handleUpgrade for a malformed host', async () => {
    vi.resetModules();
    vi.doUnmock('http');
    delete (globalThis as Record<string, unknown>).Bun;
    const wsModule = await import('ws');
    const handleUpgradeSpy = vi.spyOn(
      wsModule.WebSocketServer.prototype,
      'handleUpgrade'
    );
    const { BladeServer } = await import('../../../../src/server/server.js');
    const server = await BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' });

    try {
      const socket = net.createConnection({ host: '127.0.0.1', port: server.port });
      const response = await withTimeout(
        new Promise<string>((resolve, reject) => {
          let data = '';
          socket.setEncoding('utf8');
          socket.on('connect', () => {
            socket.write(
              [
                'GET /terminal/ws HTTP/1.1',
                'Host: [',
                'Connection: Upgrade',
                'Upgrade: websocket',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                '',
                '',
              ].join('\r\n')
            );
          });
          socket.on('data', (chunk: string) => {
            data += chunk;
            if (data.includes('\r\n\r\n')) resolve(data);
          });
          socket.on('error', reject);
          socket.on('close', () => {
            if (!data) reject(new Error('Socket closed before receiving a response'));
          });
        }),
        2000,
        'Timed out waiting for malformed terminal upgrade rejection'
      );

      expect(response).toContain('HTTP/1.1 400 Bad Request');
      expect(response).toContain('Connection: close');
      expect(handleUpgradeSpy).not.toHaveBeenCalled();
      socket.destroy();
    } finally {
      await server.stop();
    }
  });
});
