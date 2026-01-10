/**
 * Blade Code Plugins System - Plugin Manifest Parser
 *
 * This module handles parsing and validation of plugin.json manifest files.
 * It supports both .blade-plugin/ and .claude-plugin/ directories.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../logging/Logger.js';
import { pluginManifestSchema } from './schemas.js';
import type { ManifestSource, PluginManifest } from './types.js';

/**
 * Result of parsing a plugin manifest
 */
export interface ParseManifestResult {
  /** The parsed manifest */
  manifest: PluginManifest;

  /** Which directory the manifest was found in */
  source: ManifestSource;

  /** Absolute path to the manifest file */
  manifestPath: string;
}

/**
 * Manifest directory names in priority order
 * .blade-plugin/ takes precedence over .claude-plugin/
 */
const MANIFEST_DIRS: Array<{ dir: string; source: ManifestSource }> = [
  { dir: '.blade-plugin', source: 'blade' },
  { dir: '.claude-plugin', source: 'claude' },
];

/**
 * Parse a plugin manifest from a plugin directory
 *
 * This function looks for plugin.json in .blade-plugin/ first,
 * falling back to .claude-plugin/ for Claude Code compatibility.
 *
 * @param pluginDir - Absolute path to the plugin root directory
 * @returns Parsed manifest result, or null if no valid manifest found
 * @throws Error if manifest exists but is invalid
 *
 * @example
 * const result = await parsePluginManifest('/path/to/my-plugin');
 * if (result) {
 *   console.log(result.manifest.name); // e.g., "my-plugin"
 * }
 */
export async function parsePluginManifest(
  pluginDir: string
): Promise<ParseManifestResult | null> {
  // Try each manifest directory in priority order
  for (const { dir, source } of MANIFEST_DIRS) {
    const manifestPath = path.join(pluginDir, dir, 'plugin.json');

    try {
      await fs.access(manifestPath);
    } catch {
      // Manifest not found in this directory, try next
      continue;
    }

    // Found a manifest file, parse it
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      const rawManifest = JSON.parse(content);

      // Validate with Zod schema
      const result = pluginManifestSchema.safeParse(rawManifest);

      if (!result.success) {
        const errors = result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        throw new Error(`Invalid plugin.json: ${errors}`);
      }

      logger.debug(`Parsed plugin manifest from ${manifestPath}`);

      return {
        manifest: result.data,
        source,
        manifestPath,
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in ${manifestPath}: ${error.message}`);
      }
      throw error;
    }
  }

  // No manifest found in any directory
  return null;
}

/**
 * Check if a directory is a valid plugin directory
 *
 * A valid plugin directory must contain a plugin.json in either
 * .blade-plugin/ or .claude-plugin/ subdirectory.
 *
 * @param dirPath - Path to check
 * @returns True if the directory is a valid plugin
 */
export async function isValidPluginDir(dirPath: string): Promise<boolean> {
  try {
    const result = await parsePluginManifest(dirPath);
    return result !== null;
  } catch {
    return false;
  }
}
