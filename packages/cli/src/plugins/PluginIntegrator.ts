/**
 * Blade Code Plugins System - Plugin Integrator
 *
 * This module is responsible for integrating loaded plugins into
 * the existing subsystems (commands, skills, agents, hooks, MCP).
 */

import path from 'node:path';
import {
  getSubagentRegistry,
  type SubagentRegistry,
} from '../agent/subagents/SubagentRegistry.js';
import { HookManager } from '../hooks/HookManager.js';
import {
  type HookConfig,
  HookEvent,
  type HookMatcher,
} from '../hooks/types/HookTypes.js';
import { logger } from '../logging/Logger.js';
import { getSkillRegistry, type SkillRegistry } from '../skills/index.js';
import { CustomCommandRegistry } from '../slash-commands/custom/CustomCommandRegistry.js';
import { getCwd } from '../utils/cwd.js';
import { getPluginRegistry, type PluginRegistry } from './PluginRegistry.js';
import type { LoadedPlugin } from './types.js';

interface PluginHookBaseState {
  base: ReturnType<HookManager['getConfig']>;
  registry: PluginRegistry;
}

const pluginHookBaseConfigs = new Map<string, PluginHookBaseState>();
const HOOK_EVENTS = Object.values(HookEvent);

function restorePluginHookBase(
  workspaceRoot: string,
  expectedRegistry?: PluginRegistry
): boolean {
  const root = path.resolve(workspaceRoot);
  const state = pluginHookBaseConfigs.get(root);
  if (!state || (expectedRegistry && state.registry !== expectedRegistry)) {
    return false;
  }
  HookManager.getInstance().loadConfig(state.base, root);
  pluginHookBaseConfigs.delete(root);
  return true;
}

function cloneHookConfig(config: Readonly<HookConfig>): HookConfig {
  const cloned: HookConfig = { ...config };
  for (const event of HOOK_EVENTS) {
    cloned[event] = (config[event] ?? []).map((matcher) => ({
      ...matcher,
      matcher: matcher.matcher ? { ...matcher.matcher } : undefined,
      hooks: matcher.hooks.map((hook) => ({ ...hook })),
    }));
  }
  return cloned;
}

/**
 * Integration result for a single plugin
 */
interface PluginIntegrationResult {
  pluginName: string;
  commandsRegistered: number;
  skillsRegistered: number;
  agentsRegistered: number;
  hooksRegistered: boolean;
  mcpServersRegistered: number;
  lspServersRegistered: number;
  errors: string[];
}

/**
 * Overall integration result
 */
interface IntegrationResult {
  plugins: PluginIntegrationResult[];
  totalCommands: number;
  totalSkills: number;
  totalAgents: number;
  totalMcpServers: number;
  errors: string[];
}

/**
 * Plugin Integrator
 *
 * Coordinates the integration of plugin resources into the various
 * Blade Code subsystems.
 */
