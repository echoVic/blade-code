import { Hono } from 'hono';
import type { McpServerConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import { McpConnectionStatus } from '../../mcp/types.js';
import { configActions, getConfig } from '../../store/vanilla.js';

const logger = createLogger(LogCategory.SERVICE);

export const McpRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const registry = McpRegistry.getInstance();
      const serversMap = registry.getAllServers();
      
      const result = Array.from(serversMap.entries()).map(([name, info]) => ({
        id: name,
        name,
        status: info.status === McpConnectionStatus.CONNECTED 
          ? 'connected' 
          : info.status === McpConnectionStatus.CONNECTING 
            ? 'connecting'
            : info.lastError 
              ? 'error' 
              : 'offline',
        endpoint: info.config.command 
          ? `${info.config.command} ${(info.config.args || []).join(' ')}`.trim()
          : info.config.url || 'Unknown',
        description: `MCP server: ${name}`,
        tools: info.tools.map(t => t.name),
        connectedAt: info.connectedAt?.toISOString(),
        error: info.lastError?.message,
      }));

      return c.json(result);
    } catch (error) {
      logger.error('[McpRoutes] Failed to get MCP servers:', error);
      return c.json([]);
    }
  });

  app.post('/:name/connect', async (c) => {
    try {
      const name = c.req.param('name');
      const registry = McpRegistry.getInstance();
      await registry.connectServer(name);
      return c.json({ success: true });
    } catch (error) {
      logger.error('[McpRoutes] Failed to connect MCP server:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  app.post('/:name/disconnect', async (c) => {
    try {
      const name = c.req.param('name');
      const registry = McpRegistry.getInstance();
      await registry.disconnectServer(name);
      return c.json({ success: true });
    } catch (error) {
      logger.error('[McpRoutes] Failed to disconnect MCP server:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  app.delete('/:name', async (c) => {
    try {
      const name = c.req.param('name');
      const registry = McpRegistry.getInstance();
      await registry.unregisterServer(name);
      
      const config = getConfig();
      if (config?.mcpServers) {
        const { [name]: _, ...rest } = config.mcpServers;
        await configActions().updateConfig({ mcpServers: rest });
      }
      
      return c.json({ success: true });
    } catch (error) {
      logger.error('[McpRoutes] Failed to delete MCP server:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  app.post('/', async (c) => {
    try {
      const body = await c.req.json() as { name: string; config: McpServerConfig };
      const { name, config: serverConfig } = body;
      
      if (!name || !serverConfig) {
        return c.json({ success: false, error: 'Missing name or config' }, 400);
      }

      const registry = McpRegistry.getInstance();
      await registry.registerServer(name, serverConfig);
      
      const currentConfig = getConfig();
      await configActions().updateConfig({
        mcpServers: {
          ...currentConfig?.mcpServers,
          [name]: serverConfig,
        },
      });

      return c.json({ success: true });
    } catch (error) {
      logger.error('[McpRoutes] Failed to add MCP server:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  return app;
};
