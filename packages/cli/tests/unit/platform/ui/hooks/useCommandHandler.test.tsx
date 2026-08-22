// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const abortController = new AbortController();
  return {
    abortController,
    createAgent: vi.fn(),
    cleanupAgent: vi.fn(),
    steerActiveTurn: vi.fn(),
    askSideQuestion: vi.fn(),
    getMcpContentCatalog: vi.fn(),
    refreshMcpContentCatalogs: vi.fn(),
    getMcpPrompt: vi.fn(),
    completeMcpArgument: vi.fn(),
    listMcpTasks: vi.fn(),
    getMcpTask: vi.fn(),
    cancelMcpTask: vi.fn(),
    getMcpLogs: vi.fn(),
    setMcpLoggingLevel: vi.fn(),
    getMcpInstructions: vi.fn(),
    getReasoningConfiguration: vi.fn(),
    setReasoningEffort: vi.fn(),
    getServiceTierConfiguration: vi.fn(),
    setServiceTier: vi.fn(),
    getResponseVerbosityConfiguration: vi.fn(),
    setResponseVerbosity: vi.fn(),
    getCommunicationStyleConfiguration: vi.fn(),
    setCommunicationStyle: vi.fn(),
    runCodeReview: vi.fn(),
    executeUserShellCommand: vi.fn(),
    processSlashCommand: vi.fn(),
    abort: vi.fn(),
    hasPendingInbox: vi.fn(),
    hasActiveGoal: vi.fn(),
    resolvePendingWithHandler: vi.fn(),
    cancelPendingNonInteractive: vi.fn(),
    enqueueCommand: vi.fn(),
    addUserMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    addMessage: vi.fn(),
    updateTokenUsage: vi.fn(),
    setCommand: vi.fn(),
    setCompactedContext: vi.fn(),
    startSideConversation: vi.fn(),
    completeSideConversation: vi.fn(),
    failSideConversation: vi.fn(),
    dismissSideConversation: vi.fn(),
    sideConversation: null as {
      requestId: string;
      question: string;
      status: 'loading' | 'completed' | 'error';
    } | null,
    isProcessing: false,
    storeProcessing: false,
    setProcessing: vi.fn(),
    clearAbortController: vi.fn(),
    setCurrentThinkingContent: vi.fn(),
    resetStreamingBuffers: vi.fn(),
    clearFinalizingStreamingMessageId: vi.fn(),
    buildContextMessagesFromSession: vi.fn<
      (_session: unknown) => Array<{ role: string; content: string }>
    >(() => []),
  };
});

vi.mock('../../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    hasPendingInbox: mocks.hasPendingInbox,
    hasActiveGoal: mocks.hasActiveGoal,
  },
}));

vi.mock('../../../../../src/services/SessionInteractionService.js', () => ({
  SessionInteractionService: {
    resolvePendingWithHandler: mocks.resolvePendingWithHandler,
    cancelPendingNonInteractive: mocks.cancelPendingNonInteractive,
  },
}));

vi.mock('../../../../../src/ui/hooks/useAgent.js', () => ({
  useAgent: () => ({
    createAgent: mocks.createAgent,
    cleanupAgent: mocks.cleanupAgent,
    steerActiveTurn: mocks.steerActiveTurn,
    askSideQuestion: mocks.askSideQuestion,
    getMcpContentCatalog: mocks.getMcpContentCatalog,
    refreshMcpContentCatalogs: mocks.refreshMcpContentCatalogs,
    getMcpPrompt: mocks.getMcpPrompt,
    completeMcpArgument: mocks.completeMcpArgument,
    listMcpTasks: mocks.listMcpTasks,
    getMcpTask: mocks.getMcpTask,
    cancelMcpTask: mocks.cancelMcpTask,
    getMcpLogs: mocks.getMcpLogs,
    setMcpLoggingLevel: mocks.setMcpLoggingLevel,
    getMcpInstructions: mocks.getMcpInstructions,
    getReasoningConfiguration: mocks.getReasoningConfiguration,
    setReasoningEffort: mocks.setReasoningEffort,
    getServiceTierConfiguration: mocks.getServiceTierConfiguration,
    setServiceTier: mocks.setServiceTier,
    getResponseVerbosityConfiguration: mocks.getResponseVerbosityConfiguration,
    setResponseVerbosity: mocks.setResponseVerbosity,
    getCommunicationStyleConfiguration: mocks.getCommunicationStyleConfiguration,
    setCommunicationStyle: mocks.setCommunicationStyle,
    runCodeReview: mocks.runCodeReview,
    executeUserShellCommand: mocks.executeUserShellCommand,
  }),
}));

