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
const mockPromptCacheMetrics = vi.fn<
  () => import('../../../../src/api/promptCacheMetrics.js').PromptCacheMetrics
>(() => ({
  hitRate: undefined,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  uncachedInputTokens: 0,
  totalInputTokens: 0,
}));
const mockSessionCostMetrics = vi.fn(() => ({
  estimatedCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}));
const mockProviderRecovery = vi.fn<
  () =>
    | import('../../../../src/api/providerRecoverySchemas.js').ProviderRecoveryProjection
    | null
>(() => null);
const mockTaskAttentionStatus = vi.fn(() => 'idle');
const mockTaskAttentionUnreadKeys = vi.fn<() => readonly string[]>(() => []);
const mockFollowUpQueue = vi.fn<
  () =>
    | import('../../../../src/api/followUpQueueSchemas.js').FollowUpQueueSnapshot
    | null
>(() => null);
const mockToolStatus = vi.fn<
  () => import('../../../../src/store/types.js').ToolStatusSnapshot | null
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
  usePromptCacheMetrics: () => mockPromptCacheMetrics(),
  useSessionCostMetrics: () => mockSessionCostMetrics(),
  useProviderRecovery: () => mockProviderRecovery(),
  useRecoveredSteeringCount: () => mockRecoveredSteeringCount(),
  useSessionCost: () => null,
  useSessionId: () => 'status-bar-session',
  useThinkingModeEnabled: () => false,
  useToolStatus: () => mockToolStatus(),
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
    mockPromptCacheMetrics.mockReturnValue({
      hitRate: undefined,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: 0,
      totalInputTokens: 0,
    });
    mockSessionCostMetrics.mockReturnValue({
      estimatedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    mockProviderRecovery.mockReturnValue(null);
    mockTaskAttentionStatus.mockReturnValue('idle');
    mockTaskAttentionUnreadKeys.mockReturnValue([]);
    mockFollowUpQueue.mockReturnValue(null);
    mockToolStatus.mockReturnValue(null);
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

  it('应该在状态栏显示同口径缓存命中率并附带 token 细分', async () => {
    mockPromptCacheMetrics.mockReturnValue({
      hitRate: 0.6,
      cacheReadTokens: 3_200,
      cacheWriteTokens: 1_000,
      uncachedInputTokens: 2_133,
      totalInputTokens: 5_333,
    });
    mockSessionCostMetrics.mockReturnValue({
      estimatedCostUsd: 0.042,
      inputTokens: 5_333,
      outputTokens: 800,
      totalTokens: 6_133,
      cacheReadTokens: 3_200,
      cacheWriteTokens: 1_000,
    });
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Cache 60%');
    expect(markup).toContain('r 3.2K');
    expect(markup).toContain('w 1.0K');
    expect(markup).toContain('5.3K in');
    expect(markup).toContain('800 out');
    expect(markup).toContain('$0.042');
  });

  it('Provider 未回报缓存用量时应该显示空值且不带 token 细分', async () => {
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

  it('显示 Goal execution-host failure 的有界状态', async () => {
    const { formatGoalExecutionHostFailureStatus } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    expect(
      formatGoalExecutionHostFailureStatus({
        category: 'spawn',
        consecutiveCount: 2,
        detectedAt: '2026-09-06T00:00:00.000Z',
      })
    ).toBe('exec-host:spawn:2');
    expect(formatGoalExecutionHostFailureStatus(undefined)).toBe('');
  });

  it('格式化有界 Goal turn lineage 且缺失 root 时显示问号', async () => {
    const { formatGoalTurnLineageStatus } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    expect(
      formatGoalTurnLineageStatus({
        rootTurnId: 'root-turn-123456',
        currentTurnId: 'current-turn-987654',
        parentTurnId: 'parent-turn-abcdef',
      })
    ).toBe('lineage:root-tur:current-');
    expect(
      formatGoalTurnLineageStatus({
        currentTurnId: 'current-turn-987654',
        parentTurnId: 'parent-turn-abcdef',
      })
    ).toBe('lineage:?:current-');
    expect(formatGoalTurnLineageStatus(undefined)).toBe('');
  });

  it('显示已注册工具数、禁用数与最近失败工具', async () => {
    mockToolStatus.mockReturnValue({
      registeredCount: 12,
      builtinCount: 10,
      mcpCount: 2,
      disabledNames: ['Bash', 'Edit'],
      recentFailures: [
        {
          toolName: 'Write',
          at: 1_700_000_000_000,
          errorType: 'execution_error',
        },
      ],
    });
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Tools 12');
    expect(markup).toContain('off 2');
    expect(markup).toContain('fail Write');
  });

  it('无禁用与失败时只显示工具总数', async () => {
    mockToolStatus.mockReturnValue({
      registeredCount: 14,
      builtinCount: 14,
      mcpCount: 0,
      disabledNames: [],
      recentFailures: [],
    });
    const { ChatStatusBar } = await import(
      '../../../../src/ui/components/ChatStatusBar.js'
    );

    const markup = renderToStaticMarkup(React.createElement(ChatStatusBar));

    expect(markup).toContain('Tools 14');
    expect(markup).not.toContain('off ');
    expect(markup).not.toContain('fail ');
  });
});
