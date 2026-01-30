/**
 * Blade Code Plugins System - Type Definitions
 *
 * This module defines the core types for the plugin system that allows
 * extending Blade Code with custom commands, agents, skills, hooks, and MCP servers.
 */

import type { SubagentConfig } from '../agent/subagents/types.js';
import type { McpServerConfig } from '../config/types.js';
import type { HookConfig } from '../hooks/types/HookTypes.js';
import type { SkillMetadata } from '../skills/types.js';
import type { CustomCommandConfig } from '../slash-commands/custom/types.js';

/**
 * Plugin author information
 */
export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/**
 * Plugin manifest (plugin.json)
 *
 * This is the main configuration file for a plugin, located at
 * .blade-plugin/plugin.json or .claude-plugin/plugin.json
 */
export interface PluginManifest {
  /** Unique plugin identifier (used for namespacing), kebab-case, 2-64 chars */
  name: string;

  /** Short description of the plugin */
  description: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Author information */
  author?: PluginAuthor;

  /** License identifier (e.g., "MIT", "Apache-2.0") */
  license?: string;

  /** Repository URL */
  repository?: string;

  /** Homepage URL */
  homepage?: string;

  /** Keywords for search/discovery */
  keywords?: string[];

  /** Dependencies on other plugins (name -> version range) */
  dependencies?: Record<string, string>;

  /** Minimum required Blade version */
  bladeVersion?: string;
}

/**
 * Plugin source type indicating where the plugin was loaded from
 */
export type PluginSource =
  | 'cli' // --plugin-dir argument (highest priority)
  | 'project' // .blade/plugins/ or .claude/plugins/
  | 'user'; // ~/.blade/plugins/ or ~/.claude/plugins/

/**
 * The directory type where the manifest was found
 */
export type ManifestSource = 'blade' | 'claude';

/**
 * Plugin status
 */
export type PluginStatus = 'active' | 'inactive' | 'error';

/**
 * A namespaced command from a plugin
 */
export interface PluginCommand {
  /** Original command name (e.g., "commit") */
  originalName: string;

  /** Namespaced name (e.g., "my-plugin:commit") */
  namespacedName: string;

  /** Plugin that provides this command */
  pluginName: string;

  /** Command configuration from frontmatter */
  config: CustomCommandConfig;

  /** Command content (markdown body) */
  content: string;

  /** File path to the command .md file */
  path: string;
}

/**
 * A namespaced skill from a plugin
 */
export interface PluginSkill {
  /** Original skill name */
  originalName: string;

  /** Namespaced name (e.g., "my-plugin:my-skill") */
  namespacedName: string;

  /** Plugin that provides this skill */
  pluginName: string;

  /** Skill metadata */
  metadata: SkillMetadata;

  /** Path to the skill directory */
  path: string;
}

/**
 * A namespaced agent from a plugin
 */
export interface PluginAgent {
  /** Original agent name */
  originalName: string;

  /** Namespaced name (e.g., "my-plugin:my-agent") */
  namespacedName: string;

  /** Plugin that provides this agent */
  pluginName: string;

  /** Agent configuration */
  config: SubagentConfig;

  /** Path to the agent .md file */
  path: string;
}

/**
 * A fully loaded plugin with all its resources
 */
export interface LoadedPlugin {
  /** Plugin manifest from plugin.json */
  manifest: PluginManifest;

  /** Absolute path to the plugin root directory */
  basePath: string;

  /** Where the plugin was loaded from */
  source: PluginSource;

  /** Which manifest directory was used (.blade-plugin or .claude-plugin) */
  manifestSource: ManifestSource;

  /** Loaded commands */
  commands: PluginCommand[];

  /** Loaded agents */
  agents: PluginAgent[];

  /** Loaded skills */
  skills: PluginSkill[];

  /** Hooks configuration from hooks/hooks.json */
  hooks?: HookConfig;

  /** MCP server configurations from .mcp.json */
  mcpServers?: Record<string, McpServerConfig>;

  /** Plugin status */
  status: PluginStatus;

  /** Error message if status is 'error' */
  error?: string;

  /** When the plugin was loaded */
  loadedAt: Date;
}

/**
 * Result of plugin discovery
 */
export interface PluginDiscoveryResult {
  /** Successfully loaded plugins */
  plugins: LoadedPlugin[];

  /** Errors encountered during discovery */
  errors: PluginDiscoveryError[];
}

/**
 * Error during plugin discovery
 */
export interface PluginDiscoveryError {
  /** Path to the plugin directory */
  path: string;

  /** Error message */
  error: string;

  /** Error code for programmatic handling */
  code?: PluginErrorCode;
}

/**
 * Plugin error codes
 */
type PluginErrorCode =
  | 'INVALID_MANIFEST' // plugin.json is invalid
  | 'MANIFEST_NOT_FOUND' // No plugin.json found
  | 'INVALID_COMMAND' // Command file is invalid
  | 'INVALID_SKILL' // Skill is invalid
  | 'INVALID_AGENT' // Agent config is invalid
  | 'INVALID_HOOKS' // Hooks config is invalid
  | 'INVALID_MCP' // MCP config is invalid
  | 'VERSION_INCOMPATIBLE' // Plugin requires newer Blade version
  | 'DEPENDENCY_MISSING' // Required dependency not found
  | 'IO_ERROR'; // File system error

/**
 * Options for plugin loading
 */
export interface PluginLoadOptions {
  /** Skip loading commands */
  skipCommands?: boolean;

  /** Skip loading agents */
  skipAgents?: boolean;

  /** Skip loading skills */
  skipSkills?: boolean;

  /** Skip loading hooks */
  skipHooks?: boolean;

  /** Skip loading MCP config */
  skipMcp?: boolean;
}

/**
 * Directory info for plugin scanning
 */
export interface PluginSearchDir {
  /** Absolute path to the directory */
  path: string;

  /** Source type */
  source: PluginSource;

  /** Whether this is a Blade or Claude Code directory */
  type: 'blade' | 'claude';
}
