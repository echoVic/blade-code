import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseGitBranch = vi.fn((_projectRoot?: string) => ({
  branch: 'main',
  loading: false,
}));
const mockGetProjectRoot = vi.fn(() => '/repo-root');
const mockRecoveredSteeringCount = vi.fn(() => 0);
const mockCommunicationStyle = vi.fn(() => 'auto');

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
  usePendingCommands: () => [],
  usePermissionMode: () => 'default',
  useRecoveredSteeringCount: () => mockRecoveredSteeringCount(),
  useSessionCost: () => null,
  useSessionId: () => 'status-bar-session',
  useThinkingModeEnabled: () => false,
  useReasoningEffort: () => 'off',
  useServiceTier: () => 'auto',
  useResponseVerbosity: () => 'auto',
  useCommunicationStyle: () => mockCommunicationStyle(),
  useWorkspaceRoot: () => '/active-workspace',
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
    mockRecoveredSteeringCount.mockReturnValue(0);
    mockCommunicationStyle.mockReturnValue('auto');
  });

  it('应该使用当前会话的 active workspace 获取分支', async () => {
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(mockGetProjectRoot).not.toHaveBeenCalled();
    expect(mockUseGitBranch).toHaveBeenCalledWith('/active-workspace');
  });

  it('应该显示崩溃后恢复的 steering 指令数量', async () => {
    mockRecoveredSteeringCount.mockReturnValue(2);
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('已恢复 2 条指令');
  });

  it('应该显示当前 Session 的显式沟通风格', async () => {
    mockCommunicationStyle.mockReturnValue('pragmatic');
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Style pragmatic');
  });
});
