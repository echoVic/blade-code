import { satisfies, validRange } from 'semver';
import { getVersion } from '../utils/packageInfo.js';
import type {
  LoadedPlugin,
  PluginCompatibilityIssue,
  PluginManifest,
} from './types.js';

const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export function validatePluginManifestConstraints(manifest: PluginManifest): void {
  if (
    manifest.bladeVersion !== undefined &&
    (!manifest.bladeVersion.trim() || !validRange(manifest.bladeVersion))
  ) {
    throw new Error(
      `Invalid Blade version range in plugin "${manifest.name}": ${manifest.bladeVersion}`
    );
  }
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!PLUGIN_NAME_PATTERN.test(dependency)) {
      throw new Error(
        `Invalid dependency name in plugin "${manifest.name}": ${dependency}`
      );
    }
    if (dependency === manifest.name) {
      throw new Error(`Plugin "${manifest.name}" cannot depend on itself`);
    }
    if (!range.trim() || !validRange(range)) {
      throw new Error(
        `Invalid dependency range for ${dependency} in plugin "${manifest.name}": ${range}`
      );
    }
  }
}

export function assertBladeVersionCompatible(
  manifest: PluginManifest,
  bladeVersion = getVersion()
): void {
  validatePluginManifestConstraints(manifest);
  if (manifest.bladeVersion && !satisfies(bladeVersion, manifest.bladeVersion)) {
    throw new Error(
      `Plugin "${manifest.name}" requires Blade ${manifest.bladeVersion}, current ${bladeVersion}`
    );
  }
}

function markIncompatible(plugin: LoadedPlugin, issue: PluginCompatibilityIssue): void {
  plugin.status = 'error';
  plugin.compatibilityIssues = [...(plugin.compatibilityIssues ?? []), issue];
  plugin.error = plugin.compatibilityIssues.map((entry) => entry.message).join('; ');
}

export function applyPluginCompatibility(
  plugins: readonly LoadedPlugin[],
  bladeVersion = getVersion()
): PluginCompatibilityIssue[] {
  const issues: PluginCompatibilityIssue[] = [];
  const byName = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));

  for (const plugin of plugins) {
    if (plugin.status !== 'active') continue;
    if (
      plugin.manifest.bladeVersion &&
      !satisfies(bladeVersion, plugin.manifest.bladeVersion)
    ) {
      const issue: PluginCompatibilityIssue = {
        code: 'blade-version',
        expected: plugin.manifest.bladeVersion,
        actual: bladeVersion,
        message: `Requires Blade ${plugin.manifest.bladeVersion}, current ${bladeVersion}`,
      };
      markIncompatible(plugin, issue);
      issues.push(issue);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const plugin of plugins) {
      if (plugin.status !== 'active') continue;
      for (const [dependencyName, expected] of Object.entries(
        plugin.manifest.dependencies ?? {}
      )) {
        const dependency = byName.get(dependencyName);
        let issue: PluginCompatibilityIssue | undefined;
        if (!dependency) {
          issue = {
            code: 'dependency-missing',
            dependency: dependencyName,
            expected,
            message: `Missing dependency ${dependencyName}@${expected}`,
          };
        } else if (!satisfies(dependency.manifest.version, expected)) {
          issue = {
            code: 'dependency-version',
            dependency: dependencyName,
            expected,
            actual: dependency.manifest.version,
            message:
              `Dependency ${dependencyName} requires ${expected}, ` +
              `found ${dependency.manifest.version}`,
          };
        } else if (dependency.status !== 'active') {
          issue = {
            code: 'dependency-inactive',
            dependency: dependencyName,
            expected,
            actual: dependency.status,
            message: `Dependency ${dependencyName} is ${dependency.status}`,
          };
        }
        if (!issue) continue;
        markIncompatible(plugin, issue);
        issues.push(issue);
        changed = true;
        break;
      }
    }
  }
  return issues;
}
