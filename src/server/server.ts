import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server as NodeServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { getVersion } from '../utils/packageInfo.js';
import { BladeServerError } from './error.js';
import { ConfigRoutes } from './routes/config.js';
import { GlobalRoutes } from './routes/global.js';
import { McpRoutes } from './routes/mcp.js';
import { ModelsRoutes } from './routes/models.js';
import { PermissionRoutes } from './routes/permission.js';
import { ProviderRoutes } from './routes/provider.js';
import { SessionRoutes } from './routes/session.js';
import { SkillsRoutes } from './routes/skills.js';
import { SuggestionsRoutes } from './routes/suggestions.js';
import { setupNodeWebSocket, TerminalRoutes, terminalWebSocket } from './routes/terminal.js';

const logger = createLogger(LogCategory.SERVICE);

export interface ServerOptions {
  port: number;
  hostname: string;
  cors?: string[];
  password?: string;
  username?: string;
}

let corsWhitelist: string[] = [];

type Variables = {
  directory: string;
};

function getWebDistPath(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  
  const possiblePaths = [
    join(currentDir, 'web'),
    join(process.cwd(), 'dist/web'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(join(p, 'index.html'))) {
      logger.debug(`[Server] Found web dist at: ${p}`);
      return p;
    }
  }

  return null;
}

function createApp(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((err, c) => {
    logger.error('[Server] Request error:', err);
    
    if (err instanceof BladeServerError) {
      return c.json(err.toObject(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
    }
    
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message } },
      500
    );
  });

  app.use(async (c, next) => {
    const password = process.env.BLADE_SERVER_PASSWORD;
    if (!password) {
      return next();
    }

    const path = c.req.path;
    if (path === '/' || path.startsWith('/assets/') || path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css')) {
      return next();
    }

    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Basic ')) {
      c.header('WWW-Authenticate', 'Basic realm="Blade Server"');
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
    }

    const credentials = Buffer.from(auth.slice(6), 'base64').toString();
    const [username, pwd] = credentials.split(':');
    const expectedUsername = process.env.BLADE_SERVER_USERNAME ?? 'blade';
    
    if (username !== expectedUsername || pwd !== password) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } }, 401);
    }

    return next();
  });

  app.use(async (c, next) => {
    const skipLogging = c.req.path === '/health' || c.req.path === '/global/health' || c.req.path.startsWith('/assets/');
    if (!skipLogging) {
      logger.debug(`[Server] ${c.req.method} ${c.req.path}`);
    }
    
    const start = Date.now();
    await next();
    
    if (!skipLogging) {
      const duration = Date.now() - start;
      logger.debug(`[Server] ${c.req.method} ${c.req.path} - ${c.res.status} (${duration}ms)`);
    }
  });

  app.use(
    cors({
      origin(origin) {
        if (!origin) return undefined;
        
        if (origin.startsWith('http://localhost:')) return origin;
        if (origin.startsWith('http://127.0.0.1:')) return origin;
        if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost') return origin;
        
        if (corsWhitelist.includes(origin)) return origin;
        
        return undefined;
      },
    })
  );

  app.use(async (c, next) => {
    let directory = c.req.query('directory') || c.req.header('x-blade-directory') || process.cwd();
    try {
      directory = decodeURIComponent(directory);
    } catch {
      // Keep original directory if decoding fails
    }
    c.set('directory', directory);
    return next();
  });

  app.route('/global', GlobalRoutes());
  app.route('/sessions', SessionRoutes());
  app.route('/configs', ConfigRoutes());
  app.route('/permissions', PermissionRoutes());
  app.route('/providers', ProviderRoutes());
  app.route('/models', ModelsRoutes());
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
    
    app.get('/assets/*', (c) => {
      const filePath = join(webDistPath, c.req.path);
      
      if (!existsSync(filePath)) {
        return c.json({ error: { code: 'NOT_FOUND', message: `File not found: ${c.req.path}` } }, 404);
      }
      
      const content = readFileSync(filePath);
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
      
      return new Response(content, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    });
    
    app.get('/', (c) => {
      const indexPath = join(webDistPath, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');
      return c.html(html);
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
      return c.html(html);
    });
  } else {
    logger.warn('[Server] Web UI not found. Run "cd web && pnpm build" to enable web interface.');
    
    app.get('/', (c) => {
      return c.json({
        message: 'Blade API Server',
        version: getVersion(),
        webUI: false,
        hint: 'Web UI not built. Run "cd web && pnpm build" to enable.',
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

  const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port);
  
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
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }));
      }
    });

    // Set up WebSocket server for terminal (noServer mode for manual upgrade handling)
    const wss = new WebSocketServer({ noServer: true });
    const currentDirectory = process.cwd();
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

      const url = new URL(`http://${opts.hostname === '0.0.0.0' ? 'localhost' : opts.hostname}:${actualPort}`);

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
      logger.info(`[Server] Blade server listening on ${serverHandle.url} (Bun runtime)`);
    } else {
      throw new Error(
        'Blade web server requires Bun runtime. ' +
        'Please run with Bun: `bun run blade web` or install Bun from https://bun.sh'
      );
    }

    const handle = serverHandle;

    return {
      url: handle.url,
      port: handle.port,
      hostname: handle.hostname,
      stop: async () => {
        if (serverHandle) {
          await serverHandle.stop();
          serverHandle = undefined;
          app = undefined;
          logger.info('[Server] Blade server stopped');
        }
      },
    };
  }

  export async function listenAsync(opts: ServerOptions): Promise<ServerHandle> {
    corsWhitelist = opts.cors ?? [];

    const honoApp = getApp();

    if (isBunRuntime()) {
      serverHandle = startWithBun(honoApp, opts);
      logger.info(`[Server] Blade server listening on ${serverHandle.url} (Bun runtime)`);
    } else {
      serverHandle = await startWithNode(honoApp, opts);
      logger.info(`[Server] Blade server listening on ${serverHandle.url} (Node.js runtime)`);
    }

    const handle = serverHandle;

    return {
      url: handle.url,
      port: handle.port,
      hostname: handle.hostname,
      stop: async () => {
        if (serverHandle) {
          await serverHandle.stop();
          serverHandle = undefined;
          app = undefined;
          logger.info('[Server] Blade server stopped');
        }
      },
    };
  }

  export function isRunning(): boolean {
    return serverHandle !== undefined;
  }
}
