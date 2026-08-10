import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/skills/SkillInstaller.js', () => ({
  getSkillInstaller: () => ({
    ensureDefaultSkillsInstalled: vi.fn(async () => undefined),
  }),
}));

import { resetWorkspaceAgentResources } from '../../../../src/agent/resources/WorkspaceAgentResources.js';
import { ConfigManager } from '../../../../src/config/ConfigManager.js';
import { ConfigService } from '../../../../src/config/ConfigService.js';
import { resetPluginInstaller } from '../../../../src/plugins/PluginInstaller.js';
import { uninstallWorkspacePlugin } from '../../../../src/plugins/PluginLifecycle.js';
import { WorkspaceTrustService } from '../../../../src/security/WorkspaceTrustService.js';
import { PluginRoutes } from '../../../../src/server/routes/plugins.js';

async function writeFixture(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

describe('PluginRoutes', () => {
  let root: string;
  let workspace: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-plugin-routes-'));
    workspace = path.join(root, 'project');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    vi.stubEnv('BLADE_STORAGE_ROOT', path.join(root, 'storage'));
    await writeFixture(
      workspace,
      '.blade/plugins/route-plugin/.blade-plugin/plugin.json',
      `${JSON.stringify({
        name: 'route-plugin',
        description: 'Route plugin',
        version: '1.0.0',
      })}\n`
    );
    await writeFixture(
      workspace,
      '.blade/plugins/route-plugin/commands/probe.md',
      '---\ndescription: Probe\n---\nPLUGIN_ROUTE_PROBE\n'
    );
    ConfigManager.resetInstance();
    ConfigService.resetInstance();
    resetPluginInstaller();
    WorkspaceTrustService.resetInstance();
    resetWorkspaceAgentResources();
    await WorkspaceTrustService.getInstance().trust(workspace);
  });

  afterEach(async () => {
    resetWorkspaceAgentResources();
    WorkspaceTrustService.resetInstance();
    ConfigManager.resetInstance();
    ConfigService.resetInstance();
    resetPluginInstaller();
    homedirSpy.mockRestore();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists and projects the exact workspace plugin state', async () => {
    const app = PluginRoutes();
    const project = encodeURIComponent(workspace);
    const listed = await app.request(`/?projectPath=${project}`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'route-plugin',
          source: 'project',
          enabled: true,
          commands: 1,
          configurable: true,
        }),
      ])
    );

    const disabled = await app.request('/route-plugin/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        enabled: false,
        scope: 'local',
      }),
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      name: 'route-plugin',
      requestedEnabled: false,
      effectiveEnabled: false,
      scope: 'local',
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(workspace, '.blade', 'settings.local.json'), 'utf8')
      )
    ).toMatchObject({ enabledPlugins: { 'route-plugin': false } });

    const reloaded = await app.request(`/?projectPath=${project}`);
    await expect(reloaded.json()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'route-plugin',
          enabled: false,
        }),
      ])
    );
  });

  it('persists and returns the effective global plugin source policy', async () => {
    const app = PluginRoutes();
    const project = encodeURIComponent(workspace);
    const initial = await app.request(`/policy?projectPath=${project}`);
    await expect(initial.json()).resolves.toMatchObject({
      policy: {
        restrictToAllowedSources: false,
        requireGitCommitSha: false,
      },
      environmentRequiresSha: false,
    });

    const saved = await app.request('/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        scope: 'global',
        policy: {
          restrictToAllowedSources: true,
          requireGitCommitSha: true,
          allowedGitHosts: ['github.com'],
          allowedMarketplaces: ['route-market'],
          allowedLocalRoots: [workspace],
        },
      }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      policy: {
        restrictToAllowedSources: true,
        requireGitCommitSha: true,
        allowedGitHosts: ['github.com'],
        allowedMarketplaces: ['route-market'],
        allowedLocalRoots: [workspace],
      },
    });
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, 'home', '.blade', 'settings.json'), 'utf8')
      )
    ).toMatchObject({
      pluginSourcePolicy: {
        restrictToAllowedSources: true,
        requireGitCommitSha: true,
      },
    });
  });

  it('manages a trusted Marketplace and immutable plugin package lifecycle', async () => {
    const marketplace = path.join(workspace, 'fixtures', 'marketplace');
    await writeFixture(
      marketplace,
      '.blade-plugin/marketplace.json',
      `${JSON.stringify({
        name: 'route-market',
        description: 'Route marketplace',
        plugins: [
          {
            name: 'managed-route',
            description: 'Managed route plugin',
            version: '1.0.0',
            source: './plugins/managed-route',
          },
          {
            name: 'route-dependency',
            description: 'Managed route dependency',
            version: '1.0.0',
            source: './plugins/route-dependency',
          },
        ],
      })}\n`
    );
    await writeFixture(
      marketplace,
      'plugins/managed-route/.blade-plugin/plugin.json',
      `${JSON.stringify({
        name: 'managed-route',
        description: 'Managed route plugin',
        version: '1.0.0',
        dependencies: {
          'route-dependency': '^1.0.0',
        },
      })}\n`
    );
    await writeFixture(
      marketplace,
      'plugins/managed-route/commands/reveal.md',
      'ROUTE_MANAGED_ONE\n'
    );
    await writeFixture(
      marketplace,
      'plugins/route-dependency/.blade-plugin/plugin.json',
      `${JSON.stringify({
        name: 'route-dependency',
        description: 'Managed route dependency',
        version: '1.0.0',
      })}\n`
    );
    const app = PluginRoutes();

    const added = await app.request('/marketplaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        source: marketplace,
      }),
    });
    expect(added.status).toBe(200);
    await expect(added.json()).resolves.toMatchObject({
      name: 'route-market',
      plugins: 2,
      changed: true,
    });

    const catalog = await app.request(
      `/catalog?projectPath=${encodeURIComponent(workspace)}`
    );
    await expect(catalog.json()).resolves.toEqual([
      expect.objectContaining({
        name: 'route-market',
        plugins: expect.arrayContaining([
          expect.objectContaining({
            name: 'managed-route',
            installed: false,
          }),
        ]),
      }),
    ]);

    const installed = await app.request('/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        source: 'managed-route@route-market',
        trust: true,
      }),
    });
    expect(installed.status).toBe(200);
    await expect(installed.json()).resolves.toMatchObject({
      name: 'managed-route',
      version: '1.0.0',
      changed: true,
      installedDependencies: ['route-dependency'],
    });

    const listed = await app.request(`/?projectPath=${encodeURIComponent(workspace)}`);
    await expect(listed.json()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'managed-route',
          managed: true,
          marketplace: 'route-market',
        }),
      ])
    );

    await expect(
      uninstallWorkspacePlugin(workspace, 'route-dependency', true)
    ).resolves.toMatchObject({
      result: {
        success: false,
        code: 'PLUGIN_REQUIRED',
      },
    });

    const removed = await app.request('/managed-route/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        confirm: true,
      }),
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({
      name: 'managed-route',
      removed: true,
    });
    await expect(
      uninstallWorkspacePlugin(workspace, 'route-dependency', true)
    ).resolves.toMatchObject({
      result: { success: true },
    });

    const marketplaceRemoved = await app.request('/marketplaces/route-market/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: workspace,
        confirm: true,
      }),
    });
    expect(marketplaceRemoved.status).toBe(200);
  });
});