vi.mock('../../../../../src/store/selectors/index.js', () => ({
  useIsProcessing: () => mocks.isProcessing,
  useSessionId: () => 'recovered-cli-session',
  useWorkspaceRoot: () => '/active-workspace',
  useCurrentModelId: () => 'model-1',
  usePermissionMode: () => 'default',
  useThinkingModeEnabled: () => false,
  useReasoningEffort: () => 'off',
  useServiceTier: () => 'auto',
  useResponseVerbosity: () => 'auto',
  useCommunicationStyle: () => 'auto',
  useSideConversation: () => mocks.sideConversation,
  useSessionActions: () => ({
    clearFinalizingStreamingMessageId: mocks.clearFinalizingStreamingMessageId,
    setCurrentThinkingContent: mocks.setCurrentThinkingContent,
    addAssistantMessage: mocks.addAssistantMessage,
    addUserMessage: mocks.addUserMessage,
    addMessage: mocks.addMessage,
    setCommand: mocks.setCommand,
    setCompactedContext: mocks.setCompactedContext,
    updateTokenUsage: mocks.updateTokenUsage,
    setError: vi.fn(),
  }),
  useAppActions: () => ({
    setTasks: vi.fn(),
    startSideConversation: mocks.startSideConversation,
    completeSideConversation: mocks.completeSideConversation,
    failSideConversation: mocks.failSideConversation,
    dismissSideConversation: mocks.dismissSideConversation,
  }),
  useCommandActions: () => ({
    createAbortController: vi.fn(() => mocks.abortController),
    getAbortController: vi.fn(() => mocks.abortController),
    clearAbortController: mocks.clearAbortController,
    setProcessing: mocks.setProcessing,
    setRecoveredSteeringCount: vi.fn(),
    enqueueCommand: mocks.enqueueCommand,
    abort: mocks.abort,
  }),
}));

vi.mock('../../../../../src/store/vanilla.js', () => ({
  ensureStoreInitialized: vi.fn().mockResolvedValue(undefined),
  getState: () => ({
    command: { isProcessing: mocks.storeProcessing },
    session: {
      messages: [],
      restoredContextMessages: [],
      restoredContextMessageCount: 0,
      currentStreamingMessageId: null,
    },
  }),
}));

vi.mock('../../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: () => ({
      executeUserPromptSubmitHooks: vi.fn().mockResolvedValue({
        proceed: true,
      }),
    }),
  },
}));

vi.mock('../../../../../src/ui/hooks/useStreamingBuffer.js', () => ({
  useStreamingBuffer: () => ({
    resetStreamingBuffers: mocks.resetStreamingBuffers,
    drainPendingBuffers: vi.fn(() => ({
      extraContent: '',
      extraThinking: '',
    })),
    batchAppendContent: vi.fn(),
    batchAppendThinking: vi.fn(),
  }),
}));

vi.mock('../../../../../src/ui/utils/loopEventHandler.js', () => ({
  createLoopEventHandler:
    (
      _deps: unknown,
      stats: {
        compactionCount?: number;
      }
    ) =>
    (event: { kind?: string; phase?: string; outcome?: string }) => {
      if (
        event.kind === 'compaction' &&
        event.phase === 'end' &&
        event.outcome !== 'failed'
      ) {
        stats.compactionCount = (stats.compactionCount ?? 0) + 1;
      }
    },
}));

vi.mock('../../../../../src/ui/utils/slashCommandRouter.js', () => ({
  processSlashCommand: mocks.processSlashCommand,
}));

vi.mock('../../../../../src/ui/utils/sessionContext.js', () => ({
  buildContextMessagesFromSession: mocks.buildContextMessagesFromSession,
}));

import { useCommandHandler } from '../../../../../src/ui/hooks/useCommandHandler.js';

