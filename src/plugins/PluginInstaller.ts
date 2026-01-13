/**
 * Blade Code Plugins System - Plugin Installer
 *
 * This module handles remote installation of plugins from Git URLs.
 * Supports GitHub repositories and generic Git URLs.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { logger } from '../logging/Logger.js';
import { isValidPluginDir, parsePluginManifest } from './PluginManifest.js';
import type { PluginManifest } from './types.js';

/**
 * Installation result
 */
interface InstallResult {
  success: boolean;
  pluginName?: string;
  pluginPath?: string;
  manifest?: PluginManifest;
  error?: string;
}

/**
 * Uninstall result
 */
interface UninstallResult {
  success: boolean;
  pluginName: string;
  pluginPath?: string;
  error?: string;
}

/**
 * Plugin Installer
 *
 * Handles installation and uninstallation of plugins from remote sources.
 */
export class PluginInstaller {
  private userPluginsDir: string;

  constructor(userPluginsDir?: string) {
    this.userPluginsDir = userPluginsDir || path.join(homedir(), '.blade', 'plugins');
  }

  /**
   * Install a plugin from a Git URL
   *
   * Supports:
   * - GitHub URLs: https://github.com/user/repo
   * - Generic Git URLs: https://example.com/repo.git
   * - GitHub shorthand: user/repo
   *
   * @param source - Git URL or GitHub shorthand
   * @returns Installation result
   */
  async install(source: string): Promise<InstallResult> {
    try {
      // Parse the source URL
      const gitUrl = this.parseGitUrl(source);
      if (!gitUrl) {
        return {
          success: false,
          error: `Invalid source URL: ${source}`,
        };
      }

      // Extract plugin name from URL
      const pluginName = this.extractPluginName(gitUrl);
      if (!pluginName) {
        return {
          success: false,
          error: `Could not extract plugin name from URL: ${gitUrl}`,
        };
      }

      // Ensure plugins directory exists
      await fs.mkdir(this.userPluginsDir, { recursive: true, mode: 0o755 });

      const pluginPath = path.join(this.userPluginsDir, pluginName);

      // Check if plugin already exists
      try {
        await fs.access(pluginPath);
        return {
          success: false,
          pluginName,
          pluginPath,
          error: `Plugin "${pluginName}" already exists at ${pluginPath}. Use /plugins uninstall first.`,
        };
      } catch {
        // Plugin doesn't exist, good to proceed
      }

      // Clone the repository
      logger.info(`Cloning ${gitUrl} to ${pluginPath}...`);
      try {
        execSync(`git clone --depth 1 "${gitUrl}" "${pluginPath}"`, {
          stdio: 'pipe',
          timeout: 60000, // 60 second timeout
        });
      } catch (error) {
        return {
          success: false,
          pluginName,
          error: `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Validate the cloned plugin
      if (!(await isValidPluginDir(pluginPath))) {
        // Clean up invalid plugin
        await fs.rm(pluginPath, { recursive: true, force: true });
        return {
          success: false,
          pluginName,
          error: `Invalid plugin: No .blade-plugin/plugin.json or .claude-plugin/plugin.json found`,
        };
      }

      // Parse and return the manifest
      let manifestResult;
      try {
        manifestResult = await parsePluginManifest(pluginPath);
      } catch (parseError) {
        await fs.rm(pluginPath, { recursive: true, force: true });
        return {
          success: false,
          pluginName,
          error: `Invalid plugin manifest: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        };
      }

      if (!manifestResult) {
        // Clean up invalid plugin
        await fs.rm(pluginPath, { recursive: true, force: true });
        return {
          success: false,
          pluginName,
          error: `Invalid plugin manifest: No manifest found`,
        };
      }

      logger.info(`Successfully installed plugin: ${manifestResult.manifest.name}`);

      return {
        success: true,
        pluginName: manifestResult.manifest.name,
        pluginPath,
        manifest: manifestResult.manifest,
      };
    } catch (error) {
      return {
        success: false,
        error: `Installation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Uninstall a plugin by name
   *
   * @param name - Plugin name to uninstall
   * @returns Uninstall result
   */
  async uninstall(name: string): Promise<UninstallResult> {
    try {
      const pluginPath = path.join(this.userPluginsDir, name);

      // Check if plugin exists
      try {
        await fs.access(pluginPath);
      } catch {
        return {
          success: false,
          pluginName: name,
          error: `Plugin "${name}" not found at ${pluginPath}`,
        };
      }

      // Remove the plugin directory
      await fs.rm(pluginPath, { recursive: true, force: true });

      logger.info(`Successfully uninstalled plugin: ${name}`);

      return {
        success: true,
        pluginName: name,
        pluginPath,
      };
    } catch (error) {
      return {
        success: false,
        pluginName: name,
        error: `Uninstallation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * List installed plugins in user plugins directory
   *
   * @returns Array of plugin directories
   */
  async listInstalled(): Promise<string[]> {
    try {
      await fs.access(this.userPluginsDir);
      const entries = await fs.readdir(this.userPluginsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Update a plugin by pulling latest changes
   *
   * @param name - Plugin name to update
   * @returns Update result
   */
  async update(name: string): Promise<InstallResult> {
    try {
      const pluginPath = path.join(this.userPluginsDir, name);

      // Check if plugin exists
      try {
        await fs.access(pluginPath);
      } catch {
        return {
          success: false,
          pluginName: name,
          error: `Plugin "${name}" not found at ${pluginPath}`,
        };
      }

      // Check if it's a git repository
      const gitDir = path.join(pluginPath, '.git');
      try {
        await fs.access(gitDir);
      } catch {
        return {
          success: false,
          pluginName: name,
          error: `Plugin "${name}" is not a git repository`,
        };
      }

      // Pull latest changes
      logger.info(`Updating plugin: ${name}...`);
      try {
        execSync(`git -C "${pluginPath}" pull --ff-only`, {
          stdio: 'pipe',
          timeout: 60000,
        });
      } catch (error) {
        return {
          success: false,
          pluginName: name,
          error: `Failed to update: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Re-parse the manifest
      let manifestResult;
      try {
        manifestResult = await parsePluginManifest(pluginPath);
      } catch (parseError) {
        return {
          success: false,
          pluginName: name,
          error: `Plugin manifest invalid after update: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        };
      }

      if (!manifestResult) {
        return {
          success: false,
          pluginName: name,
          error: `Plugin manifest not found after update`,
        };
      }

      logger.info(`Successfully updated plugin: ${manifestResult.manifest.name}`);

      return {
        success: true,
        pluginName: manifestResult.manifest.name,
        pluginPath,
        manifest: manifestResult.manifest,
      };
    } catch (error) {
      return {
        success: false,
        pluginName: name,
        error: `Update failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Parse a source string into a Git URL
   *
   * @param source - Source URL or shorthand
   * @returns Git URL or null if invalid
   */
  private parseGitUrl(source: string): string | null {
    // Already a full URL
    if (source.startsWith('https://') || source.startsWith('git@')) {
      return source;
    }

    // GitHub shorthand: user/repo
    if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(source)) {
      return `https://github.com/${source}.git`;
    }

    return null;
  }

  /**
   * Extract plugin name from Git URL
   *
   * @param url - Git URL
   * @returns Plugin name or null if cannot extract
   */
  private extractPluginName(url: string): string | null {
    // Extract repo name from URL
    // https://github.com/user/repo.git -> repo
    // https://github.com/user/repo -> repo
    // git@github.com:user/repo.git -> repo

    const match = url.match(/\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
    if (match) {
      return match[1];
    }

    // Try SSH format
    const sshMatch = url.match(/:([a-zA-Z0-9_-]+\/)?([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[2];
    }

    return null;
  }
}

/**
 * Singleton instance
 */
let installerInstance: PluginInstaller | null = null;

/**
 * Get the plugin installer singleton
 */
export function getPluginInstaller(userPluginsDir?: string): PluginInstaller {
  if (!installerInstance) {
    installerInstance = new PluginInstaller(userPluginsDir);
  }
  return installerInstance;
}
