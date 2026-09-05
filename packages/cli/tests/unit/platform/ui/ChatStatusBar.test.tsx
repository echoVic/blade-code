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
const mockPromptCacheHitRate = vi.fn<() => number | undefined>(() => undefined);
const mockTaskAttentionStatus = vi.fn(() => 'idle');
const mockTaskAttentionUnreadKeys = vi.fn<() => readonly string[]>(() => []);
const mockFollowUpQueue = vi.fn<
  () =>
    | import('../../../../src/api/followUpQueueSchemas.js').FollowUpQueueSnapshot
    | null
>(() => null);

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
  useFollowUpQueue: () => mockFollowUpQueue(),
  usePermissionMode: () => 'default',
  usePromptCacheHitRate: () => mockPromptCacheHitRate(),
  useRecoveredSteeringCount: () => mockRecoveredSteeringCount(),
  useSessionCost: () => null,
  useSessionId: () => 'status-bar-session',
  useThinkingModeEnabled: () => false,
  useTaskAttentionStatus: () => mockTaskAttentionStatus(),
  useTaskAttentionUnreadKeys: () => mockTaskAttentionUnreadKeys(),
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
    mockPromptCacheHitRate.mockReturnValue(undefined);
    mockTaskAttentionStatus.mockReturnValue('idle');
    mockTaskAttentionUnreadKeys.mockReturnValue([]);
    mockFollowUpQueue.mockReturnValue(null);
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

  it('显示 authoritative follow-up queue 数量和 /queue 入口', async () => {
    mockFollowUpQueue.mockReturnValue({
      version: 'a'.repeat(64),
      pending: 2,
      mutable: 2,
      locked: 0,
      internal: 0,
      items: [],
    });
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Queued 2 · /queue');
  });

  it('应该显示当前 Session 的显式沟通风格', async () => {
    mockCommunicationStyle.mockReturnValue('pragmatic');
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Style pragmatic');
  });

  it('应该在状态栏显示同口径缓存命中率', async () => {
    mockPromptCacheHitRate.mockReturnValue(0.6);
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Cache 60%');
  });

  it('Provider 未回报缓存用量时应该显示空值', async () => {
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Cache —');
  });

  it('显示有界的新任务数量，不泄露任务内容', async () => {
    mockTaskAttentionStatus.mockReturnValue('ready');
    mockTaskAttentionUnreadKeys.mockReturnValue(['first-key', 'second-key']);
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('New tasks 2 · /resume');
    expect(markup).not.toContain('first-key');
    expect(markup).not.toContain('second-key');
  });

  it('同步失败时保留旧数量并显示简洁警告', async () => {
    mockTaskAttentionStatus.mockReturnValue('error');
    mockTaskAttentionUnreadKeys.mockReturnValue(['retained-key']);
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('New tasks 1 · /resume');
    expect(markup).toContain('Task sync unavailable');
    expect(markup).not.toContain('retained-key');
  });
});
