import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server as NodeServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import {
  resetWorkspaceAgentResources,
  WorkspaceAgentResourceCapacityError,
} from '../agent/resources/WorkspaceAgentResources.js';
import { TaskScheduler } from '../agent/runtime/TaskScheduler.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { scheduleStore } from '../services/ScheduleStore.js';
import { SessionService } from '../services/SessionService.js';
import { getCwd } from '../utils/cwd.js';
import { getVersion } from '../utils/packageInfo.js';
import { BladeServerError, TooManyRequestsError } from './error.js';
import { ConfigRoutes } from './routes/config.js';
import { EventRoutes } from './routes/events.js';
import { GlobalRoutes } from './routes/global.js';
import { HookRoutes } from './routes/hooks.js';
import { McpRoutes } from './routes/mcp.js';
import { ModelsRoutes } from './routes/models.js';
import { PermissionRoutes } from './routes/permission.js';
import { PluginRoutes } from './routes/plugins.js';
import { ProjectRoutes } from './routes/projects.js';
import { ProviderRoutes } from './routes/provider.js';
import { ScheduleRoutes } from './routes/schedule.js';
import {
  createSessionRouteController,
  type SessionRouteController,
} from './routes/session.js';
import { SkillsRoutes } from './routes/skills.js';
import { SuggestionsRoutes } from './routes/suggestions.js';
import { TaskRoutes } from './routes/task.js';
import { TeamRoutes } from './routes/team.js';
import {
  setupNodeWebSocket,
  TerminalRoutes,
  terminalWebSocket,
} from './routes/terminal.js';
import { WorkspaceTrustRoutes } from './routes/workspaceTrust.js';

const logger = createLogger(LogCategory.SERVICE);

export interface ServerOptions {
  port: number;
  hostname: string;
  cors?: string[];
  password?: string;
  username?: string;
}

let corsWhitelist: string[] = [];
let recoverQueuedTasksOnStart: (() => Promise<unknown>) | undefined;
let taskScheduler: TaskScheduler | undefined;
let staleSessionGcTimer: ReturnType<typeof setInterval> | undefined;
let activeSessionController: SessionRouteController | undefined;
const staticAssetContentCache = new Map<string, Buffer>();
const staticAssetCompressionCache = new Map<string, Buffer>();
const COMPRESSIBLE_ASSET_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.svg',
]);
const STATIC_COMPRESSION_MIN_BYTES = 1024;
const STALE_SESSION_GC_INTERVAL_MS = 60 * 60 * 1000;

type Variables = {
  directory: string;
};

export type StaticContentEncoding = 'br' | 'gzip';

function acceptedEncodingQuality(
  acceptEncoding: string | undefined,
  encoding: StaticContentEncoding
): number {
  if (!acceptEncoding) return 0;
  const entries = acceptEncoding.split(',').map((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    const qualityParameter = parameters.find((parameter) =>
      parameter.trim().startsWith('q=')
    );
    const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
    return {
      name,
      quality: Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : 0,
    };
  });
  return (
    entries.find((entry) => entry.name === encoding)?.quality ??
    entries.find((entry) => entry.name === '*')?.quality ??
    0
  );
}

function startStaleSessionGc(): void {
  if (staleSessionGcTimer) return;
  const collect = () => {
    void SessionService.collectStaleEmptySessions()
      .then((removed) => {
        if (removed > 0) {
          logger.info(`[SessionGC] removed ${removed} stale empty session(s)`);
        }
      })
      .catch((error) => {
        logger.warn('[SessionGC] failed to collect stale empty sessions:', error);
      });
  };
  collect();
  staleSessionGcTimer = setInterval(collect, STALE_SESSION_GC_INTERVAL_MS);
  staleSessionGcTimer.unref?.();
}

function stopStaleSessionGc(): void {
  if (!staleSessionGcTimer) return;
  clearInterval(staleSessionGcTimer);
  staleSessionGcTimer = undefined;
}

