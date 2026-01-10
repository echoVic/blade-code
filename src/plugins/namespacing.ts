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
export const NAMESPACE_SEPARATOR = ':';

/**
 * MCP server namespace separator (double underscore to avoid conflicts with server names)
 */
export const MCP_NAMESPACE_SEPARATOR = '__';

/**
 * Result of parsing a namespaced name
 */
export interface ParsedNamespace {
  /** Plugin name, or null if no namespace */
  plugin: string | null;

  /** Resource name */
  name: string;
}

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

/**
 * Parse a namespaced name into its components
 *
 * @param namespacedName - The namespaced name to parse
 * @returns Parsed namespace object
 *
 * @example
 * parseNamespacedName('my-plugin:commit')
 * // => { plugin: 'my-plugin', name: 'commit' }
 *
 * parseNamespacedName('commit')
 * // => { plugin: null, name: 'commit' }
 */
export function parseNamespacedName(namespacedName: string): ParsedNamespace {
  const separatorIndex = namespacedName.indexOf(NAMESPACE_SEPARATOR);

  if (separatorIndex === -1) {
    return { plugin: null, name: namespacedName };
  }

  return {
    plugin: namespacedName.slice(0, separatorIndex),
    name: namespacedName.slice(separatorIndex + 1),
  };
}

/**
 * Parse an MCP namespaced name into its components
 *
 * @param namespacedName - The namespaced MCP server name
 * @returns Parsed namespace object
 *
 * @example
 * parseMcpNamespacedName('my-plugin__github')
 * // => { plugin: 'my-plugin', name: 'github' }
 */
export function parseMcpNamespacedName(namespacedName: string): ParsedNamespace {
  const separatorIndex = namespacedName.indexOf(MCP_NAMESPACE_SEPARATOR);

  if (separatorIndex === -1) {
    return { plugin: null, name: namespacedName };
  }

  return {
    plugin: namespacedName.slice(0, separatorIndex),
    name: namespacedName.slice(separatorIndex + MCP_NAMESPACE_SEPARATOR.length),
  };
}

/**
 * Check if a name contains a namespace
 *
 * @param name - The name to check
 * @returns True if the name contains a namespace separator
 *
 * @example
 * hasNamespace('my-plugin:commit') // => true
 * hasNamespace('commit') // => false
 */
export function hasNamespace(name: string): boolean {
  return name.includes(NAMESPACE_SEPARATOR);
}

/**
 * Check if an MCP server name contains a namespace
 *
 * @param name - The MCP server name to check
 * @returns True if the name contains an MCP namespace separator
 */
export function hasMcpNamespace(name: string): boolean {
  return name.includes(MCP_NAMESPACE_SEPARATOR);
}

/**
 * Extract the plugin name from a namespaced name
 *
 * @param name - The namespaced name
 * @returns Plugin name, or null if no namespace
 *
 * @example
 * extractPluginName('my-plugin:commit') // => 'my-plugin'
 * extractPluginName('commit') // => null
 */
export function extractPluginName(name: string): string | null {
  const { plugin } = parseNamespacedName(name);
  return plugin;
}

/**
 * Extract the resource name from a namespaced name
 *
 * @param name - The namespaced name
 * @returns Resource name (without namespace)
 *
 * @example
 * extractResourceName('my-plugin:commit') // => 'commit'
 * extractResourceName('commit') // => 'commit'
 */
export function extractResourceName(name: string): string {
  const { name: resourceName } = parseNamespacedName(name);
  return resourceName;
}

/**
 * Validate a plugin name
 *
 * @param name - The name to validate
 * @returns True if the name is a valid plugin name
 */
export function isValidPluginName(name: string): boolean {
  // Must be lowercase letters, numbers, and hyphens
  // Must start and end with alphanumeric
  // Length: 2-64 characters
  const pattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/;
  return name.length >= 2 && name.length <= 64 && pattern.test(name);
}

/**
 * Convert a string to a valid plugin name
 *
 * @param input - The input string
 * @returns A valid plugin name derived from the input
 *
 * @example
 * toPluginName('My Plugin') // => 'my-plugin'
 * toPluginName('MyPlugin123') // => 'myplugin123'
 */
export function toPluginName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') // Replace invalid chars with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
    .slice(0, 64); // Truncate to max length
}

/**
 * Format a slash command with namespace for display
 *
 * @param namespacedName - The namespaced command name
 * @returns Formatted string for display (e.g., "/my-plugin:commit")
 */
export function formatSlashCommand(namespacedName: string): string {
  return `/${namespacedName}`;
}
