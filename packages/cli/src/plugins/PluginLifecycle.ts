import path from 'node:path';
import { Mutex } from 'async-mutex';
import {
  refreshWorkspaceCommunicationStyles,
  resolveWorkspaceAgentResources,
} from '../agent/resources/WorkspaceAgentResources.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { getConfigService } from '../config/ConfigService.js';
import {
  normalizePluginSourcePolicy,
  type PersistedPluginSettingsScope,
} from '../config/pluginSettings.js';
import type { PluginSourcePolicy } from '../config/types.js';
import { WorkspaceTrustService } from '../security/WorkspaceTrustService.js';
import {
  getPluginInstaller,
  type PluginInstallOptions,
  type PluginInstallResult,
  type PluginMarketplaceResult,
  type PluginUninstallResult,
} from './PluginInstaller.js';
import { clearAllPluginResources, integrateAllPlugins } from './PluginIntegrator.js';
import { PluginRegistry } from './PluginRegistry.js';
import type { PluginDiscoveryResult, PluginSource, PluginStatus } from './types.js';

export type PluginSettingsScope = PersistedPluginSettingsScope;

export interface PluginStateChange {
  name: string;
  requestedEnabled: boolean;
  effectiveEnabled: boolean;
  scope: PluginSettingsScope;
  source: PluginSource;
  status: PluginStatus;
  effectiveScope: 'default' | PersistedPluginSettingsScope | 'invocation';
}

const lifecycleMutex = new Mutex();

async function reconcileRegistry(registry: PluginRegistry): Promise<void> {
  await registry.reapplyEnabledSettings();
  clearAllPluginResources(registry.getWorkspaceRoot());
  await integrateAllPlugins(registry.getWorkspaceRoot());
  await refreshWorkspaceCommunicationStyles(
    await resolveWorkspaceAgentResources(registry.getWorkspaceRoot())
  );
}

async function refreshRegistry(
  registry: PluginRegistry
): Promise<PluginDiscoveryResult> {
  clearAllPluginResources(registry.getWorkspaceRoot());
  const discovery = await registry.refresh();
  await integrateAllPlugins(registry.getWorkspaceRoot());
  await refreshWorkspaceCommunicationStyles(
    await resolveWorkspaceAgentResources(registry.getWorkspaceRoot())
  );
  return discovery;
}

async function refreshGlobalPluginRegistries(
  workspaceRoot: string
): Promise<PluginDiscoveryResult> {
  const resources = await resolveWorkspaceAgentResources(workspaceRoot);
  const registries = Array.from(
    new Set([resources.plugins, ...PluginRegistry.getInitializedInstances()])
  );
  let requestedDiscovery: PluginDiscoveryResult | undefined;
  for (const registry of registries) {
    const discovery = await refreshRegistry(registry);
    if (registry === resources.plugins) requestedDiscovery = discovery;
  }
  return requestedDiscovery ?? { plugins: [], errors: [] };
}

async function removePluginSettingsUnlocked(
  workspaceRoot: string,
  name: string
): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const configService = getConfigService();
  await Promise.all([
    configService.removePluginSetting(name, {
      scope: 'global',
      immediate: true,
    }),
    configService.removePluginSetting(name, {
      scope: 'project',
      projectDir: root,
      immediate: true,
    }),
    configService.removePluginSetting(name, {
      scope: 'local',
      projectDir: root,
      immediate: true,
    }),
  ]);
}

function isLocalSource(source: string): boolean {
  return (
    path.isAbsolute(source) ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source === '~' ||
    source.startsWith('~/')
  );
}

async function requireTrustedLocalSource(
  workspaceRoot: string,
  source: string
): Promise<void> {
  if (
    isLocalSource(source) &&
    !(await WorkspaceTrustService.getInstance().getStatus(workspaceRoot)).trusted
  ) {
    throw new Error('Local plugin sources require a trusted workspace');
  }
}

export async function setWorkspacePluginEnabled(
  workspaceRoot: string,
  name: string,
  enabled: boolean,
  scope: PluginSettingsScope = 'local'
): Promise<PluginStateChange> {
  return lifecycleMutex.runExclusive(async () => {
    const root = path.resolve(workspaceRoot);
    const resources = await resolveWorkspaceAgentResources(root);
    const plugin = resources.plugins.get(name);
    if (!plugin) throw new Error(`Plugin not found: ${name}`);
    if (plugin.source === 'cli') {
      throw new Error(
        `Plugin "${name}" was loaded with --plugin-dir and is invocation-scoped`
      );
    }

    await getConfigService().save(
      { enabledPlugins: { [name]: enabled } },
      { scope, projectDir: root, immediate: true }
    );

    const registries =
      scope === 'global'
        ? Array.from(
            new Set([resources.plugins, ...PluginRegistry.getInitializedInstances()])
          )
        : [resources.plugins];
    for (const registry of registries) {
      await reconcileRegistry(registry);
    }

    const updated = resources.plugins.get(name);
    if (!updated) throw new Error(`Plugin disappeared during reconciliation: ${name}`);
    const resolution =
      await ConfigManager.getInstance().loadWorkspacePluginSettingsResolution(root);
    return {
      name,
      requestedEnabled: enabled,
      effectiveEnabled: updated.status === 'active',
      scope,
      source: updated.source,
      status: updated.status,
      effectiveScope: resolution.settings[name]?.effectiveScope ?? 'default',
    };
  });
}

