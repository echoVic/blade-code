import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trusted: false,
  discover: vi.fn(async () => ({ plugins: [], errors: [] })),
}));

vi.mock('../../../src/security/WorkspaceTrustService.js', () => ({
  isWorkspaceTrusted: (status: { state: string }) =>
    status.state === 'trusted' || status.state === 'not_required',
  WorkspaceTrustService: {
    getInstance: () => ({
      getStatus: async () => ({
        projectPath: '/workspace',
        trustRoot: '/workspace',
        state: mocks.trusted ? 'trusted' : 'untrusted',
      }),
    }),
  },
}));

vi.mock('../../../src/plugins/PluginLoader.js', () => ({
  PluginLoader: class MockPluginLoader {
    static getPluginDirs() {
      return [
        { path: '/user/blade', source: 'user', type: 'blade' },
        { path: '/project/blade', source: 'project', type: 'blade' },
      ];
    }

    discoverPluginsInDir = mocks.discover;
    loadPlugin = vi.fn();
  },
}));

import { PluginRegistry } from '../../../src/plugins/PluginRegistry.js';

describe('PluginRegistry workspace trust gate', () => {
  beforeEach(() => {
    PluginRegistry.resetInstance();
    mocks.discover.mockClear();
    mocks.trusted = false;
  });

  it('does not discover project plugins for an untrusted workspace', async () => {
    await PluginRegistry.getInstance().initialize('/workspace');

    expect(mocks.discover).toHaveBeenCalledTimes(1);
    expect(mocks.discover).toHaveBeenCalledWith('/user/blade', 'user');
  });

  it('discovers user and project plugins after folder trust', async () => {
    mocks.trusted = true;
    await PluginRegistry.getInstance().initialize('/workspace');

    expect(mocks.discover.mock.calls).toEqual([
      ['/user/blade', 'user'],
      ['/project/blade', 'project'],
    ]);
  });
});
