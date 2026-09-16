/**
 * Blade Code Plugins System - Plugin Registry
 *
 * This module provides a singleton registry for managing loaded plugins.
 * It handles plugin discovery, loading, and provides lookup methods.
 */

import path from 'node:path';
import { ConfigManager } from '../config/ConfigManager.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { PluginSourcePolicy } from '../config/types.js';
import { logger } from '../logging/Logger.js';
import { WorkspaceTrustService } from '../security/WorkspaceTrustService.js';
import { getCwd } from '../utils/cwd.js';
import { applyPluginCompatibility } from './PluginCompatibility.js';
import { getPluginInstaller } from './PluginInstaller.js';
import { PluginLoader } from './PluginLoader.js';
import {
  assertPluginSourceAllowed,
  PluginSourcePolicyError,
} from './PluginSourcePolicy.js';
import type {
  LoadedPlugin,
  PluginCommand,
  PluginDiscoveryResult,
  PluginMarketplaceRecord,
  PluginSource,
} from './types.js';

/**
 * Plugin Registry (Singleton)
 *
 * Central registry for all loaded plugins. Handles:
 * - Plugin discovery from standard directories
 * - CLI plugin loading via --plugin-dir
 * - Plugin lookup by name
 * - Resource lookup (commands, skills, agents)
 */
export class PluginRegistry {
  private static instances = new Map<string, PluginRegistry>();

  private plugins: Map<string, LoadedPlugin> = new Map();
  private loader = new PluginLoader();
  private initialized = false;
  private workspaceRoot = '';
  private cliPluginDirs: string[] = [];
  private enabledSettings: Record<string, boolean> = {};
  private sourcePolicy: PluginSourcePolicy = {
    ...DEFAULT_CONFIG.pluginSourcePolicy,
  };
  private marketplaces: Record<string, PluginMarketplaceRecord> = {};

  private constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Get the singleton instance
   */
  static getInstance(workspaceRoot: string = getCwd()): PluginRegistry {
    const key = path.resolve(workspaceRoot);
    let registry = PluginRegistry.instances.get(key);
    if (!registry) {
      registry = new PluginRegistry(key);
      PluginRegistry.instances.set(key, registry);
    }
    return registry;
  }

  /**
   * Reset the singleton instance (mainly for testing)
   */
  static resetInstance(): void {
    PluginRegistry.instances.clear();
  }

  static releaseInstance(workspaceRoot: string, expected?: PluginRegistry): boolean {
    const key = path.resolve(workspaceRoot);
    const current = PluginRegistry.instances.get(key);
    if (!current || (expected && current !== expected)) return false;
    return PluginRegistry.instances.delete(key);
  }

  static getExistingInstance(
    workspaceRoot: string = getCwd()
  ): PluginRegistry | undefined {
    return PluginRegistry.instances.get(path.resolve(workspaceRoot));
  }

  static getInitializedInstances(): PluginRegistry[] {
    return Array.from(PluginRegistry.instances.values()).filter((registry) =>
      registry.isInitialized()
    );
  }

