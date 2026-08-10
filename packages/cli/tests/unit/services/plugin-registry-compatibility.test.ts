import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { resetPluginInstaller } from '../../../src/plugins/PluginInstaller.js';
import { PluginRegistry } from '../../../src/plugins/PluginRegistry.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function writePlugin(
  workspace: string,
  name: string,
  version: string,
  dependencies: Record<string, string> = {}
): Promise<void> {
  await writeJson(
    path.join(workspace, '.blade', 'plugins', name, '.blade-plugin', 'plugin.json'),
    {
      name,
      description: `${name} fixture`,
      version,
      dependencies,
    }
  );
}

describe('PluginRegistry compatibility and source policy', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-plugin-compat-'));
    home = path.join(root, 'home');
    workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('BLADE_STORAGE_ROOT', path.join(root, 'storage'));
    ConfigManager.resetInstance();
    PluginRegistry.resetInstance();
    resetPluginInstaller();
    WorkspaceTrustService.resetInstance();
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    PluginRegistry.resetInstance();
    resetPluginInstaller();
    WorkspaceTrustService.resetInstance();
    homedirSpy.mockRestore();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('re-evaluates dependency versions and inactive transitive resources', async () => {
    await writePlugin(workspace, 'dependency-plugin', '1.0.0');
    await writePlugin(workspace, 'root-plugin', '1.0.0', {
      'dependency-plugin': '^2.0.0',
    });
    await WorkspaceTrustService.getInstance().trust(workspace);
    const registry = PluginRegistry.getInstance(workspace);
    await registry.initialize(workspace);

    expect(registry.get('root-plugin')).toMatchObject({
      status: 'error',
      compatibilityIssues: [expect.objectContaining({ code: 'dependency-version' })],
    });

    await writePlugin(workspace, 'dependency-plugin', '2.1.0');
    await registry.refresh();
    expect(registry.get('root-plugin')?.status).toBe('active');

    await writeJson(path.join(workspace, '.blade', 'settings.local.json'), {
      enabledPlugins: { 'dependency-plugin': false },
    });
    await registry.reapplyEnabledSettings();
    expect(registry.get('dependency-plugin')?.status).toBe('inactive');
    expect(registry.get('root-plugin')).toMatchObject({
      status: 'error',
      compatibilityIssues: [expect.objectContaining({ code: 'dependency-inactive' })],
    });
  });

  it('blocks already-installed local plugins after source policy is tightened', async () => {
    await writePlugin(workspace, 'root-plugin', '1.0.0');
    await writeJson(path.join(home, '.blade', 'settings.json'), {
      pluginSourcePolicy: {
        restrictToAllowedSources: true,
        allowedLocalRoots: [path.join(root, 'approved-only')],
      },
    });
    await WorkspaceTrustService.getInstance().trust(workspace);
    const registry = PluginRegistry.getInstance(workspace);
    const discovery = await registry.initialize(workspace);

    expect(registry.get('root-plugin')).toMatchObject({
      status: 'error',
      compatibilityIssues: [expect.objectContaining({ code: 'source-policy' })],
    });
    expect(discovery.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SOURCE_POLICY_BLOCKED' }),
      ])
    );
  });
});
