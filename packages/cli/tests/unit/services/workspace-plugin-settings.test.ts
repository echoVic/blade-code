import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { ConfigService } from '../../../src/config/ConfigService.js';
import { removeWorkspacePluginSettings } from '../../../src/plugins/PluginLifecycle.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

describe('workspace plugin settings', () => {
  let root: string;
  let trusted: string;
  let untrusted: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-plugin-settings-'));
    trusted = path.join(root, 'trusted');
    untrusted = path.join(root, 'untrusted');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    vi.stubEnv('BLADE_STORAGE_ROOT', path.join(root, 'storage'));
    await writeJson(path.join(root, 'home', '.blade', 'settings.json'), {
      enabledPlugins: {
        'shared-plugin': false,
        'user-plugin': true,
      },
    });
    for (const workspace of [trusted, untrusted]) {
      await writeJson(path.join(workspace, '.blade', 'settings.json'), {
        enabledPlugins: {
          'shared-plugin': true,
          'project-plugin': true,
        },
      });
      await writeJson(path.join(workspace, '.blade', 'settings.local.json'), {
        enabledPlugins: {
          'project-plugin': false,
          'local-plugin': true,
        },
      });
    }
    ConfigManager.resetInstance();
    ConfigService.resetInstance();
    WorkspaceTrustService.resetInstance();
    await WorkspaceTrustService.getInstance().trust(trusted);
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    ConfigService.resetInstance();
    WorkspaceTrustService.resetInstance();
    homedirSpy.mockRestore();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses local over project over user settings for a trusted workspace', async () => {
    await expect(
      ConfigManager.getInstance().loadWorkspacePluginSettings(trusted)
    ).resolves.toEqual({
      'shared-plugin': true,
      'user-plugin': true,
      'project-plugin': false,
      'local-plugin': true,
    });
  });

  it('lets an untrusted workspace disable but never enable plugins', async () => {
    await expect(
      ConfigManager.getInstance().loadWorkspacePluginSettings(untrusted)
    ).resolves.toEqual({
      'shared-plugin': false,
      'user-plugin': true,
      'project-plugin': false,
    });
  });

  it('fails closed for malformed plugin policy', async () => {
    await writeJson(path.join(trusted, '.blade', 'settings.local.json'), {
      enabledPlugins: { 'INVALID PLUGIN': true },
    });
    await expect(
      ConfigManager.getInstance().loadWorkspacePluginSettings(trusted)
    ).rejects.toThrow('Invalid plugin name');
  });

  it('merges source policy with tighten-only project semantics', async () => {
    const allowedRoot = path.join(root, 'approved');
    await writeJson(path.join(root, 'home', '.blade', 'settings.json'), {
      pluginSourcePolicy: {
        restrictToAllowedSources: true,
        requireGitCommitSha: true,
        allowedGitHosts: ['github.com', 'gitlab.com'],
        allowedMarketplaces: ['test-market', 'shared-market'],
        allowedLocalRoots: [allowedRoot, path.join(root, 'shared')],
      },
    });
    await writeJson(path.join(trusted, '.blade', 'settings.json'), {
      pluginSourcePolicy: {
        restrictToAllowedSources: false,
        requireGitCommitSha: false,
        allowedGitHosts: ['github.com'],
        allowedMarketplaces: ['test-market'],
        allowedLocalRoots: [allowedRoot],
      },
    });

    await expect(
      ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(trusted)
    ).resolves.toEqual({
      restrictToAllowedSources: true,
      requireGitCommitSha: true,
      allowedGitHosts: ['github.com'],
      allowedMarketplaces: ['test-market'],
      allowedLocalRoots: [allowedRoot],
    });
  });

  it('allows untrusted projects and the host environment to tighten source policy', async () => {
    await writeJson(path.join(root, 'home', '.blade', 'settings.json'), {
      pluginSourcePolicy: {
        restrictToAllowedSources: false,
        requireGitCommitSha: false,
      },
    });
    await writeJson(path.join(untrusted, '.blade', 'settings.json'), {
      pluginSourcePolicy: {
        restrictToAllowedSources: true,
        allowedGitHosts: [],
      },
    });
    vi.stubEnv('BLADE_PLUGIN_REQUIRE_SHA', '1');

    await expect(
      ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(untrusted)
    ).resolves.toMatchObject({
      restrictToAllowedSources: true,
      requireGitCommitSha: true,
      allowedGitHosts: [],
    });
  });

  it('rejects malformed source policy instead of silently broadening it', async () => {
    await writeJson(path.join(trusted, '.blade', 'settings.local.json'), {
      pluginSourcePolicy: {
        allowedLocalRoots: ['relative/path'],
      },
    });
    await expect(
      ConfigManager.getInstance().loadWorkspacePluginSourcePolicy(trusted)
    ).rejects.toThrow('must be absolute');
  });

  it('removes uninstall tombstones from every editable scope', async () => {
    await removeWorkspacePluginSettings(trusted, 'shared-plugin');

    for (const filePath of [
      path.join(root, 'home', '.blade', 'settings.json'),
      path.join(trusted, '.blade', 'settings.json'),
      path.join(trusted, '.blade', 'settings.local.json'),
    ]) {
      const settings = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
        enabledPlugins?: Record<string, boolean>;
      };
      expect(settings.enabledPlugins?.['shared-plugin']).toBeUndefined();
    }
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, 'home', '.blade', 'settings.json'), 'utf8')
      )
    ).toMatchObject({ enabledPlugins: { 'user-plugin': true } });
  });
});
