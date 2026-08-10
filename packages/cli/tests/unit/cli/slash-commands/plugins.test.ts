import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addAssistantMessage: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  uninstall: vi.fn(),
  addMarketplace: vi.fn(),
  refreshMarketplace: vi.fn(),
  removeMarketplace: vi.fn(),
  setPolicy: vi.fn(),
  listCatalogs: vi.fn(),
  listMarketplaces: vi.fn(),
}));

const registry = {
  getWorkspaceRoot: () => '/workspace/project',
  getAll: () => [],
  getBySource: () => ({ cli: [], project: [], user: [] }),
  getStats: () => ({
    total: 0,
    active: 0,
    inactive: 0,
    commands: 0,
    skills: 0,
    agents: 0,
  }),
  get: () => undefined,
  getSourcePolicy: () => ({
    restrictToAllowedSources: false,
    requireGitCommitSha: false,
    allowedGitHosts: [],
    allowedMarketplaces: [],
    allowedLocalRoots: [],
  }),
};

vi.mock('../../../../src/agent/resources/WorkspaceAgentResources.js', () => ({
  resolveWorkspaceAgentResources: vi.fn(async () => ({ plugins: registry })),
}));

vi.mock('../../../../src/plugins/index.js', () => ({
  getPluginRegistry: () => registry,
  getPluginInstaller: () => ({
    listCatalogs: mocks.listCatalogs,
    listMarketplaces: mocks.listMarketplaces,
  }),
  installWorkspacePlugin: mocks.install,
  updateWorkspacePlugin: mocks.update,
  uninstallWorkspacePlugin: mocks.uninstall,
  addPluginMarketplace: mocks.addMarketplace,
  refreshPluginMarketplace: mocks.refreshMarketplace,
  removePluginMarketplace: mocks.removeMarketplace,
  setWorkspacePluginSourcePolicy: mocks.setPolicy,
  refreshWorkspacePlugins: vi.fn(),
  setWorkspacePluginEnabled: vi.fn(),
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  sessionActions: () => ({
    addAssistantMessage: mocks.addAssistantMessage,
  }),
}));

import pluginsCommand from '../../../../src/slash-commands/plugins.js';

describe('/plugins package lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.install.mockResolvedValue({
      result: {
        success: true,
        pluginName: 'managed-plugin',
        manifest: {
          name: 'managed-plugin',
          description: 'Managed plugin',
          version: '1.0.0',
        },
        installation: { revision: 'abc123' },
        changed: true,
      },
    });
    mocks.update.mockResolvedValue({
      result: {
        success: true,
        pluginName: 'managed-plugin',
        installation: { revision: 'def456' },
        changed: true,
      },
    });
    mocks.uninstall.mockResolvedValue({
      result: {
        success: true,
        pluginName: 'managed-plugin',
      },
    });
    mocks.addMarketplace.mockResolvedValue({
      success: true,
      marketplace: { name: 'team-market' },
      manifest: { plugins: [{}] },
    });
    mocks.listCatalogs.mockResolvedValue([]);
    mocks.listMarketplaces.mockResolvedValue([]);
    mocks.setPolicy.mockResolvedValue({
      restrictToAllowedSources: true,
      requireGitCommitSha: true,
      allowedGitHosts: ['github.com'],
      allowedMarketplaces: [],
      allowedLocalRoots: [],
    });
  });

  it('requires source trust and forwards the exact install request', async () => {
    const rejected = await pluginsCommand.handler(
      ['install', 'managed-plugin@team-market'],
      { cwd: '/workspace/project' }
    );
    expect(rejected.success).toBe(false);
    expect(mocks.install).not.toHaveBeenCalled();

    const installed = await pluginsCommand.handler(
      ['install', 'managed-plugin@team-market', '--trust', '--ref', 'release'],
      { cwd: '/workspace/project' }
    );
    expect(installed.success).toBe(true);
    expect(mocks.install).toHaveBeenCalledWith(
      '/workspace/project',
      'managed-plugin@team-market',
      {
        trusted: true,
        ref: 'release',
      }
    );
  });

  it('requires explicit confirmation before uninstalling', async () => {
    const rejected = await pluginsCommand.handler(['uninstall', 'managed-plugin'], {
      cwd: '/workspace/project',
    });
    expect(rejected.success).toBe(false);
    expect(mocks.uninstall).not.toHaveBeenCalled();

    await pluginsCommand.handler(['uninstall', 'managed-plugin', '--confirm'], {
      cwd: '/workspace/project',
    });
    expect(mocks.uninstall).toHaveBeenCalledWith(
      '/workspace/project',
      'managed-plugin',
      true
    );
  });

  it('shares Marketplace commands with headless and ACP callers', async () => {
    const result = await pluginsCommand.handler(
      ['marketplace', 'add', 'owner/repository', '--ref=main'],
      {
        cwd: '/workspace/project',
        acp: { sendMessage: vi.fn() },
      }
    );
    expect(result.success).toBe(true);
    expect(mocks.addMarketplace).toHaveBeenCalledWith(
      '/workspace/project',
      'owner/repository',
      'main'
    );
  });

  it('updates source policy through the shared slash and ACP contract', async () => {
    const result = await pluginsCommand.handler(
      [
        'policy',
        'set',
        '--restrict=true',
        '--require-sha=true',
        '--hosts=github.com',
        '--scope=global',
      ],
      {
        cwd: '/workspace/project',
        acp: { sendMessage: vi.fn() },
      }
    );
    expect(result.success).toBe(true);
    expect(mocks.setPolicy).toHaveBeenCalledWith(
      '/workspace/project',
      {
        restrictToAllowedSources: true,
        requireGitCommitSha: true,
        allowedGitHosts: ['github.com'],
        allowedMarketplaces: [],
        allowedLocalRoots: [],
      },
      'global'
    );
  });
});