  /**
   * Initialize the plugin system
   *
   * Discovers and loads plugins from:
   * 1. CLI --plugin-dir arguments (highest priority)
   * 2. Standard plugin directories (project > user)
   *
   * @param workspaceRoot - The project root directory
   * @param cliPluginDirs - Plugin directories specified via CLI
   * @returns Discovery result with loaded plugins and errors
   */
  async initialize(
    workspaceRoot: string,
    cliPluginDirs: string[] = []
  ): Promise<PluginDiscoveryResult> {
    this.workspaceRoot = workspaceRoot;
    this.cliPluginDirs = cliPluginDirs;
    this.enabledSettings =
      await ConfigManager.getInstance().loadWorkspacePluginSettings(workspaceRoot);
    await this.refreshPolicyContext();

    const allPlugins: LoadedPlugin[] = [];
    const allErrors: PluginDiscoveryResult['errors'] = [];

    // 1. Load from CLI-specified directories (highest priority)
    for (const dir of cliPluginDirs) {
      try {
        const plugin = await this.loader.loadPlugin(dir, 'cli');
        this.plugins.set(plugin.manifest.name, plugin);
        allPlugins.push(plugin);
        logger.info(`Loaded CLI plugin: ${plugin.manifest.name} from ${dir}`);
      } catch (error) {
        allErrors.push({
          path: dir,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn(`Failed to load CLI plugin from ${dir}: ${error}`);
      }
    }

    // 2. Discover plugins in standard directories
    const workspaceTrusted =
      (await WorkspaceTrustService.getInstance().getStatus(workspaceRoot)).state ===
      'trusted';
    const standardDirs = PluginLoader.getPluginDirs(workspaceRoot).filter(
      (directory) => directory.source !== 'project' || workspaceTrusted
    );

    let managedPluginsLoaded = false;
    const loadManagedPlugins = async () => {
      if (managedPluginsLoaded) return;
      managedPluginsLoaded = true;
      const installer = getPluginInstaller();
      const installations = await installer.listInstallationRecords();
      for (const installation of installations) {
        try {
          await installer.verifyInstallation(installation);
          const plugin = await this.loader.loadPlugin(installation.installPath, 'user');
          if (plugin.manifest.name !== installation.name) {
            throw new Error(`Managed plugin identity mismatch: ${installation.name}`);
          }
          plugin.installation = Object.freeze({ ...installation });
          const existing = this.plugins.get(plugin.manifest.name);
          if (!existing || existing.source === 'user') {
            this.plugins.set(plugin.manifest.name, plugin);
            allPlugins.push(plugin);
          }
        } catch (error) {
          allErrors.push({
            path: installation.installPath,
            code: 'IO_ERROR',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    for (const { path: dirPath, source } of standardDirs) {
      if (source === 'project') await loadManagedPlugins();
      const result = await this.loader.discoverPluginsInDir(dirPath, source);

      for (const plugin of result.plugins) {
        // Don't override CLI plugins
        const existing = this.plugins.get(plugin.manifest.name);
        if (!existing || existing.source !== 'cli') {
          this.plugins.set(plugin.manifest.name, plugin);
          allPlugins.push(plugin);
        }
      }

      allErrors.push(...result.errors);
    }
    await loadManagedPlugins();
    this.applyEnabledSettings();
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'error') continue;
      allErrors.push({
        path: plugin.basePath,
        code: plugin.compatibilityIssues?.some(
          (issue) => issue.code === 'source-policy'
        )
          ? 'SOURCE_POLICY_BLOCKED'
          : plugin.compatibilityIssues?.some((issue) => issue.code === 'blade-version')
            ? 'VERSION_INCOMPATIBLE'
            : 'DEPENDENCY_MISSING',
        error: plugin.error ?? 'Plugin compatibility check failed',
      });
    }

    this.initialized = true;

    logger.info(
      `Plugin system initialized: ${this.plugins.size} plugins loaded` +
        (allErrors.length > 0 ? `, ${allErrors.length} errors` : '')
    );

    return {
      plugins: Array.from(this.plugins.values()),
      errors: allErrors,
    };
  }

  /**
   * Check if the registry has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  getSourcePolicy(): PluginSourcePolicy {
    return {
      ...this.sourcePolicy,
      allowedGitHosts: [...this.sourcePolicy.allowedGitHosts],
      allowedMarketplaces: [...this.sourcePolicy.allowedMarketplaces],
      allowedLocalRoots: [...this.sourcePolicy.allowedLocalRoots],
    };
  }

  /**
   * Get all loaded plugins
   */
  getAll(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get all active plugins
   */
  getActive(): LoadedPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.status === 'active');
  }

  /**
   * Get a plugin by name
   */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  async reapplyEnabledSettings(): Promise<void> {
    this.enabledSettings =
      await ConfigManager.getInstance().loadWorkspacePluginSettings(this.workspaceRoot);
    await this.refreshPolicyContext();
    this.applyEnabledSettings();
  }

  private applyEnabledSettings(): void {
    for (const plugin of this.plugins.values()) {
      plugin.compatibilityIssues = [];
      plugin.error = undefined;
      plugin.status =
        plugin.source === 'cli' || this.enabledSettings[plugin.manifest.name] !== false
          ? 'active'
          : 'inactive';
      if (plugin.status !== 'active') continue;
      try {
        assertPluginSourceAllowed(
          this.sourcePolicy,
          plugin.installation?.source ?? {
            type: 'local',
            path: plugin.basePath,
          },
          this.marketplaces,
          `Plugin "${plugin.manifest.name}"`
        );
      } catch (error) {
        if (!(error instanceof PluginSourcePolicyError)) throw error;
        plugin.status = 'error';
        plugin.error = error.message;
        plugin.compatibilityIssues = [
          {
            code: 'source-policy',
            message: error.message,
          },
        ];
      }
    }
    applyPluginCompatibility(Array.from(this.plugins.values()));
  }

  private async refreshPolicyContext(): Promise<void> {
    this.sourcePolicy =
      await ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(
        this.workspaceRoot
      );
    this.marketplaces = Object.fromEntries(
      (await getPluginInstaller().listMarketplaces()).map((marketplace) => [
        marketplace.name,
        marketplace,
      ])
    );
  }

  /**
   * Get plugins grouped by source
   */
  getBySource(): Record<PluginSource, LoadedPlugin[]> {
    const result: Record<PluginSource, LoadedPlugin[]> = {
      cli: [],
      project: [],
      user: [],
    };

    for (const plugin of this.plugins.values()) {
      result[plugin.source].push(plugin);
    }

    return result;
  }

  /**
   * Get all namespaced commands from all active plugins
   */
  getAllCommands(): PluginCommand[] {
    const commands: PluginCommand[] = [];

    for (const plugin of this.plugins.values()) {
      if (plugin.status === 'active') {
        commands.push(...plugin.commands);
      }
    }

    return commands;
  }

  /**
   * Disable a plugin
   *
   * @param name - Plugin name
   * @returns True if the plugin was disabled
   */
  disable(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (plugin && plugin.status === 'active') {
      plugin.status = 'inactive';
      logger.info(`Plugin "${name}" disabled`);
      return true;
    }
    return false;
  }

  /**
   * Refresh the plugin list
   *
   * Reloads all plugins from their directories.
   *
   * @returns Discovery result
   */
  async refresh(): Promise<PluginDiscoveryResult> {
    logger.info('Refreshing plugin list...');
    this.plugins.clear();
    this.initialized = false;
    return this.initialize(this.workspaceRoot, this.cliPluginDirs);
  }

  /**
   * Get plugin statistics
   */
  getStats(): {
    total: number;
    active: number;
    inactive: number;
    commands: number;
    skills: number;
    agents: number;
  } {
    let active = 0;
    let inactive = 0;
    let commands = 0;
    let skills = 0;
    let agents = 0;

    for (const plugin of this.plugins.values()) {
      if (plugin.status === 'active') {
        active++;
        commands += plugin.commands.length;
        skills += plugin.skills.length;
        agents += plugin.agents.length;
      } else {
        inactive++;
      }
    }

    return {
      total: this.plugins.size,
      active,
      inactive,
      commands,
      skills,
      agents,
    };
  }
}

/**
 * Convenience function to get the plugin registry instance
 */
export function getPluginRegistry(workspaceRoot: string = getCwd()): PluginRegistry {
  return PluginRegistry.getInstance(workspaceRoot);
}
