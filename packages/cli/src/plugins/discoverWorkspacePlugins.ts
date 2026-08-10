import path from 'node:path';
import { ConfigManager } from '../config/index.js';
import { WorkspaceTrustService } from '../security/WorkspaceTrustService.js';
import { PluginLoader } from './PluginLoader.js';
import { getPluginRegistry } from './PluginRegistry.js';
import type { LoadedPlugin } from './types.js';

export async function discoverWorkspacePlugins(
  workspaceRoot: string
): Promise<LoadedPlugin[]> {
  const registry = getPluginRegistry(workspaceRoot);
  const sameWorkspace =
    registry.isInitialized() &&
    path.resolve(registry.getWorkspaceRoot()) === path.resolve(workspaceRoot);
  if (sameWorkspace) return registry.getActive();

  const plugins = new Map<string, LoadedPlugin>();
  for (const plugin of registry.getActive()) {
    if (plugin.source === 'cli') plugins.set(plugin.manifest.name, plugin);
  }

  const workspaceTrusted =
    (await WorkspaceTrustService.getInstance().getStatus(workspaceRoot)).state ===
    'trusted';
  const enabledPlugins =
    await ConfigManager.getInstance().loadWorkspacePluginSettings(workspaceRoot);
  const loader = new PluginLoader();
  for (const directory of PluginLoader.getPluginDirs(workspaceRoot)) {
    if (directory.source === 'project' && !workspaceTrusted) continue;
    const result = await loader.discoverPluginsInDir(directory.path, directory.source);
    for (const plugin of result.plugins) {
      const existing = plugins.get(plugin.manifest.name);
      if (!existing || existing.source !== 'cli') {
        plugin.status =
          enabledPlugins[plugin.manifest.name] === false ? 'inactive' : 'active';
        plugins.set(plugin.manifest.name, plugin);
      }
    }
  }
  return [...plugins.values()].filter((plugin) => plugin.status === 'active');
}
