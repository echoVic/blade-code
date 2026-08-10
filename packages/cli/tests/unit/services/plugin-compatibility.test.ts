import { describe, expect, it } from 'vitest';
import {
  applyPluginCompatibility,
  assertBladeVersionCompatible,
  validatePluginManifestConstraints,
} from '../../../src/plugins/PluginCompatibility.js';
import type { LoadedPlugin, PluginManifest } from '../../../src/plugins/types.js';

function plugin(
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
  status: LoadedPlugin['status'] = 'active'
): LoadedPlugin {
  return {
    manifest: {
      name,
      version,
      description: `${name} fixture`,
      dependencies,
    },
    basePath: `/plugins/${name}`,
    source: 'user',
    manifestSource: 'blade',
    commands: [],
    agents: [],
    skills: [],
    status,
    loadedAt: new Date(0),
  };
}

describe('plugin compatibility graph', () => {
  it('rejects invalid declarations and incompatible Blade versions', () => {
    expect(() =>
      validatePluginManifestConstraints({
        name: 'root-plugin',
        version: '1.0.0',
        description: 'Root',
        dependencies: { 'INVALID DEP': '^1.0.0' },
      })
    ).toThrow('Invalid dependency name');
    expect(() =>
      validatePluginManifestConstraints({
        name: 'root-plugin',
        version: '1.0.0',
        description: 'Root',
        dependencies: { 'dep-plugin': 'not-a-range' },
      })
    ).toThrow('Invalid dependency range');
    expect(() =>
      assertBladeVersionCompatible(
        {
          name: 'root-plugin',
          version: '1.0.0',
          description: 'Root',
          bladeVersion: '>=99.0.0',
        },
        '0.9.0'
      )
    ).toThrow('requires Blade');
  });

  it('demotes missing and version-incompatible dependencies', () => {
    const missing = plugin('missing-root', '1.0.0', {
      'missing-dep': '^1.0.0',
    });
    const versioned = plugin('version-root', '1.0.0', {
      'old-dep': '^2.0.0',
    });
    const old = plugin('old-dep', '1.5.0');

    applyPluginCompatibility([missing, versioned, old], '0.9.0');

    expect(missing).toMatchObject({
      status: 'error',
      compatibilityIssues: [expect.objectContaining({ code: 'dependency-missing' })],
    });
    expect(versioned).toMatchObject({
      status: 'error',
      compatibilityIssues: [expect.objectContaining({ code: 'dependency-version' })],
    });
  });

  it('reaches a fixed point when an inactive transitive dependency breaks parents', () => {
    const root = plugin('root-plugin', '1.0.0', {
      'middle-plugin': '^1.0.0',
    });
    const middle = plugin('middle-plugin', '1.0.0', {
      'leaf-plugin': '^1.0.0',
    });
    const leaf = plugin('leaf-plugin', '1.0.0', {}, 'inactive');

    applyPluginCompatibility([root, middle, leaf], '0.9.0');

    expect(middle.status).toBe('error');
    expect(root.status).toBe('error');
    expect(root.compatibilityIssues).toEqual([
      expect.objectContaining({
        code: 'dependency-inactive',
        dependency: 'middle-plugin',
      }),
    ]);
  });

  it('accepts a satisfied dependency graph', () => {
    const manifest: PluginManifest = {
      name: 'root-plugin',
      version: '1.0.0',
      description: 'Root',
      bladeVersion: '>=0.9.0',
      dependencies: { 'dep-plugin': '^2.0.0' },
    };
    const root = plugin('root-plugin', '1.0.0', manifest.dependencies);
    root.manifest.bladeVersion = manifest.bladeVersion;
    const dependency = plugin('dep-plugin', '2.4.0');

    expect(applyPluginCompatibility([root, dependency], '0.9.0')).toEqual([]);
    expect(root.status).toBe('active');
  });
});