class PluginIntegrator {
  private commandRegistry: CustomCommandRegistry;
  private hookManager: HookManager;
  private skillRegistry: SkillRegistry;
  private subagentRegistry: SubagentRegistry;

  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string = getCwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.commandRegistry = CustomCommandRegistry.getInstance(this.workspaceRoot);
    this.hookManager = HookManager.getInstance();
    this.skillRegistry = getSkillRegistry({ cwd: this.workspaceRoot });
    this.subagentRegistry = getSubagentRegistry(this.workspaceRoot);
  }

  /**
   * Clear all plugin resources from subsystems
   *
   * Called before refresh to ensure clean re-integration
   */
  clearAllPluginResources(): void {
    // Clear plugin commands
    this.commandRegistry.clearPluginCommands();

    // Clear plugin skills
    this.skillRegistry.clearPluginSkills();

    // Clear plugin agents
    this.subagentRegistry.clearPluginAgents();

    restorePluginHookBase(this.workspaceRoot, getPluginRegistry(this.workspaceRoot));

    logger.debug('Cleared all plugin resources from subsystems');
  }

  /**
   * Integrate all loaded plugins into subsystems
   *
   * @returns Integration result
   */
  async integrateAll(): Promise<IntegrationResult> {
    const pluginRegistry = getPluginRegistry(this.workspaceRoot);
    const plugins = pluginRegistry.getActive();

    const results: PluginIntegrationResult[] = [];
    const allErrors: string[] = [];

    let totalCommands = 0;
    let totalSkills = 0;
    let totalAgents = 0;
    let totalMcpServers = 0;
    let totalLspServers = 0;

    for (const plugin of plugins) {
      const result = this.integratePlugin(plugin);
      results.push(result);

      totalCommands += result.commandsRegistered;
      totalSkills += result.skillsRegistered;
      totalAgents += result.agentsRegistered;
      totalMcpServers += result.mcpServersRegistered;
      totalLspServers += result.lspServersRegistered;
      allErrors.push(...result.errors);
    }
    this.integrateHooks(plugins, pluginRegistry);

    if (totalCommands + totalSkills + totalAgents > 0) {
      logger.info(
        `Plugin integration complete: ${totalCommands} commands, ` +
          `${totalSkills} skills, ${totalAgents} agents, ` +
          `${totalMcpServers} MCP servers, ${totalLspServers} LSP servers`
      );
    }

    return {
      plugins: results,
      totalCommands,
      totalSkills,
      totalAgents,
      totalMcpServers,
      errors: allErrors,
    };
  }

  /**
   * Integrate a single plugin
   *
   * @param plugin - The plugin to integrate
   * @returns Integration result for this plugin
   */
  integratePlugin(plugin: LoadedPlugin): PluginIntegrationResult {
    const result: PluginIntegrationResult = {
      pluginName: plugin.manifest.name,
      commandsRegistered: 0,
      skillsRegistered: 0,
      agentsRegistered: 0,
      hooksRegistered: false,
      mcpServersRegistered: 0,
      lspServersRegistered: 0,
      errors: [],
    };

    // 1. Integrate commands
    try {
      result.commandsRegistered = this.integrateCommands(plugin);
    } catch (error) {
      result.errors.push(
        `Failed to integrate commands: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // 2. Integrate skills
    try {
      result.skillsRegistered = this.integrateSkills(plugin);
    } catch (error) {
      result.errors.push(
        `Failed to integrate skills: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // 3. Integrate agents
    try {
      result.agentsRegistered = this.integrateAgents(plugin);
    } catch (error) {
      result.errors.push(
        `Failed to integrate agents: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Hooks are swapped once for the complete active plugin set in integrateAll.
    result.hooksRegistered = plugin.hooks !== undefined;

    // 5. Integrate MCP servers
    try {
      result.mcpServersRegistered = this.integrateMcp(plugin);
    } catch (error) {
      result.errors.push(
        `Failed to integrate MCP servers: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    result.lspServersRegistered = Object.keys(plugin.lspServers ?? {}).length;

    logger.debug(
      `Integrated plugin "${plugin.manifest.name}": ` +
        `${result.commandsRegistered} commands, ` +
        `${result.skillsRegistered} skills, ` +
        `${result.agentsRegistered} agents`
    );

    return result;
  }

  /**
   * Integrate commands from a plugin
   *
   * Plugin commands are registered with their namespaced names (plugin:command)
   * to prevent conflicts with other plugins or standalone commands.
   */
  private integrateCommands(plugin: LoadedPlugin): number {
    let count = 0;

    for (const cmd of plugin.commands) {
      this.commandRegistry.registerPluginCommand(cmd);
      count++;
    }

    return count;
  }

  /**
   * Integrate skills from a plugin
   */
  private integrateSkills(plugin: LoadedPlugin): number {
    let count = 0;

    for (const skill of plugin.skills) {
      this.skillRegistry.registerPluginSkill(skill);
      count++;
    }

    return count;
  }

  /**
   * Integrate agents from a plugin
   */
  private integrateAgents(plugin: LoadedPlugin): number {
    let count = 0;

    for (const agent of plugin.agents) {
      // Register with namespaced name
      this.subagentRegistry.register({
        ...agent.config,
        name: agent.namespacedName,
      });
      count++;
    }

    return count;
  }

  /**
   * Integrate hooks from a plugin
   *
   * Plugin hooks are merged into the existing hook configuration.
   */
  private integrateHooks(
    plugins: LoadedPlugin[],
    pluginRegistry: PluginRegistry
  ): void {
    const pluginsWithHooks = plugins.filter((plugin) => plugin.hooks);
    if (pluginsWithHooks.length === 0) {
      restorePluginHookBase(this.workspaceRoot, pluginRegistry);
      return;
    }
    const currentConfig = cloneHookConfig(
      this.hookManager.getConfig(this.workspaceRoot)
    );
    if (!pluginHookBaseConfigs.has(this.workspaceRoot)) {
      pluginHookBaseConfigs.set(this.workspaceRoot, {
        base: cloneHookConfig(currentConfig),
        registry: pluginRegistry,
      });
    }

    const baseConfig =
      pluginHookBaseConfigs.get(this.workspaceRoot)?.base ?? currentConfig;
    const effective = cloneHookConfig(baseConfig);
    effective.enabled = true;
    for (const event of HOOK_EVENTS) {
      const configured = baseConfig.enabled ? [...(baseConfig[event] ?? [])] : [];
      const pluginMatchers: HookMatcher[] = [];
      for (const plugin of pluginsWithHooks) {
        for (const matcher of plugin.hooks?.[event] ?? []) {
          pluginMatchers.push({
            ...matcher,
            name: matcher.name
              ? `plugin:${plugin.manifest.name}:${matcher.name}`
              : `plugin:${plugin.manifest.name}:${event}`,
            hooks: matcher.hooks.map((hook) => ({
              ...hook,
              source: {
                kind: 'plugin',
                pluginName: plugin.manifest.name,
                pluginSource: plugin.source,
                pluginRoot: plugin.basePath,
              },
            })),
          });
        }
      }
      effective[event] = [...configured, ...pluginMatchers];
    }
    this.hookManager.loadConfig(effective, this.workspaceRoot);
  }

  /**
   * Integrate MCP servers from a plugin
   */
  private integrateMcp(plugin: LoadedPlugin): number {
    // SessionRuntime resolves these definitions for its exact workspace and
    // connects them through an isolated registry.
    return Object.keys(plugin.mcpServers ?? {}).length;
  }
}

/**
 * Convenience function to integrate all plugins
 */
export async function integrateAllPlugins(
  workspaceRoot: string = getCwd()
): Promise<IntegrationResult> {
  const integrator = new PluginIntegrator(workspaceRoot);
  return integrator.integrateAll();
}

/**
 * Convenience function to clear all plugin resources
 */
export function clearAllPluginResources(workspaceRoot: string = getCwd()): void {
  const integrator = new PluginIntegrator(workspaceRoot);
  integrator.clearAllPluginResources();
}

/**
 * Release integration-only workspace state without mutating registry objects
 * that may still be owned by a Session snapshot or an in-flight caller.
 */
export function releasePluginIntegrationState(
  workspaceRoot: string = getCwd(),
  expectedRegistry?: PluginRegistry
): void {
  restorePluginHookBase(workspaceRoot, expectedRegistry);
}