describe('useCommandHandler durable recovery', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let hook: ReturnType<typeof useCommandHandler> | undefined;
  const confirmationHandler = {
    requestConfirmation: vi.fn(),
  };

  function Harness() {
    hook = useCommandHandler(undefined, undefined, confirmationHandler as never);
    return null;
  }

  beforeEach(() => {
    mocks.isProcessing = false;
    mocks.storeProcessing = false;
    mocks.sideConversation = null;
    mocks.askSideQuestion.mockResolvedValue({
      response: 'Side answer',
      durationMs: 12,
    });
    mocks.steerActiveTurn.mockResolvedValue({
      accepted: true,
      queued: 1,
      delivery: 'next_turn',
    });
    mocks.processSlashCommand.mockResolvedValue({
      type: 'handled',
      commandResult: { success: true },
    });
    mocks.hasPendingInbox.mockResolvedValue(true);
    mocks.hasActiveGoal.mockResolvedValue(false);
    mocks.resolvePendingWithHandler.mockResolvedValue(true);
    mocks.cancelPendingNonInteractive.mockResolvedValue(false);
    mocks.buildContextMessagesFromSession.mockReset().mockReturnValue([]);
    mocks.createAgent.mockResolvedValue({
      chatStream: vi.fn(async function* (
        _message: string,
        _context: unknown,
        options: {
          pendingInputOnly?: boolean;
          goalContinuationOnly?: boolean;
        }
      ) {
        if (Date.now() < 0) yield undefined;
        return {
          success: true,
          finalMessage: 'resumed',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
          options,
        };
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('auto-starts a pending-only turn when the CLI session mounts', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.createAgent).toHaveBeenCalledOnce();
    });

    const agent = await mocks.createAgent.mock.results[0]?.value;
    expect(agent.chatStream).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        sessionId: 'recovered-cli-session',
      }),
      expect.objectContaining({
        pendingInputOnly: true,
        stream: true,
      })
    );
    expect(mocks.setProcessing).toHaveBeenNthCalledWith(1, true);
    expect(mocks.setProcessing).toHaveBeenLastCalledWith(false);
    expect(mocks.resolvePendingWithHandler).toHaveBeenCalledWith(
      '/active-workspace',
      'recovered-cli-session',
      confirmationHandler
    );
    expect(mocks.resolvePendingWithHandler.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hasPendingInbox.mock.invocationCallOrder[0]!
    );
  });

  it('retains the compacted model context after an automatic recovery', async () => {
    const replacement = [{ role: 'user', content: 'durable summary' }];
    mocks.createAgent.mockResolvedValueOnce({
      chatStream: vi.fn(async function* (
        _message: string,
        context: { messages: typeof replacement }
      ) {
        yield {
          kind: 'compaction',
          phase: 'start',
          reason: 'context_limit',
        };
        context.messages.push(...replacement);
        yield {
          kind: 'compaction',
          phase: 'end',
          reason: 'context_limit',
          strategy: 'llm',
          outcome: 'completed',
        };
        return {
          success: true,
          finalMessage: 'resumed',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      }),
    });

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mocks.setCompactedContext).toHaveBeenCalledWith(replacement);
    });
  });

  it('shows a typed non-abort failure from automatic pending recovery', async () => {
    mocks.createAgent.mockResolvedValueOnce({
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return {
          success: false,
          error: {
            type: 'intent_fulfillment_failed',
            message: 'Recovered turn still produced an empty final response.',
          },
          metadata: {
            turnsCount: 1,
            toolCallsCount: 1,
            duration: 1,
            outputTruncated: true,
          },
        };
      }),
    });

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
        'Recovered turn still produced an empty final response.'
      );
    });
    expect(mocks.addAssistantMessage).toHaveBeenCalledTimes(1);
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith(
      '输出因达到 token 上限被截断，部分内容可能不完整。'
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith('已取消');
  });

  it('does not show a canceled failure from automatic pending recovery', async () => {
    const canceledMessage = 'Recovered turn was canceled.';
    mocks.createAgent.mockResolvedValueOnce({
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return {
          success: false,
          error: {
            type: 'canceled',
            message: canceledMessage,
          },
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
        };
      }),
    });

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mocks.setProcessing).toHaveBeenLastCalledWith(false);
    });
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith(canceledMessage);
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('snapshots prior context before adding the optimistic user message', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.processSlashCommand.mockResolvedValueOnce({ type: 'not_slash' });
    const priorContext = [{ role: 'assistant', content: 'prior answer' }];
    mocks.buildContextMessagesFromSession.mockReturnValueOnce(priorContext);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      await hook?.executeCommand({
        displayText: 'current request',
        text: 'current request',
        images: [],
        parts: [{ type: 'text', text: 'current request' }],
      });
    });

    const agent = await mocks.createAgent.mock.results[0]?.value;
    expect(agent.chatStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messages: priorContext }),
      expect.any(Object)
    );
    expect(
      mocks.buildContextMessagesFromSession.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.addUserMessage.mock.invocationCallOrder[0]!);
  });

  it('returns a typed loop failure instead of reporting cancellation success', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.processSlashCommand.mockResolvedValueOnce({ type: 'not_slash' });
    mocks.createAgent.mockResolvedValueOnce({
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return {
          success: false,
          error: {
            type: 'intent_fulfillment_failed',
            message: 'The model returned an empty final response.',
          },
          metadata: {
            turnsCount: 2,
            toolCallsCount: 1,
            duration: 1,
            outputTruncated: true,
          },
        };
      }),
    });
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      await hook!.executeCommand({
        displayText: 'complete the task',
        text: 'complete the task',
        images: [],
        parts: [{ type: 'text', text: 'complete the task' }],
      });
    });

    expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
      'The model returned an empty final response.'
    );
    expect(mocks.addAssistantMessage).toHaveBeenCalledTimes(1);
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith(
      '输出因达到 token 上限被截断，部分内容可能不完整。'
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith('已取消');
  });

  it('preserves direct cancellation without showing its error message', async () => {
    const canceledMessage = 'The direct turn was canceled.';
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.processSlashCommand.mockResolvedValueOnce({ type: 'not_slash' });
    mocks.createAgent.mockResolvedValueOnce({
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return {
          success: false,
          error: {
            type: 'canceled',
            message: canceledMessage,
          },
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
        };
      }),
    });
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      await hook!.executeCommand({
        displayText: 'cancel the task',
        text: 'cancel the task',
        images: [],
        parts: [{ type: 'text', text: 'cancel the task' }],
      });
    });

    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith(canceledMessage);
    expect(mocks.addAssistantMessage).toHaveBeenCalledOnce();
    expect(mocks.addAssistantMessage).toHaveBeenCalledWith('已取消');
  });

  it('routes bang input to the Session shell without creating an Agent', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.hasActiveGoal.mockResolvedValue(false);
    mocks.executeUserShellCommand.mockResolvedValueOnce({
      executionId: 'tui-shell',
      messageId: 'shell-message',
      record: {
        version: 1,
        command: 'pwd',
        status: 'completed',
        exitCode: 0,
        durationMs: 3,
        stdout: '/active-workspace',
        stderr: '',
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        binaryOutput: false,
        truncated: false,
      },
      modelContent: '<user_shell_command>pwd</user_shell_command>',
      auxiliary: false,
    });
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      await hook?.executeCommand({
        displayText: '! pwd',
        text: '! pwd',
        images: [],
        parts: [{ type: 'text', text: '! pwd' }],
      });
    });

    expect(mocks.executeUserShellCommand).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({ signal: mocks.abortController.signal })
    );
    expect(mocks.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: '! pwd\n/active-workspace',
        metadata: {
          userShellCommand: expect.objectContaining({
            status: 'completed',
          }),
        },
      })
    );
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it('auto-starts a goal-only turn when the CLI session mounts with an active goal', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.hasActiveGoal.mockResolvedValue(true);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.createAgent).toHaveBeenCalledOnce();
    });

    const agent = await mocks.createAgent.mock.results[0]?.value;
    expect(agent.chatStream).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        sessionId: 'recovered-cli-session',
      }),
      expect.objectContaining({
        goalContinuationOnly: true,
        pendingInputOnly: false,
        stream: true,
      })
    );
    expect(mocks.setProcessing).toHaveBeenNthCalledWith(1, true);
    expect(mocks.setProcessing).toHaveBeenLastCalledWith(false);
  });

  it('does not start a Goal turn after Runtime initialization finalizes its handoff', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.hasActiveGoal
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.createAgent).toHaveBeenCalledOnce();
      expect(mocks.setProcessing).toHaveBeenLastCalledWith(false);
    });

    const agent = await mocks.createAgent.mock.results[0]?.value;
    expect(agent.chatStream).not.toHaveBeenCalled();
    expect(mocks.hasActiveGoal).toHaveBeenCalledTimes(3);
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('exposes agent cleanup to orchestration owners', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(hook?.cleanupAgent).toBe(mocks.cleanupAgent);
  });

  it('passes its runtime cleanup dependency to direct slash activation routing', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const resolved = {
      text: '/fork parent-session',
      displayText: '/fork parent-session',
      images: [],
      parts: [{ type: 'text' as const, text: '/fork parent-session' }],
    };
    await hook?.executeCommand(resolved);

    expect(mocks.processSlashCommand).toHaveBeenCalledOnce();
    expect(mocks.processSlashCommand.mock.calls[0]?.[0]).toBe(resolved);
    expect(mocks.processSlashCommand.mock.calls[0]?.[4]).toBe(mocks.cleanupAgent);
    expect(mocks.processSlashCommand.mock.calls[0]?.[9]).toEqual({
      getCatalog: mocks.getMcpContentCatalog,
      refresh: mocks.refreshMcpContentCatalogs,
      getPrompt: mocks.getMcpPrompt,
      complete: mocks.completeMcpArgument,
      listTasks: mocks.listMcpTasks,
      getTask: mocks.getMcpTask,
      cancelTask: mocks.cancelMcpTask,
      getLogs: mocks.getMcpLogs,
      setLoggingLevel: mocks.setMcpLoggingLevel,
      getInstructions: mocks.getMcpInstructions,
    });
    expect(mocks.processSlashCommand.mock.calls[0]?.[15]).toEqual({
      run: mocks.runCodeReview,
    });
  });

  it('wakes a next-turn input when the rendered processing state is stale', async () => {
    mocks.isProcessing = true;
    mocks.storeProcessing = false;
    mocks.hasPendingInbox.mockResolvedValueOnce(false).mockResolvedValue(true);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await hook?.executeCommand({
      text: 'run after the previous answer',
      displayText: 'run after the previous answer',
      images: [],
      parts: [{ type: 'text', text: 'run after the previous answer' }],
    });

    await vi.waitFor(() => {
      expect(mocks.createAgent).toHaveBeenCalledOnce();
    });
    expect(mocks.steerActiveTurn).toHaveBeenCalledWith('run after the previous answer');
    expect(mocks.enqueueCommand).toHaveBeenCalledOnce();
    expect(mocks.addUserMessage).toHaveBeenCalledWith('run after the previous answer');
  });

  it('rejects slash commands during an active turn without steering or aborting', async () => {
    mocks.isProcessing = true;
    mocks.storeProcessing = true;

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await hook?.executeCommand({
      text: '/fork parent-session',
      displayText: '/fork parent-session',
      images: [],
      parts: [{ type: 'text', text: '/fork parent-session' }],
    });

    expect(mocks.processSlashCommand).not.toHaveBeenCalled();
    expect(mocks.steerActiveTurn).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
      '活动回合中不能执行 slash command；请先停止任务或等待完成。'
    );
  });

  it('runs /btw beside an active turn without steering or changing main messages', async () => {
    mocks.isProcessing = true;
    mocks.storeProcessing = true;

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await hook?.executeCommand({
      text: '/btw what is the current failure?',
      displayText: '/btw what is the current failure?',
      images: [],
      parts: [{ type: 'text', text: '/btw what is the current failure?' }],
    });

    expect(mocks.askSideQuestion).toHaveBeenCalledWith(
      'what is the current failure?',
      expect.any(AbortSignal)
    );
    expect(mocks.startSideConversation).toHaveBeenCalledWith(
      expect.stringMatching(/^side-/),
      'what is the current failure?'
    );
    expect(mocks.completeSideConversation).toHaveBeenCalledWith(
      expect.stringMatching(/^side-/),
      expect.objectContaining({ response: 'Side answer' })
    );
    expect(mocks.steerActiveTurn).not.toHaveBeenCalled();
    expect(mocks.addUserMessage).not.toHaveBeenCalled();
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
  });
});
