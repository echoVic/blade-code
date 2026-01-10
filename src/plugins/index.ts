/**
 * Blade Code Plugins System
 *
 * This module provides a plugin system for extending Blade Code with
 * custom commands, agents, skills, hooks, and MCP servers.
 *
 * ## Overview
 *
 * Plugins are directories containing:
 * - `.blade-plugin/plugin.json` or `.claude-plugin/plugin.json` - Plugin manifest
 * - `commands/` - Slash commands (.md files)
 * - `agents/` - Custom agents (.md files)
 * - `skills/` - Skills (directories with SKILL.md)
 * - `hooks/hooks.json` - Hooks configuration
 * - `.mcp.json` - MCP server configurations
 *
 * ## Usage
 *
 * ```typescript
 * import { PluginRegistry, getPluginRegistry } from '../plugins/index.js';
 *
 * // Initialize the plugin system
 * const registry = getPluginRegistry();
 * await registry.initialize('/path/to/workspace', ['--plugin-dir', '/custom/plugin']);
 *
 * // Find a plugin command
 * const cmd = registry.findCommand('my-plugin:commit');
 *
 * // Get all plugins
 * const plugins = registry.getAll();
 * ```
 *
 * ## Namespacing
 *
 * Plugin resources are namespaced to prevent conflicts:
 * - Commands: `/plugin-name:command`
 * - Skills: `plugin-name:skill-name`
 * - Agents: `plugin-name:agent-name`
 * - MCP Servers: `plugin-name__server-name`
 *
 * @module plugins
 */

// Namespacing utilities
export {
  extractPluginName,
  extractResourceName,
  formatSlashCommand,
  getMcpNamespacedName,
  getNamespacedName,
  hasMcpNamespace,
  hasNamespace,
  isValidPluginName,
  MCP_NAMESPACE_SEPARATOR,
  NAMESPACE_SEPARATOR,
  parseMcpNamespacedName,
  parseNamespacedName,
  toPluginName,
} from './namespacing.js';
export type {
  InstallResult,
  UninstallResult,
} from './PluginInstaller.js';
// Plugin Installer
export {
  getPluginInstaller,
  PluginInstaller,
  resetPluginInstaller,
} from './PluginInstaller.js';
export type {
  IntegrationResult,
  PluginIntegrationResult,
} from './PluginIntegrator.js';
// Plugin Integrator
export {
  clearAllPluginResources,
  integrateAllPlugins,
  PluginIntegrator,
} from './PluginIntegrator.js';
// Plugin Loader
export { PluginLoader } from './PluginLoader.js';
// Manifest utilities
export {
  createPluginManifest,
  generateDefaultManifest,
  getManifestDir,
  isValidPluginDir,
  parsePluginManifest,
  updatePluginManifest,
} from './PluginManifest.js';
// Plugin Registry (main entry point)
export { getPluginRegistry, PluginRegistry } from './PluginRegistry.js';
// Schemas
export {
  mcpConfigFileSchema,
  mcpServerConfigSchema,
  pluginAuthorSchema,
  pluginManifestSchema,
  pluginNameSchema,
  pluginsConfigSchema,
  semverSchema,
  validateMcpConfig,
  validatePluginManifest,
  validatePluginsConfig,
} from './schemas.js';
// Types
export type {
  LoadedPlugin,
  ManifestSource,
  PluginAgent,
  PluginAuthor,
  PluginCommand,
  PluginDiscoveryError,
  PluginDiscoveryResult,
  PluginErrorCode,
  PluginLoadOptions,
  PluginManifest,
  PluginSearchDir,
  PluginSkill,
  PluginSource,
  PluginStatus,
  PluginsConfig,
} from './types.js';
