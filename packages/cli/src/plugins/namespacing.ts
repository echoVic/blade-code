/**
 * Blade Code Plugins System - Namespacing Utilities
 *
 * This module provides utilities for handling plugin namespacing.
 * Plugin resources (commands, skills, agents) are namespaced to prevent conflicts.
 *
 * Format: plugin-name:resource-name
 * Example: my-plugin:commit
 */

/**
 * Namespace separator used between plugin name and resource name
 */
const NAMESPACE_SEPARATOR = ':';

/**
 * MCP server namespace separator (double underscore to avoid conflicts with server names)
 */
const MCP_NAMESPACE_SEPARATOR = '__';

/**
 * Generate a namespaced name for a plugin resource
 *
 * @param pluginName - The plugin name
 * @param resourceName - The resource name (command, skill, agent)
 * @returns Namespaced name (e.g., "my-plugin:commit")
 *
 * @example
 * getNamespacedName('my-plugin', 'commit') // => 'my-plugin:commit'
 */
export function getNamespacedName(pluginName: string, resourceName: string): string {
  return `${pluginName}${NAMESPACE_SEPARATOR}${resourceName}`;
}

/**
 * Generate a namespaced name for an MCP server
 *
 * @param pluginName - The plugin name
 * @param serverName - The MCP server name
 * @returns Namespaced server name (e.g., "my-plugin__github")
 *
 * @example
 * getMcpNamespacedName('my-plugin', 'github') // => 'my-plugin__github'
 */
export function getMcpNamespacedName(pluginName: string, serverName: string): string {
  return `${pluginName}${MCP_NAMESPACE_SEPARATOR}${serverName}`;
}