export function selectStaticContentEncoding(
  acceptEncoding: string | undefined
): StaticContentEncoding | undefined {
  const candidates = (['br', 'gzip'] as const)
    .map((encoding) => ({
      encoding,
      quality: acceptedEncodingQuality(acceptEncoding, encoding),
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort(
      (left, right) => right.quality - left.quality || (left.encoding === 'br' ? -1 : 1)
    );
  return candidates[0]?.encoding;
}

function readStaticAsset(filePath: string): Buffer {
  const cached = staticAssetContentCache.get(filePath);
  if (cached) return cached;
  const content = readFileSync(filePath);
  staticAssetContentCache.set(filePath, content);
  return content;
}

function compressStaticAsset(
  filePath: string,
  content: Buffer,
  encoding: StaticContentEncoding
): Buffer {
  const cacheKey = `${encoding}:${filePath}`;
  const cached = staticAssetCompressionCache.get(cacheKey);
  if (cached) return cached;

  const compressed =
    encoding === 'br'
      ? brotliCompressSync(content, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          },
        })
      : gzipSync(content, { level: 6 });
  staticAssetCompressionCache.set(cacheKey, compressed);
  return compressed;
}

function getWebDistPath(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));

  const possiblePaths = [
    join(currentDir, 'web'),
    join(getCwd(), 'dist/web'),
    join(getCwd(), 'packages/cli/dist/web'),
  ];

  for (const p of possiblePaths) {
    const indexPath = join(p, 'index.html');
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, 'utf-8');
      if (content.includes('/assets/')) {
        logger.debug(`[Server] Found web dist at: ${p}`);
        return p;
      }
    }
  }

  return null;
}

function createApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((err, c) => {
    logger.error('[Server] Request error:', err);

    if (err instanceof WorkspaceAgentResourceCapacityError) {
      const overload = new TooManyRequestsError(err.message, {
        resource: 'workspace_agent_resources',
        limit: err.capacity,
      });
      return c.json(overload.toObject(), 429);
    }

    if (err instanceof BladeServerError) {
      return c.json(
        err.toObject(),
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message } }, 500);
  });

  app.use(async (c, next) => {
    const password = process.env.BLADE_SERVER_PASSWORD;
    if (!password) {
      return next();
    }

    const path = c.req.path;
    if (
      path === '/' ||
      path === '/favicon.svg' ||
      path.startsWith('/assets/') ||
      path.endsWith('.html') ||
      path.endsWith('.js') ||
      path.endsWith('.css')
    ) {
      return next();
    }

    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Basic ')) {
      c.header('WWW-Authenticate', 'Basic realm="Blade Server"');
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401
      );
    }

    const credentials = Buffer.from(auth.slice(6), 'base64').toString();
    const [username, pwd] = credentials.split(':');
    const expectedUsername = process.env.BLADE_SERVER_USERNAME ?? 'blade';

    if (username !== expectedUsername || pwd !== password) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } },
        401
      );
    }

    return next();
  });

  app.use(async (c, next) => {
    const skipLogging =
      c.req.path === '/health' ||
      c.req.path === '/global/health' ||
      c.req.path.startsWith('/assets/');
    if (!skipLogging) {
      logger.debug(`[Server] ${c.req.method} ${c.req.path}`);
    }

    const start = Date.now();
    await next();

    if (!skipLogging) {
      const duration = Date.now() - start;
      logger.debug(
        `[Server] ${c.req.method} ${c.req.path} - ${c.res.status} (${duration}ms)`
      );
    }
  });

  app.use(
    cors({
      origin(origin) {
        if (!origin) return undefined;

        if (origin.startsWith('http://localhost:')) return origin;
        if (origin.startsWith('http://127.0.0.1:')) return origin;
        if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost')
          return origin;

        if (corsWhitelist.includes(origin)) return origin;

        return undefined;
      },
    })
  );

  app.use(async (c, next) => {
    let directory =
      c.req.query('directory') || c.req.header('x-blade-directory') || getCwd();
    try {
      directory = decodeURIComponent(directory);
    } catch {
      // Keep original directory if decoding fails
    }
    c.set('directory', directory);
    return next();
  });

  const sessionController = createSessionRouteController();
  activeSessionController = sessionController;
  recoverQueuedTasksOnStart = sessionController.recoverQueuedTasks;
  taskScheduler = new TaskScheduler({
    dispatch: (input) => sessionController.dispatchTask(input),
    store: scheduleStore,
  });
  app.route('/global', GlobalRoutes());
  app.route('/events', EventRoutes());
  app.route('/sessions', sessionController.app);
  app.route('/tasks', TaskRoutes(sessionController));
  app.route('/teams', TeamRoutes());
  app.route('/schedules', ScheduleRoutes(scheduleStore, taskScheduler));
  app.route('/configs', ConfigRoutes());
  app.route('/permissions', PermissionRoutes());
  app.route('/plugins', PluginRoutes());
  app.route('/hooks', HookRoutes());
  app.route('/workspace-trust', WorkspaceTrustRoutes());
  app.route('/providers', ProviderRoutes());
  app.route('/models', ModelsRoutes());
  app.route('/projects', ProjectRoutes());
  app.route('/suggestions', SuggestionsRoutes());
  app.route('/terminal', TerminalRoutes());
  app.route('/mcp', McpRoutes());
  app.route('/skills', SkillsRoutes());

  app.get('/health', (c) => {
    return c.json({ healthy: true, version: getVersion() });
  });

  const webDistPath = getWebDistPath();

  if (webDistPath) {
    logger.info(`[Server] Serving static files from ${webDistPath}`);

    app.get('/favicon.svg', () => {
      const filePath = join(webDistPath, 'favicon.svg');
      if (!existsSync(filePath)) {
        return new Response(null, { status: 404 });
      }
      return new Response(readFileSync(filePath), {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    });

    app.get('/assets/*', (c) => {
      const filePath = join(webDistPath, c.req.path);

      if (!existsSync(filePath)) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `File not found: ${c.req.path}` } },
          404
        );
      }

      const content = readStaticAsset(filePath);
      const ext = extname(filePath).toLowerCase();

      const mimeTypes: Record<string, string> = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const contentEncoding =
        COMPRESSIBLE_ASSET_EXTENSIONS.has(ext) &&
        content.byteLength >= STATIC_COMPRESSION_MIN_BYTES
          ? selectStaticContentEncoding(c.req.header('Accept-Encoding'))
          : undefined;
      const responseContent = contentEncoding
        ? compressStaticAsset(filePath, content, contentEncoding)
        : content;

      return new Response(new Uint8Array(responseContent), {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(responseContent.byteLength),
          'Cache-Control': 'public, max-age=31536000, immutable',
          Vary: 'Accept-Encoding',
          ...(contentEncoding ? { 'Content-Encoding': contentEncoding } : {}),
        },
      });
    });

    app.get('/', (c) => {
      const indexPath = join(webDistPath, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');
      return c.html(html, 200, { 'Cache-Control': 'no-cache' });
    });

    app.get('*', (c) => {
      const path = c.req.path;

      if (path.includes('.')) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `File not found: ${path}` } },
          404
        );
      }

      const indexPath = join(webDistPath, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');
      return c.html(html, 200, { 'Cache-Control': 'no-cache' });
    });
  } else {
    logger.warn(
      '[Server] Web UI not found. Run "cd packages/cli/web && bun run build" to enable web interface.'
    );

    app.get('/', (c) => {
      return c.json({
        message: 'Blade API Server',
        version: getVersion(),
        webUI: false,
        hint: 'Web UI not built. Run "cd packages/cli/web && bun run build" to enable.',
        endpoints: {
          health: '/health',
          sessions: '/sessions',
          configs: '/configs',
          permissions: '/permissions',
          providers: '/providers',
        },
      });
    });

    app.all('*', (c) => {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `Route not found: ${c.req.path}` } },
        404
      );
    });
  }

  return app;
}

