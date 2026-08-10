import { Hono } from 'hono';
import type { McpServerConfig } from '../../config/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import {
  getMcpResourceTemplateVariables,
  type McpCompletionInput,
} from '../../mcp/McpCompletion.js';
import { isMcpLogLevel } from '../../mcp/McpLogging.js';
import { McpRegistry } from '../../mcp/McpRegistry.js';
import { McpConnectionStatus } from '../../mcp/types.js';
import { configActions, getConfig } from '../../store/vanilla.js';

const logger = createLogger(LogCategory.SERVICE);

function completionVariables(uriTemplate: string): string[] {
  try {
    return getMcpResourceTemplateVariables(uriTemplate);
  } catch {
    return [];
  }
}

function parseCompletionBody(value: unknown): McpCompletionInput {
  if (!isRecord(value) || !isRecord(value.reference) || !isRecord(value.argument)) {
    throw new Error('Invalid MCP completion request');
  }
  const type = value.reference.type;
  const reference =
    type === 'prompt' && typeof value.reference.name === 'string'
      ? { type: 'prompt' as const, name: value.reference.name }
      : type === 'resource' && typeof value.reference.uri === 'string'
        ? { type: 'resource' as const, uri: value.reference.uri }
        : undefined;
  if (
    !reference ||
    typeof value.argument.name !== 'string' ||
    typeof value.argument.value !== 'string'
  ) {
    throw new Error('Invalid MCP completion request');
  }
  let context: Record<string, string> | undefined;
  if (value.context !== undefined) {
    if (!isRecord(value.context)) {
      throw new Error('Invalid MCP completion context');
    }
    context = Object.create(null) as Record<string, string>;
    for (const [name, argument] of Object.entries(value.context)) {
      if (typeof argument !== 'string') {
        throw new Error('Invalid MCP completion context');
      }
      context[name] = argument;
    }
  }
  return {
    reference,
    argument: {
      name: value.argument.name,
      value: value.argument.value,
    },
    ...(context ? { context } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function ensureConfiguredServersRegistered(
  registry: McpRegistry,
  onlyName?: string
): Promise<void> {
  const configured = getConfig()?.mcpServers ?? {};
  for (const [name, config] of Object.entries(configured)) {
    if (onlyName && name !== onlyName) continue;
    if (!registry.getServerStatus(name)) {
      await registry.registerServer(name, config, { connect: false });
    }
  }
}

export const McpRoutes = () => {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const registry = McpRegistry.getInstance();
      await ensureConfiguredServersRegistered(registry);
      const serversMap = registry.getAllServers();

      const result = await Promise.all(
        Array.from(serversMap.entries()).map(async ([name, info]) => ({
          id: name,
          name,
          status:
            info.status === McpConnectionStatus.CONNECTED
              ? 'connected'
              : info.status === McpConnectionStatus.RECONNECTING
                ? 'reconnecting'
                : info.status === McpConnectionStatus.CONNECTING
                  ? 'connecting'
                  : info.lastError
                    ? 'error'
                    : 'offline',
          endpoint: info.config.command
            ? `${info.config.command} ${(info.config.args || []).join(' ')}`.trim()
            : info.config.url || 'Unknown',
          description: `MCP server: ${name}`,
          tools: info.tools.map((t) => t.name),
          completionSupported: info.client.completionSupported,
          tasks: info.client.tasks,
          resources: info.contentCatalog.resources,
          resourceTemplates: info.contentCatalog.resourceTemplates.map((template) => ({
            ...template,
            variables: completionVariables(template.uriTemplate),
          })),
          prompts: info.contentCatalog.prompts,
          connectedAt: info.connectedAt?.toISOString(),
          error: info.lastError?.message,
          recovery: info.recovery,
          logging: info.logging,
          instructions: info.instructions,
          oauthEnabled: info.client.oauthEnabled,
          oauthStatus: await info.client.getOAuthStatus(),
        }))
      );

      return c.json(result);
    } catch (error) {
      logger.error('[McpRoutes] Failed to get MCP servers:', error);
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to get MCP servers',
        },
        500
      );
    }
  });

  app.post('/:name/connect', async (c) => {
    try {
      const name = c.req.param('name');
      const registry = McpRegistry.getInstance();
      await ensureConfiguredServersRegistered(registry, name);
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
      await ensureConfiguredServersRegistered(registry, name);
      await registry.disconnectServer(name);
      return c.json({ success: true });
    } catch (error) {
      logger.error('[McpRoutes] Failed to disconnect MCP server:', error);
      return c.json({ success: false, error: (error as Error).message }, 500);
    }
  });

  app.get('/:name/logs', async (c) => {
    try {
      const name = c.req.param('name');
      const limit = Number(c.req.query('limit') ?? 20);
      const afterRevision = Number(c.req.query('afterRevision') ?? 0);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(afterRevision) ||
        afterRevision < 0
      ) {
        return c.json({ error: 'Invalid MCP log pagination' }, 400);
      }
      const registry = McpRegistry.getInstance();
      await ensureConfiguredServersRegistered(registry, name);
      return c.json(
        registry.getLogSnapshot(name, {
          limit,
          afterRevision,
        })
      );
    } catch (error) {
      logger.error('[McpRoutes] Failed to get MCP logs:', error);
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post('/:name/logging-level', async (c) => {
    try {
      const name = c.req.param('name');
      const body = (await c.req.json()) as { level?: unknown };
      if (!isMcpLogLevel(body.level)) {
        return c.json({ success: false, error: 'Invalid MCP logging level' }, 400);
      }
      const registry = McpRegistry.getInstance();
      await ensureConfiguredServersRegistered(registry, name);
      await registry.setServerLoggingLevel(name, body.level);
      return c.json({ success: true, level: body.level });
    } catch (error) {
      logger.error('[McpRoutes] Failed to set MCP logging level:', error);
      return c.json({ success: false, error: (error as Error).message }, 400);
    }
  });

  app.post('/:name/complete', async (c) => {
    try {
      const name = c.req.param('name');
      const body = parseCompletionBody(await c.req.json());
      const registry = McpRegistry.getInstance();
      await ensureConfiguredServersRegistered(registry, name);
      const result = await registry.complete(name, body);
      return c.json(result);
    } catch (error) {
      logger.error('[McpRoutes] Failed to complete MCP argument:', error);
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post('/:name/oauth/login', async (c) => {
    try {
      const name = c.req.param('name');
      const registry = McpRegistry.getInstance();
      await ensureConfiguredServersRegistered(registry, name);
      const handle = await registry.beginOAuthLogin(name);
      return c.json(
        {
          success: true,
          flowId: handle.flowId,
          authorizationUrl: handle.authorizationUrl,
        },
        202
      );
    } catch (error) {
      logger.error('[McpRoutes] Failed to start MCP OAuth login:', error);
      return c.json({ success: false, error: (error as Error).message }, 400);
    }
  });

  app.post('/:name/oauth/logout', async (c) => {
    try {
      const name = c.req.param('name');
      const registry = McpRegistry.getInstance();
      await ensureConfiguredServersRegistered(registry, name);
      await registry.logoutOAuth(name);
      return c.json({ success: true });
    } catch (error) {
      logger.error('[McpRoutes] Failed to log out MCP OAuth:', error);
      return c.json({ success: false, error: (error as Error).message }, 400);
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
      const body = (await c.req.json()) as { name: string; config: McpServerConfig };
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
