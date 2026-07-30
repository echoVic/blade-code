import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseGitBranch = vi.fn((_projectRoot?: string) => ({
  branch: 'main',
  loading: false,
}));
const mockGetProjectRoot = vi.fn(() => '/repo-root');

vi.mock('ink', () => ({
  Box: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('../../../../src/store/selectors/index.js', () => ({
  useActiveModal: () => null,
  useAwaitingSecondCtrlC: () => false,
  useContextRemaining: () => 100,
  useCurrentModel: () => null,
  useIsCompacting: () => false,
  useIsReady: () => true,
  usePermissionMode: () => 'default',
  useSpecProgress: () => ({ phase: null, completed: 0, total: 0 }),
  useThinkingModeEnabled: () => false,
}));

vi.mock('../../../../src/ui/hooks/useGitBranch.js', () => ({
  useGitBranch: (projectRoot?: string) => mockUseGitBranch(projectRoot),
}));

vi.mock('../../../../src/bootstrap/state.js', () => ({
  getProjectRoot: () => mockGetProjectRoot(),
}));

describe('ChatStatusBar', () => {
  beforeEach(() => {
    mockUseGitBranch.mockClear();
    mockGetProjectRoot.mockClear();
  });

  it('应该使用稳定 projectRoot 获取分支', async () => {
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(mockGetProjectRoot).toHaveBeenCalledTimes(1);
    expect(mockUseGitBranch).toHaveBeenCalledWith('/repo-root');
  });
});
