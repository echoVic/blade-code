/**
 * 健康检查路由
 * GET /ping - ACP 协议标准端点
 */

import { Hono } from 'hono';

export function createPingRoute(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  });

  return app;
}