export async function refreshWorkspacePlugins(workspaceRoot: string): Promise<{
  registry: PluginRegistry;
  discovery: PluginDiscoveryResult;
}> {
  return lifecycleMutex.runExclusive(async () => {
    const resources = await resolveWorkspaceAgentResources(workspaceRoot);
    clearAllPluginResources(resources.workspaceRoot);
    const discovery = await resources.plugins.refresh();
    await integrateAllPlugins(resources.workspaceRoot);
    return { registry: resources.plugins, discovery };
  });
}

export async function setWorkspacePluginSourcePolicy(
  workspaceRoot: string,
  policy: PluginSourcePolicy,
  scope: PluginSettingsScope = 'global'
): Promise<PluginSourcePolicy> {
  return lifecycleMutex.runExclusive(async () => {
    const root = path.resolve(workspaceRoot);
    const normalized = {
      ...policy,
      ...normalizePluginSourcePolicy(policy as unknown as Record<string, unknown>),
    };
    await getConfigService().save(
      { pluginSourcePolicy: normalized },
      { scope, projectDir: root, immediate: true }
    );
    const resources = await resolveWorkspaceAgentResources(root);
    const registries =
      scope === 'global'
        ? Array.from(
            new Set([resources.plugins, ...PluginRegistry.getInitializedInstances()])
          )
        : [resources.plugins];
    for (const registry of registries) await reconcileRegistry(registry);
    return ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(root);
  });
}

export async function installWorkspacePlugin(
  workspaceRoot: string,
  source: string,
  options: PluginInstallOptions = {}
): Promise<{
  result: PluginInstallResult;
  discovery?: PluginDiscoveryResult;
}> {
  return lifecycleMutex.runExclusive(async () => {
    const root = path.resolve(workspaceRoot);
    await requireTrustedLocalSource(root, source);
    const policy =
      await ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(root);
    const result = await getPluginInstaller().install(source, {
      ...options,
      workspaceRoot: root,
      policy,
    });
    if (!result.success) return { result };
    const discovery = await refreshGlobalPluginRegistries(root);
    return { result, discovery };
  });
}

export async function updateWorkspacePlugin(
  workspaceRoot: string,
  name: string,
  options: PluginInstallOptions = {}
): Promise<{
  result: PluginInstallResult;
  discovery?: PluginDiscoveryResult;
}> {
  return lifecycleMutex.runExclusive(async () => {
    const root = path.resolve(workspaceRoot);
    const policy =
      await ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(root);
    const result = await getPluginInstaller().update(name, {
      ...options,
      workspaceRoot: root,
      policy,
    });
    if (!result.success) return { result };
    const discovery = await refreshGlobalPluginRegistries(root);
    return { result, discovery };
  });
}

export async function uninstallWorkspacePlugin(
  workspaceRoot: string,
  name: string,
  confirmed = false
): Promise<{
  result: PluginUninstallResult;
  discovery?: PluginDiscoveryResult;
}> {
  return lifecycleMutex.runExclusive(async () => {
    const root = path.resolve(workspaceRoot);
    const resources = await resolveWorkspaceAgentResources(root);
    const dependents = resources.plugins
      .getAll()
      .filter(
        (plugin) =>
          plugin.manifest.name !== name &&
          plugin.manifest.dependencies?.[name] !== undefined
      )
      .map((plugin) => plugin.manifest.name)
      .sort();
    if (dependents.length > 0) {
      return {
        result: {
          success: false,
          pluginName: name,
          code: 'PLUGIN_REQUIRED',
          error: `Plugin "${name}" is required by: ${dependents.join(', ')}`,
        },
      };
    }
    const result = await getPluginInstaller().uninstall(name, confirmed);
    if (!result.success) return { result };
    await removePluginSettingsUnlocked(root, name);
    const discovery = await refreshGlobalPluginRegistries(root);
    return { result, discovery };
  });
}

export async function addPluginMarketplace(
  workspaceRoot: string,
  source: string,
  ref?: string
): Promise<PluginMarketplaceResult> {
  return lifecycleMutex.runExclusive(async () => {
    const root = path.resolve(workspaceRoot);
    await requireTrustedLocalSource(root, source);
    const policy =
      await ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(root);
    return getPluginInstaller().addMarketplace(source, {
      workspaceRoot: root,
      ref,
      policy,
    });
  });
}

export async function refreshPluginMarketplace(
  workspaceRoot: string,
  name: string
): Promise<PluginMarketplaceResult> {
  return lifecycleMutex.runExclusive(async () => {
    const root = path.resolve(workspaceRoot);
    const policy =
      await ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(root);
    return getPluginInstaller().refreshMarketplace(name, policy);
  });
}

export async function removePluginMarketplace(
  name: string,
  confirmed = false
): Promise<PluginMarketplaceResult> {
  return lifecycleMutex.runExclusive(() =>
    getPluginInstaller().removeMarketplace(name, confirmed)
  );
}

export async function removeWorkspacePluginSettings(
  workspaceRoot: string,
  name: string
): Promise<void> {
  await lifecycleMutex.runExclusive(async () => {
    await removePluginSettingsUnlocked(workspaceRoot, name);
  });
}
