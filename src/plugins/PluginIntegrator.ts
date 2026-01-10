/**
 * Blade Code Plugins System - Plugin Integrator
 *
 * This module is responsible for integrating loaded plugins into
 * the existing subsystems (commands, skills, agents, hooks, MCP).
 */

import { subagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import { HookManager } from '../hooks/HookManager.js';
import { logger } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { getSkillRegistry } from '../skills/index.js';
import { CustomCommandRegistry } from '../slash-commands/custom/CustomCommandRegistry.js';
import { getPluginRegistry } from './PluginRegistry.js';
import type { LoadedPlugin } from './types.js';

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
  private mcpRegistry: McpRegistry;

  constructor() {
    this.commandRegistry = CustomCommandRegistry.getInstance();
    this.hookManager = HookManager.getInstance();
    this.mcpRegistry = McpRegistry.getInstance();
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
    const skillRegistry = getSkillRegistry();
    skillRegistry.clearPluginSkills();

    // Clear plugin agents
    subagentRegistry.clearPluginAgents();

    logger.debug('Cleared all plugin resources from subsystems');
  }

  /**
   * Integrate all loaded plugins into subsystems
   *
   * @returns Integration result
   */
  async integrateAll(): Promise<IntegrationResult> {
    const pluginRegistry = getPluginRegistry();
    const plugins = pluginRegistry.getActive();

    const results: PluginIntegrationResult[] = [];
    const allErrors: string[] = [];

    let totalCommands = 0;
    let totalSkills = 0;
    let totalAgents = 0;
    let totalMcpServers = 0;

    for (const plugin of plugins) {
      const result = await this.integratePlugin(plugin);
      results.push(result);

      totalCommands += result.commandsRegistered;
      totalSkills += result.skillsRegistered;
      totalAgents += result.agentsRegistered;
      totalMcpServers += result.mcpServersRegistered;
      allErrors.push(...result.errors);
    }

    if (totalCommands + totalSkills + totalAgents > 0) {
      logger.info(
        `Plugin integration complete: ${totalCommands} commands, ` +
          `${totalSkills} skills, ${totalAgents} agents, ` +
          `${totalMcpServers} MCP servers`
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
  async integratePlugin(plugin: LoadedPlugin): Promise<PluginIntegrationResult> {
    const result: PluginIntegrationResult = {
      pluginName: plugin.manifest.name,
      commandsRegistered: 0,
      skillsRegistered: 0,
      agentsRegistered: 0,
      hooksRegistered: false,
      mcpServersRegistered: 0,
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

    // 4. Integrate hooks
    try {
      result.hooksRegistered = this.integrateHooks(plugin);
    } catch (error) {
      result.errors.push(
        `Failed to integrate hooks: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // 5. Integrate MCP servers
    try {
      result.mcpServersRegistered = await this.integrateMcp(plugin);
    } catch (error) {
      result.errors.push(
        `Failed to integrate MCP servers: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

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
    const skillRegistry = getSkillRegistry();
    let count = 0;

    for (const skill of plugin.skills) {
      skillRegistry.registerPluginSkill(skill);
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
      subagentRegistry.register({
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
  private integrateHooks(plugin: LoadedPlugin): boolean {
    if (!plugin.hooks) {
      return false;
    }

    const currentConfig = this.hookManager.getConfig();

    // Deep merge the plugin hooks into current config
    // Note: This is a simplified merge - a more sophisticated approach
    // might handle array concatenation for specific hook types
    this.hookManager.loadConfig({
      ...currentConfig,
      ...plugin.hooks,
    });

    return true;
  }

  /**
   * Integrate MCP servers from a plugin
   */
  private async integrateMcp(plugin: LoadedPlugin): Promise<number> {
    if (!plugin.mcpServers) {
      return 0;
    }

    let count = 0;

    for (const [name, config] of Object.entries(plugin.mcpServers)) {
      try {
        await this.mcpRegistry.registerServer(name, config);
        count++;
      } catch (error) {
        logger.warn(
          `Failed to register MCP server "${name}" from plugin "${plugin.manifest.name}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return count;
  }
}

/**
 * Convenience function to integrate all plugins
 */
export async function integrateAllPlugins(): Promise<IntegrationResult> {
  const integrator = new PluginIntegrator();
  return integrator.integrateAll();
}

/**
 * Convenience function to clear all plugin resources
 */
export function clearAllPluginResources(): void {
  const integrator = new PluginIntegrator();
  integrator.clearAllPluginResources();
}
