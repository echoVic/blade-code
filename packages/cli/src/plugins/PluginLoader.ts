/**
 * Blade Code Plugins System - Plugin Loader
 *
 * This module is responsible for loading plugins from directories,
 * including their commands, agents, skills, hooks, and MCP configurations.
 */

import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { SubagentConfig } from '../agent/subagents/types.js';
import type { McpServerConfig } from '../config/types.js';
import type { HookConfig } from '../hooks/types/HookTypes.js';
import { logger } from '../logging/Logger.js';
import { loadSkillMetadata } from '../skills/SkillLoader.js';
import type { CustomCommandConfig } from '../slash-commands/custom/types.js';
import { getMcpNamespacedName, getNamespacedName } from './namespacing.js';
import { parsePluginManifest } from './PluginManifest.js';
import { validateMcpConfig } from './schemas.js';
import type {
  LoadedPlugin,
  PluginAgent,
  PluginCommand,
  PluginDiscoveryResult,
  PluginLoadOptions,
  PluginSearchDir,
  PluginSkill,
  PluginSource,
} from './types.js';

/**
 * Plugin Loader
 *
 * Handles loading plugins from directories, parsing their contents,
 * and assembling them into LoadedPlugin objects.
 */
export class PluginLoader {
  /**
   * Load a single plugin from a directory
   *
   * @param pluginDir - Absolute path to the plugin directory
   * @param source - Where the plugin is being loaded from
   * @param options - Loading options
   * @returns Loaded plugin object
   * @throws Error if the plugin is invalid
   */
  async loadPlugin(
    pluginDir: string,
    source: PluginSource,
    options: PluginLoadOptions = {}
  ): Promise<LoadedPlugin> {
    // 1. Parse manifest
    const manifestResult = await parsePluginManifest(pluginDir);
    if (!manifestResult) {
      throw new Error(`Not a valid plugin directory: ${pluginDir}`);
    }

    const { manifest, source: manifestSource } = manifestResult;
    const pluginName = manifest.name;

    logger.debug(`Loading plugin "${pluginName}" from ${pluginDir}`);

    // 2. Load commands
    const commands = options.skipCommands
      ? []
      : await this.loadCommands(pluginDir, pluginName);

    // 3. Load agents
    const agents = options.skipAgents
      ? []
      : await this.loadAgents(pluginDir, pluginName);

    // 4. Load skills
    const skills = options.skipSkills
      ? []
      : await this.loadSkills(pluginDir, pluginName);

    // 5. Load hooks
    const hooks = options.skipHooks ? undefined : await this.loadHooks(pluginDir);

    // 6. Load MCP config
    const mcpServers = options.skipMcp
      ? undefined
      : await this.loadMcpConfig(pluginDir, pluginName);

    logger.debug(
      `Plugin "${pluginName}" loaded: ${commands.length} commands, ` +
        `${agents.length} agents, ${skills.length} skills`
    );

    return {
      manifest,
      basePath: pluginDir,
      source,
      manifestSource,
      commands,
      agents,
      skills,
      hooks,
      mcpServers,
      status: 'active',
      loadedAt: new Date(),
    };
  }

