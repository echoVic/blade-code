/**
 * slashCommandRouter — processSlashCommand 单元测试
 *
 * 覆盖 plan.md 中的 4 个中优先级 slash 命令语义场景：
 * 1. /custom-cmd args — UI 显示原始命令，Agent 收到展开后的 prompt
 * 2. /plugin:cmd args — UI 显示原始命令，Agent 收到展开后的 prompt
 * 3. /skill-name args — UI 显示和 Agent 输入都是改写后的 skill prompt
 * 4. invoke_once_model — 正确传递 onceModelId
 *
 * 同时覆盖：
 * - 非 slash 命令直接返回 not_slash
 * - UI 消息路由（show_model_selector 等）
 * - 错误处理
 * - 类型守卫函数
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSurfaceSummary } from '../../../../../src/api/sessionSurfaceSchemas.js';
import type { SessionMetadata } from '../../../../../src/services/SessionService.js';
import type { AppActions, SessionActions } from '../../../../../src/store/types.js';
import {
  getState,
  sessionActions as realSessionActions,
} from '../../../../../src/store/vanilla.js';
import type { ResolvedInput } from '../../../../../src/ui/hooks/useInputBuffer.js';
import {
  isInvokeCustomCommandAction,
  isInvokeOnceModelAction,
  isInvokePluginCommandAction,
  isInvokeSkillAction,
  isSessionSelectionAction,
  processSlashCommand,
  type SlashRouteResult,
} from '../../../../../src/ui/utils/slashCommandRouter.js';

// Mock slash-commands 模块
vi.mock('../../../../../src/slash-commands/index.js', () => ({
  isSlashCommand: vi.fn((input: string) => input.trim().startsWith('/')),
  executeSlashCommand: vi.fn(),
}));

// Mock GracefulShutdown
vi.mock('../../../../../src/services/GracefulShutdown.js', () => ({
  safeExit: vi.fn(),
}));

const sessionServiceMocks = vi.hoisted(() => ({
  archiveSession: vi.fn(),
}));

vi.mock('../../../../../src/services/SessionService.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../src/services/SessionService.js')
  >('../../../../../src/services/SessionService.js');
  return {
    ...actual,
    SessionService: {
      archiveSession: sessionServiceMocks.archiveSession,
    },
  };
});

const activationMocks = vi.hoisted(() => ({
  activateSessionSelection: vi.fn(),
}));

vi.mock('../../../../../src/ui/utils/sessionActivation.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../src/ui/utils/sessionActivation.js')
  >('../../../../../src/ui/utils/sessionActivation.js');
  return {
    ...actual,
    activateSessionSelection: activationMocks.activateSessionSelection,
  };
});

// ==================== 测试工具 ====================

function createResolvedInput(text: string): ResolvedInput {
  return {
    displayText: text,
    text,
    images: [],
    parts: [{ type: 'text', text }],
  };
}

function createSessionMetadata(
  overrides: Partial<SessionMetadata> = {}
): SessionMetadata {
  return {
    sessionId: 'parent-session',
    projectPath: '/workspace/a',
    gitBranch: 'main',
    rootId: 'root-parent',
    parentId: undefined,
    relationType: undefined,
    title: 'Parent Session',
    agentType: 'default',
    model: 'gpt-5',
    taskStatus: 'completed',
    messageCount: 12,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

function createLocalSurfaceSummary(metadata: SessionMetadata): SessionSurfaceSummary {
  return {
    locator: {
      version: 2,
      sessionId: metadata.sessionId,
      workspace: { kind: 'local', projectPath: metadata.projectPath },
    },
    displayCwd: metadata.projectPath,
    title: metadata.title,
    rootId: metadata.rootId,
    parentId: metadata.parentId,
    relationType: metadata.relationType,
    taskStatus: metadata.taskStatus,
    messageCount: metadata.messageCount,
    firstMessageTime: metadata.firstMessageTime,
    lastMessageTime: metadata.lastMessageTime,
    hasErrors: metadata.hasErrors,
    archivedAt: metadata.archivedAt,
    selectedModelId: metadata.selectedModelId,
    capabilities: {
      connection: 'local',
      history: { read: true, fork: metadata.archivedAt === undefined },
      turn: metadata.archivedAt
        ? { start: false, reason: 'archived' }
        : { start: true },
      files: metadata.archivedAt
        ? { readText: false, writeText: false, browse: 'none', reason: 'archived' }
        : { readText: true, writeText: true, browse: 'tree' },
      terminal: metadata.archivedAt
        ? { mode: 'none', owner: 'none', reason: 'archived' }
        : { mode: 'interactive', owner: 'local' },
    },
  };
}

function _createRemoteSurfaceSummary(): SessionSurfaceSummary {
  return {
    ...createLocalSurfaceSummary(createSessionMetadata()),
    locator: {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: `acp-remote-workspace:${'R'.repeat(43)}`,
      },
    },
    displayCwd: 'C:\\Remote\\Repo',
    capabilities: {
      connection: 'offline',
      history: { read: true, fork: true },
      turn: { start: false, reason: 'history-only' },
      files: {
        readText: false,
        writeText: false,
        browse: 'none',
        reason: 'history-only',
      },
      terminal: { mode: 'none', owner: 'none', reason: 'history-only' },
    },
  };
}

function createMockAppActions(): AppActions {
  return {
    setInitializationStatus: vi.fn(),
    setInitializationError: vi.fn(),
    setActiveModal: vi.fn(),
    showSessionSelector: vi.fn(),
    showSessionHistoryViewer: vi.fn(),
    showModelEditWizard: vi.fn(),
    closeModal: vi.fn(),
    setTasks: vi.fn(),
    updateTask: vi.fn(),
    setAwaitingSecondCtrlC: vi.fn(),
    projectTaskAttentionState: vi.fn(),
    projectFollowUpQueue: vi.fn(),
    claimFollowUpQueueOwner: vi.fn(),
    setFollowUpQueueMutation: vi.fn(),
    clearFollowUpQueue: vi.fn(),
    setReasoningEffort: vi.fn(),
    setServiceTier: vi.fn(),
    setResponseVerbosity: vi.fn(),
    setCommunicationStyle: vi.fn(),
    setThinkingModeEnabled: vi.fn(),
    toggleThinkingMode: vi.fn(),
    startSubagentProgress: vi.fn(),
    updateSubagentTool: vi.fn(),
    completeSubagentProgress: vi.fn(),
    startSideConversation: vi.fn(),
    completeSideConversation: vi.fn(),
    failSideConversation: vi.fn(),
    dismissSideConversation: vi.fn(),
    setTeams: vi.fn(),
  } satisfies AppActions;
}

function createMockSessionActions(): SessionActions {
  return {
    addMessage: vi.fn(),
    addUserMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    replaceLastAssistantMessage: vi.fn(),
    addAssistantMessageAndClearThinking: vi.fn(),
    addToolMessage: vi.fn(),
    setCompacting: vi.fn(),
    setCommand: vi.fn(),
    clearMessages: vi.fn(),
    setCompactedContext: vi.fn(),
    setError: vi.fn(),
    resetSession: vi.fn(),
    restoreSession: vi.fn(),
    updateTokenUsage: vi.fn(),
    resetContextUsage: vi.fn(),
    resetTokenUsage: vi.fn(),
    setCurrentThinkingContent: vi.fn(),
    appendThinkingContent: vi.fn(),
    setThinkingExpanded: vi.fn(),
    toggleThinkingExpanded: vi.fn(),
    setHistoryExpanded: vi.fn(),
    toggleHistoryExpanded: vi.fn(),
    setExpandedMessageCount: vi.fn(),
    incrementClearCount: vi.fn(),
    startStreamingAssistantMessage: vi.fn(() => 'streaming-message'),
    appendAssistantContent: vi.fn(() => 'streaming-content'),
    finalizeStreamingMessage: vi.fn(),
    clearFinalizingStreamingMessageId: vi.fn(),
    discardStreamingMessage: vi.fn(),
    setProviderAdmission: vi.fn(),
    setProviderCircuit: vi.fn(),
    setProviderRetry: vi.fn(),
    setProviderStall: vi.fn(),
    setProviderRecovery: vi.fn(),
    setTurnActivity: vi.fn(),
    setActionStationarity: vi.fn(),
    applyCommittedEvent: vi.fn(),
    applyStreamingDelta: vi.fn(),
    resetConversationProjection: vi.fn(),
  } satisfies SessionActions;
}

// ==================== 测试 ====================

describe('processSlashCommand', () => {
  let executeSlashCommand: ReturnType<typeof vi.fn>;
  const cleanupAgent = vi.fn<() => Promise<void>>();

  beforeEach(async () => {
    const slashModule = await import('../../../../../src/slash-commands/index.js');
    executeSlashCommand = vi.mocked(slashModule.executeSlashCommand);
    executeSlashCommand.mockReset();
    activationMocks.activateSessionSelection.mockReset();
    sessionServiceMocks.archiveSession.mockReset();
    cleanupAgent.mockReset();
    cleanupAgent.mockResolvedValue(undefined);
  });

  // ==================== 非 slash 命令 ====================

  describe('非 slash 命令', () => {
    it('非 / 开头的输入应该返回 not_slash', async () => {
      const result = await processSlashCommand(
        createResolvedInput('hello world'),
        createMockAppActions(),
        createMockSessionActions(),
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('not_slash');
    });
  });

  describe('session context', () => {
    it('应将当前 session ID 传给 slash command handler', async () => {
      executeSlashCommand.mockResolvedValue({ success: true });
      const ownedMessages = [{ role: 'user' as const, content: 'owned history' }];

      await processSlashCommand(
        createResolvedInput('/tasks'),
        createMockAppActions(),
        createMockSessionActions(),
        new AbortController().signal,
        async () => undefined,
        'session-owner',
        ownedMessages
      );

      expect(executeSlashCommand).toHaveBeenCalledWith(
        '/tasks',
        expect.objectContaining({
          sessionId: 'session-owner',
          workspaceRoot: expect.any(String),
          messages: ownedMessages,
        })
      );
    });

    it('取消手动压缩只累计已返回用量，不替换或重置上下文', async () => {
      executeSlashCommand.mockResolvedValueOnce({
        success: false,
        message: 'compact_cancelled',
        data: {
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          maxContextTokens: 128000,
        },
      });
      const sessionActions = createMockSessionActions();
      const controller = new AbortController();
      controller.abort();
      const result = await processSlashCommand(
        createResolvedInput('/compact'),
        createMockAppActions(),
        sessionActions,
        controller.signal,
        async () => undefined,
        'session-owner'
      );
      expect(result).toMatchObject({
        type: 'handled',
        commandResult: { success: false },
      });
      expect(sessionActions.updateTokenUsage).toHaveBeenCalledOnce();
      expect(sessionActions.updateTokenUsage).toHaveBeenCalledWith({
        scope: 'auxiliary',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        maxContextTokens: 128000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: undefined,
      });
      expect(sessionActions.setCompactedContext).not.toHaveBeenCalled();
      expect(sessionActions.resetContextUsage).not.toHaveBeenCalled();
      expect(sessionActions.addAssistantMessage).not.toHaveBeenCalled();
    });

    it('手动压缩后应接管下一轮模型上下文', async () => {
      const compactedMessages = [
        { role: 'user' as const, content: 'compacted summary' },
      ];
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'compact_completed',
        data: {
          compactedMessages,
          maxContextTokens: 128000,
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 10,
            costUsd: 0.125,
          },
        },
      });
      const sessionActions = createMockSessionActions();

      const result = await processSlashCommand(
        createResolvedInput('/compact'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        async () => undefined,
        'session-owner'
      );

      expect(result).toEqual({
        type: 'handled',
        commandResult: { success: true },
      });
      expect(sessionActions.setCompactedContext).toHaveBeenCalledWith(
        compactedMessages
      );
      expect(sessionActions.updateTokenUsage).toHaveBeenCalledWith({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        maxContextTokens: 128000,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        costUsd: 0.125,
      });
      expect(sessionActions.resetContextUsage).toHaveBeenCalledOnce();
    });
  });

  // ==================== 场景 1: invoke_custom_command ====================

  describe('/custom-cmd — UI 显示原始命令，Agent 收到展开后的 prompt', () => {
    it('应该分离 UI 显示和 Agent 输入', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_custom_command',
          commandName: 'deploy',
          processedContent: 'Run the deployment pipeline with staging config',
          config: {},
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/deploy staging'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      // UI 显示原始命令
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith('/deploy staging');
      expect(result.result.userDisplayMessage).toBe('/deploy staging');
      expect(result.result.userMessageAlreadyAdded).toBe(true);

      // Agent 收到展开后的 prompt（不同于 UI 显示）
      expect(result.result.agentInput.text).toContain('Custom Command: /deploy');
      expect(result.result.agentInput.text).toContain('Run the deployment pipeline');
      expect(result.result.agentInput.text).not.toBe('/deploy staging');
    });
  });

  // ==================== 场景 3: invoke_skill ====================

  describe('/skill-name — UI 和 Agent 都是改写后的 skill prompt', () => {
    it('有参数时应该生成带参数的 skill prompt', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_skill',
          skillName: 'code-review',
          skillArgs: 'review the last commit',
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/code-review review the last commit'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      // UI 显示和 Agent 输入都是改写后的 skill prompt
      const expectedPrompt =
        'Please use the "code-review" skill to help me with: review the last commit';
      expect(result.result.userDisplayMessage).toBe(expectedPrompt);
      expect(result.result.agentInput.text).toBe(expectedPrompt);
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith(expectedPrompt);
      expect(result.result.userMessageAlreadyAdded).toBe(true);
    });

    it('无参数时应该生成简短 skill prompt', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_skill',
          skillName: 'tdd',
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/tdd'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      expect(result.result.userDisplayMessage).toBe('Please use the "tdd" skill.');
      expect(result.result.agentInput.text).toBe('Please use the "tdd" skill.');
    });
  });

  // ==================== 场景 4: invoke_once_model ====================

  describe('invoke_once_model — 正确传递 onceModelId', () => {
    it('应该设置 onceModelId', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_once_model',
          modelId: 'gpt-4o',
          prompt: 'explain this code',
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/model gpt-4o explain this code'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      expect(result.result.onceModelId).toBe('gpt-4o');
      expect(result.result.agentInput.text).toBe('explain this code');
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith('explain this code');
    });
  });

  // ==================== UI 消息路由 ====================

  describe('UI 消息路由', () => {
    it('show_follow_up_queue 应该打开 queue modal', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'show_follow_up_queue',
        data: { action: 'show_follow_up_queue' },
      });
      const appActions = createMockAppActions();

      const result = await processSlashCommand(
        createResolvedInput('/queue'),
        appActions,
        createMockSessionActions(),
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('handled');
      expect(appActions.setActiveModal).toHaveBeenCalledWith('followUpQueue');
    });

    it('show_model_selector 应该返回 handled', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'show_model_selector',
      });

      const appActions = createMockAppActions();
      const result = await processSlashCommand(
        createResolvedInput('/model'),
        appActions,
        createMockSessionActions(),
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('handled');
      expect(appActions.setActiveModal).toHaveBeenCalledWith('modelSelector');
    });

    it('clear_screen 应该清空消息和重置状态', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'clear_screen',
      });

      const sessionActions = createMockSessionActions();
      const appActions = createMockAppActions();
      const result = await processSlashCommand(
        createResolvedInput('/clear'),
        appActions,
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('handled');
      expect(sessionActions.clearMessages).toHaveBeenCalled();
      expect(sessionActions.setError).toHaveBeenCalledWith(null);
      expect(sessionActions.resetTokenUsage).toHaveBeenCalled();
      expect(appActions.setTasks).toHaveBeenCalledWith([]);
    });

    it('rewind_session 应该原子替换当前会话历史', async () => {
      const rawMessages = [{ role: 'user' as const, content: 'kept raw' }];
      const visibleMessages = [
        {
          id: 'visible-1',
          role: 'user' as const,
          content: 'kept visible',
          timestamp: 1,
        },
      ];
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'rewind_session',
          sessionId: 'session-owner',
          messages: rawMessages,
          visibleMessages,
        },
      });
      const sessionActions = createMockSessionActions();
      const appActions = createMockAppActions();

      const result = await processSlashCommand(
        createResolvedInput('/rewind user-2'),
        appActions,
        sessionActions,
        new AbortController().signal,
        cleanupAgent,
        'session-owner',
        [],
        {
          listCheckpoints: vi.fn(),
          execute: vi.fn(),
        }
      );

      expect(result).toEqual({
        type: 'handled',
        commandResult: { success: true },
      });
      expect(sessionActions.restoreSession).toHaveBeenCalledWith(
        'session-owner',
        visibleMessages,
        rawMessages
      );
      expect(appActions.setTasks).toHaveBeenCalledWith([]);
    });

    it('structured activate_session action should delegate to activateSessionSelection', async () => {
      const session = createSessionMetadata();
      activationMocks.activateSessionSelection.mockResolvedValue({
        sessionId: session.sessionId,
        messages: [],
        projectPath: session.projectPath,
      });
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'activate_session',
          intent: 'fork',
          session,
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/fork parent-session'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(result).toEqual({
        type: 'handled',
        commandResult: { success: true },
      });
      expect(activationMocks.activateSessionSelection).toHaveBeenCalledWith(
        { action: 'activate_session', intent: 'fork', session },
        process.cwd(),
        sessionActions,
        cleanupAgent
      );
    });

    it('acknowledges an exact local resume only after activation commits', async () => {
      const session = createSessionMetadata();
      const summary = createLocalSurfaceSummary(session);
      const acknowledge = vi.fn(async (_summary: SessionSurfaceSummary) => undefined);
      activationMocks.activateSessionSelection.mockResolvedValue({
        sessionId: session.sessionId,
        messages: [],
        projectPath: session.projectPath,
      });
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: { action: 'activate_session', intent: 'resume', session },
      });

      await processSlashCommand(
        createResolvedInput('/resume parent-session'),
        createMockAppActions(),
        createMockSessionActions(),
        new AbortController().signal,
        cleanupAgent,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        process.cwd(),
        undefined,
        { list: async () => [summary], acknowledge }
      );

      expect(activationMocks.activateSessionSelection).toHaveBeenCalledOnce();
      expect(acknowledge).toHaveBeenCalledWith(summary);
      expect(
        activationMocks.activateSessionSelection.mock.invocationCallOrder[0]
      ).toBeLessThan(acknowledge.mock.invocationCallOrder[0]!);
    });

    it('does not route failed structured activate_session results as handled success', async () => {
      const session = createSessionMetadata();
      executeSlashCommand.mockResolvedValue({
        success: false,
        error: 'blocked',
        data: {
          action: 'activate_session',
          intent: 'fork',
          session,
        },
      });

      const appActions = createMockAppActions();
      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/fork parent-session'),
        appActions,
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(appActions.showSessionSelector).not.toHaveBeenCalled();
      expect(activationMocks.activateSessionSelection).not.toHaveBeenCalled();
      expect(sessionActions.addAssistantMessage).toHaveBeenCalledWith('blocked');
      expect(result).toEqual({
        type: 'handled',
        commandResult: {
          success: false,
          output: undefined,
          error: 'blocked',
          metadata: {
            action: 'activate_session',
            intent: 'fork',
            session,
          },
        },
      });
    });

    it('legacy show_session_selector messages remain compatible with default resume intent', async () => {
      const sessions = [createSessionMetadata()];
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'show_session_selector',
        data: { sessions },
      });

      const appActions = createMockAppActions();
      const result = await processSlashCommand(
        createResolvedInput('/resume'),
        appActions,
        createMockSessionActions(),
        new AbortController().signal,
        cleanupAgent
      );

      expect(result).toEqual({
        type: 'handled',
        commandResult: { success: true },
      });
      expect(appActions.showSessionSelector).toHaveBeenCalledWith(
        sessions.map(createLocalSurfaceSummary),
        'resume'
      );
    });
  });

  // ==================== 错误处理 ====================

  describe('错误处理', () => {
    it('成功的 slash command 有 message 时应该显示', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'Help content displayed',
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/help'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        cleanupAgent
      );

      expect(result.type).toBe('handled');
      expect(sessionActions.addAssistantMessage).toHaveBeenCalledWith(
        'Help content displayed'
      );
    });
  });
});

// ==================== 类型守卫测试 ====================

describe('类型守卫函数', () => {
  describe('isSessionSelectionAction', () => {
    const session = createSessionMetadata();

    it('rejects unknown actions and missing required fields', () => {
      expect(
        isSessionSelectionAction({
          action: 'select_session',
          sessions: [session],
        })
      ).toBe(false);
      expect(
        isSessionSelectionAction({
          action: 'activate_session',
          intent: 'fork',
        })
      ).toBe(false);
      expect(
        isSessionSelectionAction({
          action: 'unknown',
          intent: 'fork',
          sessions: [session],
        })
      ).toBe(false);
      expect(
        isSessionSelectionAction({
          action: 'select_session',
          intent: 'fork',
          sessions: [{ sessionId: 'incomplete' }],
        })
      ).toBe(false);
    });
  });
});
