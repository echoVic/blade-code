import path from 'node:path';
import type { PluginSourcePolicy } from './types.js';

export type PluginSettingsScope = 'global' | 'project' | 'local' | 'invocation';
export type PersistedPluginSettingsScope = Exclude<PluginSettingsScope, 'invocation'>;

export interface PluginSettingResolution {
  effective: boolean;
  effectiveScope: PluginSettingsScope;
  layers: Partial<Record<PluginSettingsScope, boolean>>;
}

export interface WorkspacePluginSettingsResolution {
  effective: Record<string, boolean>;
  settings: Record<string, PluginSettingResolution>;
  workspaceTrusted: boolean;
}

const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const HOST_PATTERN =
  /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizePluginSettings(
  value: Readonly<Record<string, unknown>>
): Record<string, boolean> {
  const entries: Array<[string, boolean]> = [];
  for (const [name, enabled] of Object.entries(value)) {
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid plugin name in enabledPlugins: ${name}`);
    }
    if (typeof enabled !== 'boolean') {
      throw new Error(`Invalid enabledPlugins value for ${name}`);
    }
    entries.push([name, enabled]);
  }
  return Object.fromEntries(entries);
}

function normalizeStringArray(
  value: unknown,
  label: string,
  normalize: (entry: string) => string
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return [
    ...new Set(
      value.map((entry, index) => {
        if (typeof entry !== 'string' || !entry.trim()) {
          throw new Error(`${label}[${index}] must be a non-empty string`);
        }
        return normalize(entry.trim());
      })
    ),
  ].sort();
}

export function normalizePluginSourcePolicy(
  value: Readonly<Record<string, unknown>>
): Partial<PluginSourcePolicy> {
  const allowedKeys = new Set([
    'restrictToAllowedSources',
    'requireGitCommitSha',
    'allowedGitHosts',
    'allowedMarketplaces',
    'allowedLocalRoots',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown pluginSourcePolicy fields: ${unknown.join(', ')}`);
  }

  const result: Partial<PluginSourcePolicy> = {};
  for (const key of ['restrictToAllowedSources', 'requireGitCommitSha'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') {
      throw new Error(`pluginSourcePolicy.${key} must be boolean`);
    }
    result[key] = value[key];
  }
  if (value.allowedGitHosts !== undefined) {
    result.allowedGitHosts = normalizeStringArray(
      value.allowedGitHosts,
      'pluginSourcePolicy.allowedGitHosts',
      (host) => {
        const normalized = host.toLowerCase();
        if (!HOST_PATTERN.test(normalized)) {
          throw new Error(`Invalid plugin Git host pattern: ${host}`);
        }
        return normalized;
      }
    );
  }
  if (value.allowedMarketplaces !== undefined) {
    result.allowedMarketplaces = normalizeStringArray(
      value.allowedMarketplaces,
      'pluginSourcePolicy.allowedMarketplaces',
      (name) => {
        if (!PLUGIN_NAME_PATTERN.test(name)) {
          throw new Error(`Invalid allowed Marketplace name: ${name}`);
        }
        return name;
      }
    );
  }
  if (value.allowedLocalRoots !== undefined) {
    result.allowedLocalRoots = normalizeStringArray(
      value.allowedLocalRoots,
      'pluginSourcePolicy.allowedLocalRoots',
      (root) => {
        if (!path.isAbsolute(root)) {
          throw new Error(`Plugin local allowlist root must be absolute: ${root}`);
        }
        return path.resolve(root);
      }
    );
  }
  return result;
}