  /**
   * Load commands from the commands/ directory
   */
  private async loadCommands(
    pluginDir: string,
    pluginName: string
  ): Promise<PluginCommand[]> {
    const commandsDir = path.join(pluginDir, 'commands');
    const commands: PluginCommand[] = [];

    if (!(await this.dirExists(commandsDir))) {
      return commands;
    }

    const files = await this.scanMarkdownFiles(commandsDir);

    for (const file of files) {
      try {
        const cmd = await this.parseCommandFile(file, commandsDir, pluginName);
        if (cmd) {
          commands.push(cmd);
        }
      } catch (error) {
        logger.warn(
          `Failed to load command from ${file}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return commands;
  }

  /**
   * Parse a command file
   */
  private async parseCommandFile(
    filePath: string,
    basePath: string,
    pluginName: string
  ): Promise<PluginCommand | null> {
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const { data, content: body } = matter(fileContent);

    // Extract command name from file path
    const relativePath = path.relative(basePath, filePath);
    const parts = relativePath.split(path.sep);
    const fileName = parts.pop();
    if (!fileName) return null;

    const originalName = fileName.replace(/\.md$/i, '');

    // Build namespaced name
    // If there are subdirectories, include them in the command name
    let commandName = originalName;
    if (parts.length > 0) {
      commandName = [...parts, originalName].join('/');
    }

    const namespacedName = getNamespacedName(pluginName, commandName);

    // Normalize frontmatter config
    const config = this.normalizeCommandConfig(data);

    return {
      originalName: commandName,
      namespacedName,
      pluginName,
      config,
      content: body.trim(),
      path: filePath,
    };
  }

  /**
   * Normalize command frontmatter to CustomCommandConfig
   */
  private normalizeCommandConfig(data: Record<string, unknown>): CustomCommandConfig {
    return {
      description: this.asString(data.description),
      allowedTools: this.parseStringArray(data['allowed-tools']),
      argumentHint: this.asString(data['argument-hint']),
      model: this.asString(data.model),
      disableModelInvocation: data['disable-model-invocation'] === true,
    };
  }

  /**
   * Load agents from the agents/ directory
   */
  private async loadAgents(
    pluginDir: string,
    pluginName: string
  ): Promise<PluginAgent[]> {
    const agentsDir = path.join(pluginDir, 'agents');
    const agents: PluginAgent[] = [];

    if (!(await this.dirExists(agentsDir))) {
      return agents;
    }

    const files = await this.scanMarkdownFiles(agentsDir);

    for (const file of files) {
      try {
        const agent = await this.parseAgentFile(file, agentsDir, pluginName);
        if (agent) {
          agents.push(agent);
        }
      } catch (error) {
        logger.warn(
          `Failed to load agent from ${file}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return agents;
  }

  /**
   * Parse an agent file
   */
  private async parseAgentFile(
    filePath: string,
    basePath: string,
    pluginName: string
  ): Promise<PluginAgent | null> {
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const { data, content: body } = matter(fileContent);

    // Extract agent name from file path
    const relativePath = path.relative(basePath, filePath);
    const fileName = path.basename(relativePath, '.md');
    const originalName = data.name || fileName;

    const namespacedName = getNamespacedName(pluginName, originalName);

    // Build agent config
    const config: SubagentConfig = {
      name: namespacedName,
      description: this.asString(data.description) || '',
      tools: this.parseStringArray(data.tools),
      color: this.asString(data.color) as SubagentConfig['color'],
      model: this.asString(data.model),
      permissionMode: this.asString(
        data.permissionMode
      ) as SubagentConfig['permissionMode'],
      skills: this.parseStringArray(data.skills),
      systemPrompt: body.trim(),
      source: `plugin:${pluginName}`,
    };

    return {
      originalName,
      namespacedName,
      pluginName,
      config,
      path: filePath,
    };
  }

  /**
   * Load skills from the skills/ directory
   */
  private async loadSkills(
    pluginDir: string,
    pluginName: string
  ): Promise<PluginSkill[]> {
    const skillsDir = path.join(pluginDir, 'skills');
    const skills: PluginSkill[] = [];

    if (!(await this.dirExists(skillsDir))) {
      return skills;
    }

    const entries = await fs.readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(skillsDir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');

      try {
        const result = await loadSkillMetadata(skillFile, 'project');

        if (result.success && result.content) {
          const originalName = result.content.metadata.name;
          const namespacedName = getNamespacedName(pluginName, originalName);

          skills.push({
            originalName,
            namespacedName,
            pluginName,
            metadata: {
              ...result.content.metadata,
              name: namespacedName, // Override with namespaced name
            },
            path: skillDir,
          });
        }
      } catch (error) {
        logger.warn(
          `Failed to load skill from ${skillFile}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return skills;
  }

  /**
   * Load hooks configuration from hooks/hooks.json
   */
  private async loadHooks(pluginDir: string): Promise<HookConfig | undefined> {
    const hooksPath = path.join(pluginDir, 'hooks', 'hooks.json');

    try {
      const content = await fs.readFile(hooksPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Extract hooks object if wrapped
      const hooksConfig = parsed.hooks || parsed;

      return hooksConfig as HookConfig;
    } catch {
      return undefined;
    }
  }

  /**
   * Load MCP configuration from .mcp.json
   */
  private async loadMcpConfig(
    pluginDir: string,
    pluginName: string
  ): Promise<Record<string, McpServerConfig> | undefined> {
    const mcpPath = path.join(pluginDir, '.mcp.json');

    try {
      const content = await fs.readFile(mcpPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Validate
      const result = validateMcpConfig(parsed);
      if (!result.success) {
        logger.warn(`Invalid .mcp.json in ${pluginDir}: ${result.error}`);
        return undefined;
      }

      // Extract servers (support both formats)
      const servers = 'mcpServers' in parsed ? parsed.mcpServers : parsed;

      // Apply namespace to server names
      const namespacedServers: Record<string, McpServerConfig> = {};
      for (const [name, config] of Object.entries(servers)) {
        const namespacedName = getMcpNamespacedName(pluginName, name);
        namespacedServers[namespacedName] = config as McpServerConfig;
      }

      return namespacedServers;
    } catch {
      return undefined;
    }
  }

  /**
   * Recursively scan for .md files in a directory
   */
  private async scanMarkdownFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    const scan = async (currentDir: string) => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    };

    await scan(dir);
    return files;
  }

  /**
   * Check if a directory exists
   */
  private async dirExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Safely convert value to string
   */
  private asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return undefined;
  }

  /**
   * Parse a string array from various formats
   */
  private parseStringArray(value: unknown): string[] | undefined {
    if (!value) return undefined;

    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return undefined;
  }

  /**
   * Get the standard plugin search directories
   *
   * Returns directories in priority order (lowest to highest):
   * 1. User-level Claude Code: ~/.claude/plugins/
   * 2. User-level Blade: ~/.blade/plugins/
   * 3. Project-level Claude Code: .claude/plugins/
   * 4. Project-level Blade: .blade/plugins/
   *
   * @param workspaceRoot - The project root directory
   * @returns Array of plugin search directories
   */
  static getPluginDirs(workspaceRoot: string): PluginSearchDir[] {
    const home = homedir();

    return [
      // User-level (lower priority)
      {
        path: path.join(home, '.claude', 'plugins'),
        source: 'user' as PluginSource,
        type: 'claude' as const,
      },
      {
        path: path.join(home, '.blade', 'plugins'),
        source: 'user' as PluginSource,
        type: 'blade' as const,
      },
      // Project-level (higher priority)
      {
        path: path.join(workspaceRoot, '.claude', 'plugins'),
        source: 'project' as PluginSource,
        type: 'claude' as const,
      },
      {
        path: path.join(workspaceRoot, '.blade', 'plugins'),
        source: 'project' as PluginSource,
        type: 'blade' as const,
      },
    ];
  }

  /**
   * Discover plugins in a directory
   *
   * @param dirPath - Directory to search for plugins
   * @param source - Plugin source type
   * @returns Discovery result with plugins and errors
   */
  async discoverPluginsInDir(
    dirPath: string,
    source: PluginSource
  ): Promise<PluginDiscoveryResult> {
    const plugins: LoadedPlugin[] = [];
    const errors: PluginDiscoveryResult['errors'] = [];

    try {
      await fs.access(dirPath);
    } catch {
      // Directory doesn't exist
      return { plugins, errors };
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = path.join(dirPath, entry.name);

      try {
        const plugin = await this.loadPlugin(pluginPath, source);
        plugins.push(plugin);
      } catch (error) {
        errors.push({
          path: pluginPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { plugins, errors };
  }
}
