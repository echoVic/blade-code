import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseInput = vi.fn();
const setWorkspacePluginEnabled = vi.fn();
const refreshWorkspacePlugins = vi.fn();
const plugin = {
  manifest: {
    name: 'tui-plugin',
    version: '1.0.0',
    description: 'TUI plugin',
  },
  source: 'project',
  status: 'active',
  commands: [],
  skills: [],
  agents: [],
};
const registry = {
  getAll: vi.fn(() => [plugin]),
  getBySource: vi.fn(() => ({ cli: [], project: [plugin], user: [] })),
  getStats: vi.fn(() => ({
    total: 1,
    active: 1,
    inactive: 0,
    commands: 0,
    skills: 0,
    agents: 0,
  })),
  getWorkspaceRoot: vi.fn(() => '/workspace/project'),
  getSourcePolicy: vi.fn(() => ({
    restrictToAllowedSources: false,
    requireGitCommitSha: false,
    allowedGitHosts: [],
    allowedMarketplaces: [],
    allowedLocalRoots: [],
  })),
};

vi.mock('ink', () => ({
  Box: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('div', props, children),
  Text: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => React.createElement('span', props, children),
  useInput: (...args: unknown[]) => mockUseInput(...args),
}));

vi.mock('../../../../src/plugins/index.js', () => ({
  getPluginRegistry: () => registry,
}));

vi.mock('../../../../src/plugins/PluginLifecycle.js', () => ({
  setWorkspacePluginEnabled,
  refreshWorkspacePlugins,
}));

vi.mock('../../../../src/ui/hooks/useCtrlCHandler.js', () => ({
  useCtrlCHandler: () => vi.fn(),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useCurrentFocus: () => 'plugins-manager',
}));

describe('PluginsManager', () => {
  let inputHandler: ((input: string, key: Record<string, boolean>) => void) | undefined;

  beforeEach(() => {
    inputHandler = undefined;
    mockUseInput.mockReset();
    mockUseInput.mockImplementation((handler: typeof inputHandler) => {
      inputHandler = handler;
    });
    setWorkspacePluginEnabled.mockReset();
    setWorkspacePluginEnabled.mockResolvedValue({
      effectiveEnabled: false,
      effectiveScope: 'local',
    });
    refreshWorkspacePlugins.mockReset();
  });

  it('renders persistent controls and disables the selected workspace plugin', async () => {
    const { PluginsManager } = await import(
      '../../../../src/ui/components/PluginsManager.js'
    );
    const html = renderToStaticMarkup(
      React.createElement(PluginsManager, {
        workspaceRoot: '/workspace/project',
      })
    );

    expect(html).toContain('tui-plugin');
    expect(html).toContain('写入层级:');
    expect(html).toContain('local');
    expect(html).toContain('s 切换层级');
    expect(html).toContain('Space/Enter 启停');
    inputHandler?.('', { return: true });
    await vi.waitFor(() =>
      expect(setWorkspacePluginEnabled).toHaveBeenCalledWith(
        '/workspace/project',
        'tui-plugin',
        false,
        'local'
      )
    );
  });
});
