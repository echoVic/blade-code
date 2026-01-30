/**
 * Blade Code Plugins System
 *
 * This module provides a plugin system for extending Blade Code with
 * custom commands, agents, skills, hooks, and MCP servers.
 *
 * @module plugins
 */

export { getPluginInstaller } from './PluginInstaller.js';
export { clearAllPluginResources, integrateAllPlugins } from './PluginIntegrator.js';
export { getPluginRegistry } from './PluginRegistry.js';