export function getNetworkIPs(): string[] {
  const nets = networkInterfaces();
  const results: string[] = [];

  for (const name of Object.keys(nets)) {
    const net = nets[name];
    if (!net) continue;

    for (const netInfo of net) {
      if (netInfo.internal || netInfo.family !== 'IPv4') continue;
      if (netInfo.address.startsWith('172.')) continue;
      results.push(netInfo.address);
    }
  }

  return results;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
}

interface BunServer {
  url: URL;
  port: number;
  hostname: string;
  stop: (closeActiveConnections?: boolean) => void;
}

interface ServerHandle {
  url: URL;
  port: number;
  hostname: string;
  stop: () => Promise<void>;
}

function startWithBun(
  honoApp: Hono<{ Variables: Variables }>,
  opts: ServerOptions
): ServerHandle {
  const Bun = (globalThis as Record<string, unknown>).Bun as {
    serve: (options: {
      hostname: string;
      port: number;
      fetch: (request: Request, server: unknown) => Response | Promise<Response>;
      idleTimeout?: number;
      websocket?: unknown;
    }) => BunServer;
  };

  const tryServe = (port: number): BunServer | undefined => {
    try {
      return Bun.serve({
        hostname: opts.hostname,
        port,
        fetch: honoApp.fetch,
        idleTimeout: 0,
        websocket: terminalWebSocket,
      });
    } catch (err) {
      logger.error('Failed to start Bun server:', err);
      return undefined;
    }
  };

  const server =
    opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port);

  if (!server) {
    throw new Error(`Failed to start Bun server on port ${opts.port}`);
  }

  return {
    url: server.url,
    port: server.port,
    hostname: server.hostname,
    stop: async () => {
      server.stop(true);
    },
  };
}

function startWithNode(
  honoApp: Hono<{ Variables: Variables }>,
  opts: ServerOptions
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const server: NodeServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          if (Array.isArray(value)) {
            for (const v of value) {
              headers.append(key, v);
            }
          } else {
            headers.set(key, value);
          }
        }
      }

      let body: BodyInit | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const buffer = await new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
        });
        body = buffer.toString();
      }

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
      });

      try {
        const response = await honoApp.fetch(request);

        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        if (response.body) {
          const reader = response.body.getReader();
          const pump = async (): Promise<void> => {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              return;
            }
            res.write(value);
            return pump();
          };
          await pump();
        } else {
          const text = await response.text();
          res.end(text);
        }
      } catch (error) {
        logger.error('[Server] Node request error:', error);
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
          })
        );
      }
    });

    // Set up WebSocket server for terminal (noServer mode for manual upgrade handling)
    const wss = new WebSocketServer({ noServer: true });
    const currentDirectory = getCwd();
    setupNodeWebSocket(wss, () => currentDirectory);

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      if (url.pathname === '/terminal/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    const tryListen = (port: number): Promise<number> => {
      return new Promise((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(err);
          } else {
            reject(err);
          }
        });
        server.listen(port, opts.hostname, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            resolve(addr.port);
          } else {
            resolve(port);
          }
        });
      });
    };

    const startServer = async () => {
      let actualPort: number;

      if (opts.port === 0) {
        try {
          actualPort = await tryListen(4096);
        } catch {
          actualPort = await tryListen(0);
        }
      } else {
        actualPort = await tryListen(opts.port);
      }

      const url = new URL(
        `http://${opts.hostname === '0.0.0.0' ? 'localhost' : opts.hostname}:${actualPort}`
      );

      resolve({
        url,
        port: actualPort,
        hostname: opts.hostname,
        stop: async () => {
          return new Promise((resolve) => {
            wss.close(() => {
              server.close(() => resolve());
            });
          });
        },
      });
    };

    startServer().catch(reject);
  });
}

