/**
 * Blade Code Plugins System
 *
 * This module provides a plugin system for extending Blade Code with
 * custom commands, agents, skills, hooks, and MCP servers.
 *
 * @module plugins
 */

export {
  getPluginInstaller,
  type PluginCatalog,
  type PluginInstallOptions,
  type PluginInstallResult,
  type PluginMarketplaceResult,
  type PluginUninstallResult,
  resetPluginInstaller,
} from './PluginInstaller.js';
export { clearAllPluginResources, integrateAllPlugins } from './PluginIntegrator.js';
export {
  addPluginMarketplace,
  installWorkspacePlugin,
  type PluginSettingsScope,
  type PluginStateChange,
  refreshPluginMarketplace,
  refreshWorkspacePlugins,
  removePluginMarketplace,
  removeWorkspacePluginSettings,
  setWorkspacePluginEnabled,
  setWorkspacePluginSourcePolicy,
  uninstallWorkspacePlugin,
  updateWorkspacePlugin,
} from './PluginLifecycle.js';
export { getPluginRegistry } from './PluginRegistry.js';
