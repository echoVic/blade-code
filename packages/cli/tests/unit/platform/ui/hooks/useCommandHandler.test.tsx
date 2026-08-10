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
    executeUserShellCommand: vi.fn(),
    processSlashCommand: vi.fn(),
    abort: vi.fn(),
    hasPendingInbox: vi.fn(),
    hasActiveGoal: vi.fn(),
    enqueueCommand: vi.fn(),
    addUserMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    addMessage: vi.fn(),
    setCommand: vi.fn(),
    isProcessing: false,
    storeProcessing: false,
    setProcessing: vi.fn(),
    clearAbortController: vi.fn(),
    setCurrentThinkingContent: vi.fn(),
    resetStreamingBuffers: vi.fn(),
    clearFinalizingStreamingMessageId: vi.fn(),
  };
});

vi.mock('../../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    hasPendingInbox: mocks.hasPendingInbox,
    hasActiveGoal: mocks.hasActiveGoal,
  },
}));

vi.mock('../../../../../src/ui/hooks/useAgent.js', () => ({
  useAgent: () => ({
    createAgent: mocks.createAgent,
    cleanupAgent: mocks.cleanupAgent,
    steerActiveTurn: mocks.steerActiveTurn,
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
  useSessionActions: () => ({
    clearFinalizingStreamingMessageId: mocks.clearFinalizingStreamingMessageId,
    setCurrentThinkingContent: mocks.setCurrentThinkingContent,
    addAssistantMessage: mocks.addAssistantMessage,
    addUserMessage: mocks.addUserMessage,
    addMessage: mocks.addMessage,
    setCommand: mocks.setCommand,
    setError: vi.fn(),
  }),
  useAppActions: () => ({
    setTasks: vi.fn(),
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
  createLoopEventHandler: () => vi.fn(),
}));

vi.mock('../../../../../src/ui/utils/slashCommandRouter.js', () => ({
  processSlashCommand: mocks.processSlashCommand,
}));

vi.mock('../../../../../src/ui/utils/sessionContext.js', () => ({
  buildContextMessagesFromSession: () => [],
}));

import { useCommandHandler } from '../../../../../src/ui/hooks/useCommandHandler.js';

describe('useCommandHandler durable recovery', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let hook: ReturnType<typeof useCommandHandler> | undefined;

  function Harness() {
    hook = useCommandHandler();
    return null;
  }

  beforeEach(() => {
    mocks.isProcessing = false;
    mocks.storeProcessing = false;
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
});