export namespace BladeServer {
  let serverHandle: ServerHandle | undefined;
  let app: Hono<{ Variables: Variables }> | undefined;
  let stopPromise: Promise<void> | undefined;

  const stopOwnedServer = (
    handle: ServerHandle,
    sessionController: SessionRouteController | undefined
  ): Promise<void> => {
    if (serverHandle !== handle) return Promise.resolve();
    if (stopPromise) return stopPromise;

    const routeShutdown = sessionController?.shutdown('server-shutdown');
    taskScheduler?.stop();
    stopStaleSessionGc();
    stopPromise = (async () => {
      let firstError: unknown;
      const attempt = async (cleanup: (() => Promise<void>) | undefined) => {
        if (!cleanup) return;
        try {
          await cleanup();
        } catch (error) {
          firstError ??= error;
        }
      };

      await attempt(() => handle.stop());
      await attempt(routeShutdown ? () => routeShutdown : undefined);
      resetWorkspaceAgentResources();

      if (serverHandle === handle) {
        serverHandle = undefined;
        app = undefined;
        activeSessionController = undefined;
        recoverQueuedTasksOnStart = undefined;
        taskScheduler = undefined;
      }
      logger.info('[Server] Blade server stopped');
      if (firstError !== undefined) throw firstError;
    })();
    return stopPromise;
  };

  export function getApp(): Hono<{ Variables: Variables }> {
    if (!app) {
      app = createApp();
    }
    return app;
  }

  export function listen(opts: ServerOptions): ServerHandle {
    corsWhitelist = opts.cors ?? [];

    const honoApp = getApp();

    if (isBunRuntime()) {
      serverHandle = startWithBun(honoApp, opts);
      stopPromise = undefined;
      logger.info(
        `[Server] Blade server listening on ${serverHandle.url} (Bun runtime)`
      );
    } else {
      throw new Error(
        'Blade web server requires Bun runtime. ' +
          'Please run with Bun: `bun run blade web` or install Bun from https://bun.sh'
      );
    }

    const handle = serverHandle;
    const sessionController = activeSessionController;
    void recoverQueuedTasksOnStart?.().catch((error) => {
      logger.warn('[Server] Failed to recover queued tasks:', error);
    });
    taskScheduler?.start();
    startStaleSessionGc();

    return {
      url: handle.url,
      port: handle.port,
      hostname: handle.hostname,
      stop: () => stopOwnedServer(handle, sessionController),
    };
  }

  export async function listenAsync(opts: ServerOptions): Promise<ServerHandle> {
    corsWhitelist = opts.cors ?? [];

    const honoApp = getApp();

    if (isBunRuntime()) {
      serverHandle = startWithBun(honoApp, opts);
      logger.info(
        `[Server] Blade server listening on ${serverHandle.url} (Bun runtime)`
      );
    } else {
      serverHandle = await startWithNode(honoApp, opts);
      logger.info(
        `[Server] Blade server listening on ${serverHandle.url} (Node.js runtime)`
      );
    }
    stopPromise = undefined;

    const handle = serverHandle;
    const sessionController = activeSessionController;
    try {
      await recoverQueuedTasksOnStart?.();
    } catch (error) {
      logger.warn('[Server] Failed to recover queued tasks:', error);
    }
    taskScheduler?.start();
    startStaleSessionGc();

    return {
      url: handle.url,
      port: handle.port,
      hostname: handle.hostname,
      stop: () => stopOwnedServer(handle, sessionController),
    };
  }

  export function isRunning(): boolean {
    return serverHandle !== undefined;
  }

  export function getSessionCoordinationStatsForTests() {
    return activeSessionController?.getCoordinationStats();
  }
}
