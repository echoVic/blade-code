/**
 * Blade Code Plugins System - Plugin Registry
 *
 * This module provides a singleton registry for managing loaded plugins.
 * It handles plugin discovery, loading, and provides lookup methods.
 */

import { logger } from '../logging/Logger.js';
import { PluginLoader } from './PluginLoader.js';
import type {
  LoadedPlugin,
  PluginAgent,
  PluginCommand,
  PluginDiscoveryResult,
  PluginSkill,
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
  private static instance: PluginRegistry | null = null;

  private plugins: Map<string, LoadedPlugin> = new Map();
  private loader = new PluginLoader();
  private initialized = false;
  private workspaceRoot = '';
  private cliPluginDirs: string[] = [];

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  /**
   * Reset the singleton instance (mainly for testing)
   */
  static resetInstance(): void {
    PluginRegistry.instance = null;
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
    const standardDirs = PluginLoader.getPluginDirs(workspaceRoot);

    for (const { path: dirPath, source } of standardDirs) {
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

  /**
   * Check if a plugin exists
   */
  has(name: string): boolean {
    return this.plugins.has(name);
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
   * Get all namespaced skills from all active plugins
   */
  getAllSkills(): PluginSkill[] {
    const skills: PluginSkill[] = [];

    for (const plugin of this.plugins.values()) {
      if (plugin.status === 'active') {
        skills.push(...plugin.skills);
      }
    }

    return skills;
  }

  /**
   * Get all namespaced agents from all active plugins
   */
  getAllAgents(): PluginAgent[] {
    const agents: PluginAgent[] = [];

    for (const plugin of this.plugins.values()) {
      if (plugin.status === 'active') {
        agents.push(...plugin.agents);
      }
    }

    return agents;
  }

  /**
   * Find a command by name
   *
   * Supports:
   * - Full namespaced name: "plugin:command"
   * - Short name if unique: "command"
   *
   * @param name - Command name to find
   * @returns Plugin command or undefined
   */
  findCommand(name: string): PluginCommand | undefined {
    // Try exact namespaced match first
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const cmd of plugin.commands) {
        if (cmd.namespacedName === name) {
          return cmd;
        }
      }
    }

    // Try short name match (if unique)
    const matches: PluginCommand[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const cmd of plugin.commands) {
        if (cmd.originalName === name) {
          matches.push(cmd);
        }
      }
    }

    // Only return if exactly one match
    if (matches.length === 1) {
      return matches[0];
    }

    return undefined;
  }

  /**
   * Find a skill by name
   *
   * @param name - Skill name (namespaced or short)
   * @returns Plugin skill or undefined
   */
  findSkill(name: string): PluginSkill | undefined {
    // Try exact namespaced match first
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const skill of plugin.skills) {
        if (skill.namespacedName === name) {
          return skill;
        }
      }
    }

    // Try short name match
    const matches: PluginSkill[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const skill of plugin.skills) {
        if (skill.originalName === name) {
          matches.push(skill);
        }
      }
    }

    if (matches.length === 1) {
      return matches[0];
    }

    return undefined;
  }

  /**
   * Find an agent by name
   *
   * @param name - Agent name (namespaced or short)
   * @returns Plugin agent or undefined
   */
  findAgent(name: string): PluginAgent | undefined {
    // Try exact namespaced match first
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const agent of plugin.agents) {
        if (agent.namespacedName === name) {
          return agent;
        }
      }
    }

    // Try short name match
    const matches: PluginAgent[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const agent of plugin.agents) {
        if (agent.originalName === name) {
          matches.push(agent);
        }
      }
    }

    if (matches.length === 1) {
      return matches[0];
    }

    return undefined;
  }

  /**
   * Check if a command name has multiple matches (conflict)
   *
   * @param shortName - Short command name
   * @returns True if multiple plugins provide this command
   */
  hasCommandConflict(shortName: string): boolean {
    let count = 0;

    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const cmd of plugin.commands) {
        if (cmd.originalName === shortName) {
          count++;
          if (count > 1) return true;
        }
      }
    }

    return false;
  }

  /**
   * Get all plugins that provide a command with the given short name
   *
   * @param shortName - Short command name
   * @returns Array of plugin names
   */
  getCommandProviders(shortName: string): string[] {
    const providers: string[] = [];

    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'active') continue;

      for (const cmd of plugin.commands) {
        if (cmd.originalName === shortName) {
          providers.push(plugin.manifest.name);
          break;
        }
      }
    }

    return providers;
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
   * Enable a plugin
   *
   * @param name - Plugin name
   * @returns True if the plugin was enabled
   */
  enable(name: string): boolean {
    const plugin = this.plugins.get(name);
    if (plugin && plugin.status === 'inactive') {
      plugin.status = 'active';
      logger.info(`Plugin "${name}" enabled`);
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

  /**
   * Generate a formatted list of plugins for display
   */
  formatPluginList(): string {
    const plugins = this.getAll();

    if (plugins.length === 0) {
      return '没有已加载的插件。';
    }

    const lines: string[] = [];
    const bySource = this.getBySource();

    if (bySource.cli.length > 0) {
      lines.push('## CLI 指定的插件');
      for (const p of bySource.cli) {
        const status = p.status === 'inactive' ? ' (禁用)' : '';
        lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
        lines.push(`  ${p.manifest.description}`);
      }
      lines.push('');
    }

    if (bySource.project.length > 0) {
      lines.push('## 项目级插件');
      for (const p of bySource.project) {
        const status = p.status === 'inactive' ? ' (禁用)' : '';
        lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
        lines.push(`  ${p.manifest.description}`);
      }
      lines.push('');
    }

    if (bySource.user.length > 0) {
      lines.push('## 用户级插件');
      for (const p of bySource.user) {
        const status = p.status === 'inactive' ? ' (禁用)' : '';
        lines.push(`- **${p.manifest.name}** v${p.manifest.version}${status}`);
        lines.push(`  ${p.manifest.description}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Convenience function to get the plugin registry instance
 */
export function getPluginRegistry(): PluginRegistry {
  return PluginRegistry.getInstance();
}
