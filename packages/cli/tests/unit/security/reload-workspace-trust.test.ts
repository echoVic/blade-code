import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { currentModelId: 'safe-model' },
  reload: vi.fn(),
  setConfig: vi.fn(),
  disconnectAll: vi.fn(),
  resetResources: vi.fn(),
  resolveResources: vi.fn(),
}));

vi.mock('../../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: () => ({ reload: mocks.reload }),
  },
}));

vi.mock('../../../src/store/vanilla.js', () => ({
  getState: () => ({
    config: { actions: { setConfig: mocks.setConfig } },
  }),
}));

vi.mock('../../../src/mcp/McpRegistry.js', () => ({
  McpRegistry: {
    getInstance: () => ({ disconnectAll: mocks.disconnectAll }),
  },
}));

vi.mock('../../../src/agent/resources/WorkspaceAgentResources.js', () => ({
  resetWorkspaceAgentResources: mocks.resetResources,
  resolveWorkspaceAgentResources: mocks.resolveResources,
}));

vi.mock('../../../src/utils/cwd.js', () => ({
  getCwd: () => '/workspace',
}));

import { reloadWorkspaceTrustConfiguration } from '../../../src/security/reloadWorkspaceTrust.js';

describe('reloadWorkspaceTrustConfiguration', () => {
  it('publishes the filtered config before disconnecting loaded MCP clients', async () => {
    mocks.reload.mockResolvedValueOnce(mocks.config);
    mocks.disconnectAll.mockResolvedValueOnce(undefined);
    mocks.resolveResources.mockResolvedValueOnce(undefined);

    await reloadWorkspaceTrustConfiguration();

    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.setConfig).toHaveBeenCalledWith(mocks.config);
    expect(mocks.disconnectAll).toHaveBeenCalledOnce();
    expect(mocks.resetResources).toHaveBeenCalledOnce();
    expect(mocks.resolveResources).toHaveBeenCalledWith('/workspace');
    expect(mocks.setConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.disconnectAll.mock.invocationCallOrder[0]
    );
  });
});
