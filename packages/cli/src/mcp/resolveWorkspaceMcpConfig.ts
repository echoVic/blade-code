import path from 'node:path';
import { ConfigManager } from '../config/index.js';
import type { McpServerConfig } from '../config/types.js';
import { discoverWorkspacePlugins } from '../plugins/discoverWorkspacePlugins.js';
import { normalizeMcpOAuthConfig } from './auth/index.js';
import { resolveMcpConfigFromCli } from './loadMcpConfig.js';
import { normalizeMcpCallLifecycle } from './McpCallLifecycle.js';
import { normalizeMcpSamplingPolicy } from './McpSampling.js';

export interface WorkspaceMcpConfigOptions {
  workspaceRoot: string;
  storeServers: Readonly<Record<string, McpServerConfig>>;
  sessionServers?: Readonly<Record<string, McpServerConfig>>;
  cliConfigs?: readonly string[];
  strictCliConfig?: boolean;
  workspaceAccess?: 'full' | 'none';
  resourceRoot?: string;
}

async function resolvePluginMcpServers(
  workspaceRoot: string
): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};
  for (const plugin of await discoverWorkspacePlugins(workspaceRoot)) {
    Object.assign(servers, plugin.mcpServers ?? {});
  }
  return servers;
}

/**
 * Resolve the complete MCP set for one SessionRuntime without mutating global
 * Store or registry state. Explicit session and CLI sources have the highest
 * priority.
 */
export async function resolveWorkspaceMcpConfig(
  options: WorkspaceMcpConfigOptions
): Promise<Record<string, McpServerConfig>> {
  let servers: Record<string, McpServerConfig> = {};
  if (options.workspaceAccess === 'none') {
    servers = { ...(options.sessionServers ?? {}) };
  } else if (!options.strictCliConfig) {
    const workspaceServers = await ConfigManager.getInstance().loadWorkspaceMcpServers(
      options.workspaceRoot,
      options.storeServers
    );
    servers = {
      ...workspaceServers,
      ...(await resolvePluginMcpServers(options.workspaceRoot)),
      ...(options.sessionServers ?? {}),
    };
  }

  if (options.cliConfigs?.length) {
    servers = await resolveMcpConfigFromCli(options.cliConfigs, servers);
  }
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => {
      normalizeMcpCallLifecycle(config);
      const normalized = {
        ...config,
        ...(config.oauth ? { oauth: normalizeMcpOAuthConfig(config) } : {}),
        ...(config.sampling
          ? { sampling: normalizeMcpSamplingPolicy(config.sampling) }
          : {}),
      };
      return [
        name,
        normalized.type === 'stdio'
          ? {
              ...normalized,
              cwd:
                options.workspaceAccess === 'none'
                  ? path.resolve(options.resourceRoot ?? options.workspaceRoot)
                  : normalized.cwd
                    ? path.resolve(options.workspaceRoot, normalized.cwd)
                    : path.resolve(options.workspaceRoot),
            }
          : normalized,
      ];
    })
  );
}
