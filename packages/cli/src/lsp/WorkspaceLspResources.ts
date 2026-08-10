import path from 'node:path';
import { ConfigManager } from '../config/ConfigManager.js';
import { normalizeLspServers } from '../config/lspSettings.js';
import type { LspServerConfig } from '../config/types.js';
import { discoverWorkspacePlugins } from '../plugins/discoverWorkspacePlugins.js';

export interface SessionLspResources {
  readonly projectRoot: string;
  readonly servers: Readonly<Record<string, LspServerConfig>>;
}

function cloneServers(
  servers: Readonly<Record<string, LspServerConfig>>
): Record<string, LspServerConfig> {
  return normalizeLspServers(structuredClone(servers));
}

export function snapshotWorkspaceLspResources(
  resources: SessionLspResources
): SessionLspResources {
  return Object.freeze({
    projectRoot: path.resolve(resources.projectRoot),
    servers: Object.freeze(cloneServers(resources.servers)),
  });
}

export async function resolveWorkspaceLspResources(
  projectRoot: string,
  base: Readonly<Record<string, LspServerConfig>>
): Promise<SessionLspResources> {
  const root = path.resolve(projectRoot);
  const servers = await ConfigManager.getInstance().loadWorkspaceLspServers(root, base);
  for (const plugin of await discoverWorkspacePlugins(root)) {
    Object.assign(servers, plugin.lspServers ?? {});
  }
  return snapshotWorkspaceLspResources({
    projectRoot: root,
    servers,
  });
}
