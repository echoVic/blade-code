/**
 * Blade Web 服务器
 *
 * 使用 Hono 框架实现 ACP 协议 + 普通 HTTP API
 * - ACP 端点：/ping, /agents, /runs 等
 * - 管理 API：/api/sessions, /api/config 等
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { createAgentRoutes } from './routes/agents.js';
import { createConfigRoutes } from './routes/config.js';
import { createPingRoute } from './routes/ping.js';
import { createRunRoutes } from './routes/runs.js';
import { createSessionRoutes } from './routes/sessions.js';

const logger = createLogger(LogCategory.SERVICE);

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface WebServerOptions {
  port?: number;
  host?: string;
  cwd?: string;
  open?: boolean;
}

export interface WebServerInstance {
  url: string;
  close: () => void;
}

/**
 * 创建并启动 Web 服务器
 */
export async function createWebServer(
  options: WebServerOptions = {}
): Promise<WebServerInstance> {
  const { port = 8000, host = 'localhost', cwd = process.cwd() } = options;

  const app = new Hono();

  // 中间件
  app.use('*', honoLogger());
  app.use(
    '*',
    cors({
      origin: (origin) => {
        // 允许无 origin 的请求（如 curl）
        if (!origin) return '*';
        // 允许 localhost 和 127.0.0.1 的任意端口
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
          return origin;
        }
        // 允许无端口的 localhost
        if (origin === 'http://localhost' || origin === 'http://127.0.0.1') {
          return origin;
        }
        return null;
      },
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    })
  );

  // 存储工作目录到上下文
  app.use('*', async (c, next) => {
    c.set('cwd', cwd);
    await next();
  });

  // ==================== ACP 协议端点 ====================

  // 健康检查
  app.route('/ping', createPingRoute());

  // Agent 发现
  app.route('/agents', createAgentRoutes());

  // 运行管理
  app.route('/runs', createRunRoutes());

  // ==================== 普通 HTTP API 端点 ====================

  // 会话管理
  app.route('/api/sessions', createSessionRoutes());

  // 配置管理
  app.route('/api/config', createConfigRoutes());

  // ==================== 静态文件服务（前端）====================

  // 前端静态文件目录
  // __dirname 在 Bun 构建后是 dist/ 目录（打平输出）
  // 所以项目根是 __dirname 的父目录
  const projectRoot = join(__dirname, '..'); // dist -> 项目根
  const webDistPath = join(projectRoot, 'web/dist');

  logger.debug(`[WebServer] __dirname: ${__dirname}`);
  logger.debug(`[WebServer] projectRoot: ${projectRoot}`);
  logger.debug(`[WebServer] webDistPath: ${webDistPath}`);

  // 静态资源文件（JS、CSS 等）
  app.get('/assets/*', async (c) => {
    const path = c.req.path;
    try {
      const filePath = join(webDistPath, path);
      const content = await readFile(filePath);
      const ext = path.split('.').pop() || '';
      const mimeTypes: Record<string, string> = {
        js: 'application/javascript',
        css: 'text/css',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        woff: 'font/woff',
        woff2: 'font/woff2',
      };
      return c.body(content, 200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      });
    } catch (err) {
      logger.error(`[WebServer] Failed to serve asset: ${path}`, err);
      return c.notFound();
    }
  });

  // 根路径和所有非 API 路径返回 index.html（SPA 路由支持）
  app.get('/', async (c) => {
    try {
      const indexPath = join(webDistPath, 'index.html');
      logger.debug(`[WebServer] Serving index.html from: ${indexPath}`);
      const html = await readFile(indexPath, 'utf-8');
      return c.html(html);
    } catch (err) {
      logger.error(`[WebServer] Failed to serve index.html:`, err);
      // 如果前端未构建，显示提示页面
      return c.html(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Blade Web</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
              }
              .container {
                text-align: center;
                padding: 2rem;
              }
              h1 { font-size: 3rem; margin-bottom: 0.5rem; }
              p { font-size: 1.2rem; opacity: 0.9; }
              code {
                background: rgba(255,255,255,0.2);
                padding: 0.2rem 0.5rem;
                border-radius: 4px;
              }
              .warning {
                margin-top: 2rem;
                background: rgba(255,200,0,0.3);
                padding: 1rem;
                border-radius: 8px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>⚔️ Blade Web</h1>
              <p>AI-powered coding assistant</p>
              <div class="warning">
                <p><strong>⚠️ 前端未构建</strong></p>
                <p>请运行以下命令构建前端：</p>
                <p><code>cd web && pnpm install && pnpm run build</code></p>
              </div>
            </div>
          </body>
        </html>
      `);
    }
  });

  // 启动服务器
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  const url = `http://${host}:${port}`;
  logger.info(`[WebServer] Blade Web 服务器启动: ${url}`);
  logger.info(`[WebServer] 工作目录: ${cwd}`);

  return {
    url,
    close: () => {
      server.close();
      logger.info('[WebServer] 服务器已关闭');
    },
  };
}

// 类型声明，用于 Hono 上下文
declare module 'hono' {
  interface ContextVariableMap {
    cwd: string;
  }
}
