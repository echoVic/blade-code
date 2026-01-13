/**
 * 配置管理路由（普通 HTTP API）
 *
 * GET /api/config - 获取当前配置
 * PATCH /api/config - 更新配置
 */

import { Hono } from 'hono';
import { getConfig } from '../../../store/vanilla.js';
import type { ConfigInfo, UpdateConfigRequest } from '../types.js';

export function createConfigRoutes(): Hono {
  const app = new Hono();

  // GET /api/config - 获取当前配置
  app.get('/', (c) => {
    const cwd = c.get('cwd');
    const config = getConfig();

    const configInfo: ConfigInfo = {
      project_path: cwd,
      current_model_id: config?.currentModelId,
      permission_mode: 'default', // TODO: 从 store 获取权限模式
      models: (config?.models || []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        provider: m.provider,
      })),
    };

    return c.json(configInfo);
  });

  // PATCH /api/config - 更新配置
  app.patch('/', async (c) => {
    try {
      const body = await c.req.json<UpdateConfigRequest>();

      // TODO: 实现配置更新逻辑
      // 目前只返回成功，实际更新需要调用 ConfigManager

      return c.json({
        success: true,
        message: 'Config update not implemented yet',
        requested: body,
      });
    } catch (error) {
      return c.json(
        {
          code: 'server_error',
          message: error instanceof Error ? error.message : 'Failed to update config',
        },
        500
      );
    }
  });

  return app;
}
