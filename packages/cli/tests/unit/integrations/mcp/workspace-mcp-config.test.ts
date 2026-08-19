import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspaceServers: {
    workspace: { type: 'stdio' as const, command: 'workspace-server' },
    priority: { type: 'stdio' as const, command: 'workspace-priority' },
  },
  loadWorkspaceMcpServers: vi.fn(),
  plugins: [
    {
      manifest: { name: 'test-plugin' },
      source: 'project',
      status: 'active',
      mcpServers: {
        'test-plugin:server': {
          type: 'stdio' as const,
          command: 'plugin-server',
        },
        priority: { type: 'stdio' as const, command: 'plugin-priority' },
      },
    },
  ],
}));

vi.mock('../../../../src/config/index.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      loadWorkspaceMcpServers: mocks.loadWorkspaceMcpServers,
    }),
  },
}));

vi.mock('../../../../src/plugins/PluginRegistry.js', () => {
  const registry = {
    isInitialized: () => true,
    getWorkspaceRoot: () => '/workspace',
    getActive: () => mocks.plugins,
  };
  return {
    getPluginRegistry: () => registry,
    PluginRegistry: {
      getExistingInstance: () => registry,
    },
  };
});

vi.mock('../../../../src/plugins/PluginLoader.js', () => ({
  PluginLoader: class MockPluginLoader {
    static getPluginDirs() {
      return [];
    }
  },
}));

import { resolveWorkspaceMcpConfig } from '../../../../src/mcp/resolveWorkspaceMcpConfig.js';

describe('resolveWorkspaceMcpConfig', () => {
  beforeEach(() => {
    mocks.loadWorkspaceMcpServers.mockReset();
    mocks.loadWorkspaceMcpServers.mockResolvedValue(mocks.workspaceServers);
  });

  it('merges workspace, plugin, ACP session, and CLI sources in priority order', async () => {
    const result = await resolveWorkspaceMcpConfig({
      workspaceRoot: '/workspace',
      storeServers: {},
      sessionServers: {
        priority: { type: 'stdio', command: 'session-priority' },
      },
      cliConfigs: [
        JSON.stringify({
          priority: { type: 'stdio', command: 'cli-priority' },
        }),
      ],
    });

    expect(result).toEqual({
      workspace: {
        type: 'stdio',
        command: 'workspace-server',
        cwd: '/workspace',
      },
      'test-plugin:server': {
        type: 'stdio',
        command: 'plugin-server',
        cwd: '/workspace',
      },
      priority: {
        type: 'stdio',
        command: 'cli-priority',
        cwd: '/workspace',
      },
    });
  });

  it('uses only explicit CLI sources in strict mode', async () => {
    const result = await resolveWorkspaceMcpConfig({
      workspaceRoot: '/workspace',
      storeServers: mocks.workspaceServers,
      sessionServers: {
        session: { type: 'stdio', command: 'session-server' },
      },
      strictCliConfig: true,
      cliConfigs: [
        JSON.stringify({
          strict: {
            type: 'stdio',
            command: 'strict-server',
            cwd: 'services/api',
          },
        }),
      ],
    });

    expect(mocks.loadWorkspaceMcpServers).not.toHaveBeenCalled();
    expect(result).toEqual({
      strict: {
        type: 'stdio',
        command: 'strict-server',
        cwd: '/workspace/services/api',
      },
    });
  });

  it('normalizes explicit sampling policy and rejects unsafe limits', async () => {
    await expect(
      resolveWorkspaceMcpConfig({
        workspaceRoot: '/workspace',
        storeServers: {},
        strictCliConfig: true,
        cliConfigs: [
          JSON.stringify({
            sampler: {
              type: 'stdio',
              command: 'sampler',
              timeout: 10_000,
              idleTimeout: 2_000,
              sampling: {
                enabled: true,
                maxTokens: 128,
              },
            },
          }),
        ],
      })
    ).resolves.toEqual({
      sampler: {
        type: 'stdio',
        command: 'sampler',
        cwd: '/workspace',
        timeout: 10_000,
        idleTimeout: 2_000,
        sampling: {
          enabled: true,
          maxTokens: 128,
          maxRequestsPerToolCall: 2,
          maxInputBytes: 64 * 1024,
        },
      },
    });

    await expect(
      resolveWorkspaceMcpConfig({
        workspaceRoot: '/workspace',
        storeServers: {},
        strictCliConfig: true,
        cliConfigs: [
          JSON.stringify({
            sampler: {
              type: 'stdio',
              command: 'sampler',
              sampling: {
                enabled: true,
                maxTokens: 4_097,
              },
            },
          }),
        ],
      })
    ).rejects.toThrow('sampling.maxTokens');

    await expect(
      resolveWorkspaceMcpConfig({
        workspaceRoot: '/workspace',
        storeServers: {},
        strictCliConfig: true,
        cliConfigs: [
          JSON.stringify({
            sampler: {
              type: 'stdio',
              command: 'sampler',
              timeout: 2_000,
              idleTimeout: 3_000,
            },
          }),
        ],
      })
    ).rejects.toThrow('idleTimeout must not exceed timeout');
  });
});
