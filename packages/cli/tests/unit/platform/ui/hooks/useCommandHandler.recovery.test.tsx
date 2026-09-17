// @vitest-environment jsdom

import { act, Suspense, startTransition } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent } from '../../../../../src/agent/loop/types.js';
import { FollowUpQueueMutationError } from '../../../../../src/agent/runtime/FollowUpQueueProjection.js';
import { stablePendingResumeRetryDelay } from '../../../../../src/agent/runtime/PendingResumeRecoveryPolicy.js';
import type { LoopResult } from '../../../../../src/agent/types.js';
import { taskFailureForCode } from '../../../../../src/context/taskFailure.js';
import type { SessionTurnRecoveryAssessment } from '../../../../../src/context/turnRecoveryAssessment.js';
import { Bus } from '../../../../../src/server/bus.js';
import { PendingResumeCoordinator } from '../../../../../src/ui/services/PendingResumeCoordinator.js';

const mocks = vi.hoisted(() => {
  return {
    abortController: new AbortController(),
    currentAbortController: null as AbortController | null,
    createAbortController: vi.fn(),
    getAbortController: vi.fn(),
    sessionId: 'recovered-cli-session',
    workspaceRoot: '/active-workspace',
    storeSessionId: 'recovered-cli-session',
    storeWorkspaceRoot: '/active-workspace',
    activeModal: 'none' as 'none' | 'sessionHistoryViewer',
    followUpQueue: null as
      | import('../../../../../src/api/followUpQueueSchemas.js').FollowUpQueueSnapshot
      | null,
    followUpQueueMutation: {
      pending: false,
    } as import('../../../../../src/store/types.js').FollowUpQueueMutationState,
    createAgent: vi.fn(),
    cleanupAgent: vi.fn(),
    steerActiveTurn: vi.fn(),
    enqueueSessionInput: vi.fn(),
    getFollowUpQueue: vi.fn(),
    mutateFollowUpQueue: vi.fn(),
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
    getTurnRecoveryAssessment: vi.fn<() => SessionTurnRecoveryAssessment>(() => ({
      state: 'none',
    })),
    projectTurnRecoveryAssessment: vi.fn(),
    processSlashCommand: vi.fn(),
    abort: vi.fn(),
    hasPendingInbox: vi.fn(),
    hasActiveGoal: vi.fn(),
    hasRecoverableTurn: vi.fn(),
    resolvePendingWithHandler: vi.fn(),
    cancelPendingNonInteractive: vi.fn(),
    rememberFollowUpPresentation: vi.fn(),
    clearFollowUpPresentations: vi.fn(),
    takeFollowUpPresentation: vi.fn(),
    projectFollowUpQueue: vi.fn(),
    claimFollowUpQueueOwner: vi.fn(),
    setFollowUpQueueMutation: vi.fn(),
    clearFollowUpQueue: vi.fn(),
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
    setError: vi.fn(),
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
    hasRecoverableTurn: mocks.hasRecoverableTurn,
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
    enqueueSessionInput: mocks.enqueueSessionInput,
    getFollowUpQueue: mocks.getFollowUpQueue,
    mutateFollowUpQueue: mocks.mutateFollowUpQueue,
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
    getTurnRecoveryAssessment: mocks.getTurnRecoveryAssessment,
  }),
}));

vi.mock('../../../../../src/store/selectors/index.js', () => ({
  useIsProcessing: () => mocks.isProcessing,
  useSessionId: () => mocks.sessionId,
  useWorkspaceRoot: () => mocks.workspaceRoot,
  useCurrentModelId: () => 'model-1',
  usePermissionMode: () => 'default',
  useThinkingModeEnabled: () => false,
  useReasoningEffort: () => 'off',
  useServiceTier: () => 'auto',
  useResponseVerbosity: () => 'auto',
  useCommunicationStyle: () => 'auto',
  useSideConversation: () => mocks.sideConversation,
  useAgentTeamsEnabled: () => false,
  useSessionActions: () => ({
    clearFinalizingStreamingMessageId: mocks.clearFinalizingStreamingMessageId,
    setCurrentThinkingContent: mocks.setCurrentThinkingContent,
    addAssistantMessage: mocks.addAssistantMessage,
    addUserMessage: mocks.addUserMessage,
    addMessage: mocks.addMessage,
    setCommand: mocks.setCommand,
    setCompactedContext: mocks.setCompactedContext,
    updateTokenUsage: mocks.updateTokenUsage,
    setError: mocks.setError,
  }),
  useAppActions: () => ({
    setTasks: vi.fn(),
    startSideConversation: mocks.startSideConversation,
    completeSideConversation: mocks.completeSideConversation,
    failSideConversation: mocks.failSideConversation,
    dismissSideConversation: mocks.dismissSideConversation,
    setTeams: vi.fn(),
    setActiveModal: vi.fn(),
    projectFollowUpQueue: mocks.projectFollowUpQueue,
    claimFollowUpQueueOwner: mocks.claimFollowUpQueueOwner,
    setFollowUpQueueMutation: mocks.setFollowUpQueueMutation,
    clearFollowUpQueue: mocks.clearFollowUpQueue,
  }),
  useCommandActions: () => ({
    createAbortController: mocks.createAbortController,
    getAbortController: mocks.getAbortController,
    clearAbortController: mocks.clearAbortController,
    setProcessing: mocks.setProcessing,
    setRecoveredSteeringCount: vi.fn(),
    rememberFollowUpPresentation: mocks.rememberFollowUpPresentation,
    takeFollowUpPresentation: mocks.takeFollowUpPresentation,
    clearFollowUpPresentations: mocks.clearFollowUpPresentations,
    abort: mocks.abort,
  }),
}));

vi.mock('../../../../../src/store/vanilla.js', () => ({
  ensureStoreInitialized: vi.fn().mockResolvedValue(undefined),
  getState: () => ({
    app: {
      activeModal: mocks.activeModal,
      followUpQueue: mocks.followUpQueue,
      followUpQueueOwner: null,
      followUpQueueMutation: mocks.followUpQueueMutation,
    },
    command: { isProcessing: mocks.storeProcessing },
    session: {
      sessionId: mocks.storeSessionId,
      workspaceRoot: mocks.storeWorkspaceRoot,
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
  projectTurnRecoveryAssessment: mocks.projectTurnRecoveryAssessment,
  createLoopEventHandler:
    (
      _deps: unknown,
      stats: {
        outputStarted: boolean;
        toolExecutionStarted: boolean;
        compactionCount?: number;
      }
    ) =>
    (event: LoopEvent) => {
      if (
        (event.kind === 'content_delta' || event.kind === 'thinking_delta') &&
        event.delta.length > 0
      ) {
        stats.outputStarted = true;
      } else if (event.kind === 'structured_output') {
        stats.outputStarted = true;
      } else if (
        event.kind === 'tool_start' ||
        event.kind === 'tool_progress' ||
        event.kind === 'tool_result'
      ) {
        stats.toolExecutionStarted = true;
      }
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

interface FailedLoopResultOptions {
  message?: string;
  details?: unknown;
  toolCallsCount?: number;
  omitMetadata?: boolean;
  type?: NonNullable<LoopResult['error']>['type'];
  abortReason?: string;
}

function failedLoopResult(options: FailedLoopResultOptions = {}): LoopResult {
  return {
    success: false,
    error: {
      type: options.type ?? 'api_error',
      message: options.message ?? 'opaque Provider failure',
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    ...(options.omitMetadata
      ? {}
      : {
          metadata: {
            turnsCount: 1,
            toolCallsCount: options.toolCallsCount ?? 0,
            duration: 1,
            ...(options.abortReason === undefined
              ? {}
              : { abortReason: options.abortReason }),
          },
        }),
  };
}

function agentReturning(result: LoopResult, events: LoopEvent[] = []) {
  return {
    chatStream: vi.fn(async function* () {
      for (const event of events) yield event;
      return result;
    }),
  };
}

async function flushAsyncWork(rounds = 20): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index++) {
      await Promise.resolve();
    }
  });
}

describe('useCommandHandler durable recovery', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let mounted: boolean;
  let hook: ReturnType<typeof useCommandHandler> | undefined;
  const confirmationHandler = {
    requestConfirmation: vi.fn(),
  };

  function Harness({ suspendWith }: { suspendWith?: Promise<never> }) {
    const renderedHook = useCommandHandler(
      undefined,
      undefined,
      confirmationHandler as never
    );
    if (suspendWith) throw suspendWith;
    hook = renderedHook;
    return null;
  }

  async function renderHarness(): Promise<void> {
    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <Harness />
        </Suspense>
      );
      for (let index = 0; index < 20; index++) {
        await Promise.resolve();
      }
    });
  }

  function unmountHarness(): void {
    if (!mounted) return;
    act(() => {
      root.unmount();
    });
    mounted = false;
  }

  beforeEach(() => {
    mocks.abortController = new AbortController();
    mocks.currentAbortController = null;
    mocks.sessionId = 'recovered-cli-session';
    mocks.workspaceRoot = '/active-workspace';
    mocks.storeSessionId = 'recovered-cli-session';
    mocks.storeWorkspaceRoot = '/active-workspace';
    mocks.activeModal = 'none';
    mocks.followUpQueue = null;
    mocks.followUpQueueMutation = { pending: false };
    mocks.isProcessing = false;
    mocks.storeProcessing = false;
    mocks.sideConversation = null;
    mocks.askSideQuestion.mockResolvedValue({
      response: 'Side answer',
      durationMs: 12,
    });
    mocks.steerActiveTurn.mockResolvedValue({
      accepted: true,
      messageId: 'queued-message',
      queued: 1,
      delivery: 'next_turn',
      queue: {
        version: 'a'.repeat(64),
        pending: 1,
        mutable: 1,
        locked: 0,
        internal: 0,
        items: [],
      },
    });
    mocks.projectFollowUpQueue.mockImplementation((snapshot) => {
      mocks.followUpQueue = snapshot;
    });
    mocks.setFollowUpQueueMutation.mockImplementation((mutation) => {
      mocks.followUpQueueMutation = mutation;
    });
    mocks.processSlashCommand.mockResolvedValue({
      type: 'handled',
      commandResult: { success: true },
    });
    mocks.hasPendingInbox.mockResolvedValue(true);
    mocks.hasActiveGoal.mockResolvedValue(false);
    mocks.hasRecoverableTurn.mockResolvedValue(false);
    mocks.getTurnRecoveryAssessment.mockReturnValue({ state: 'none' });
    mocks.resolvePendingWithHandler.mockResolvedValue(true);
    mocks.cancelPendingNonInteractive.mockResolvedValue(false);
    mocks.buildContextMessagesFromSession.mockReset().mockReturnValue([]);
    mocks.createAbortController.mockReset().mockImplementation(() => {
      if (
        mocks.currentAbortController &&
        !mocks.currentAbortController.signal.aborted
      ) {
        mocks.currentAbortController.abort('interrupted-by-new-command');
      }
      const controller = new AbortController();
      mocks.abortController = controller;
      mocks.currentAbortController = controller;
      return controller;
    });
    mocks.getAbortController
      .mockReset()
      .mockImplementation(() => mocks.currentAbortController);
    mocks.clearAbortController.mockImplementation(
      (expectedController?: AbortController) => {
        if (
          expectedController === undefined ||
          mocks.currentAbortController === expectedController
        ) {
          mocks.currentAbortController = null;
        }
      }
    );
    mocks.setProcessing.mockImplementation((processing: boolean) => {
      mocks.storeProcessing = processing;
    });
    mocks.createAgent.mockReset().mockResolvedValue({
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
    mounted = true;
  });

  afterEach(() => {
    unmountHarness();
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('reports a preflight failure once through the bounded global error channel', async () => {
    const preflightFailure = Object.assign(new Error('opaque upstream secret'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    mocks.createAgent.mockRejectedValueOnce(preflightFailure);

    await renderHarness();

    expect(mocks.setError).toHaveBeenCalledOnce();
    expect(mocks.setError).toHaveBeenCalledWith(
      `恢复排队指令失败: ${taskFailureForCode('timeout').message}`
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
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

  it('silences a lifecycle AbortError and releases command processing', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.hasActiveGoal.mockResolvedValue(false);
    mocks.hasRecoverableTurn.mockResolvedValue(false);
    mocks.processSlashCommand.mockResolvedValueOnce({ type: 'not_slash' });
    mocks.createAgent.mockRejectedValueOnce(
      new DOMException('TUI Agent lifecycle was invalidated', 'AbortError')
    );
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.hasPendingInbox).toHaveBeenCalled());
    mocks.setProcessing.mockClear();
    mocks.clearAbortController.mockClear();
    mocks.addAssistantMessage.mockClear();
    mocks.setError.mockClear();

    await act(async () => {
      await hook!.executeCommand({
        displayText: 'continue after lifecycle change',
        text: 'continue after lifecycle change',
        images: [],
        parts: [{ type: 'text', text: 'continue after lifecycle change' }],
      });
    });

    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
    expect(mocks.setError).not.toHaveBeenCalled();
    expect(mocks.setProcessing).toHaveBeenNthCalledWith(1, true);
    expect(mocks.setProcessing).toHaveBeenLastCalledWith(false);
    expect(mocks.clearAbortController).toHaveBeenCalledWith(mocks.abortController);
  });

  it('does not retry a failed Goal-only continuation', async () => {
    vi.useFakeTimers({ now: 10_000 });
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.hasActiveGoal.mockResolvedValue(true);
    const timeoutFailure = Object.assign(new Error('upstream secret'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    mocks.createAgent.mockResolvedValueOnce(
      agentReturning(
        failedLoopResult({ details: timeoutFailure, message: 'raw Goal timeout' })
      )
    );

    await renderHarness();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await flushAsyncWork();

    expect(mocks.createAgent).toHaveBeenCalledOnce();
    expect(mocks.addAssistantMessage).toHaveBeenCalledOnce();
    expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
      taskFailureForCode('timeout').message
    );
  });

  it('cancels a pending retry timer when the hook unmounts', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const timeoutFailure = Object.assign(new Error('upstream secret'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    mocks.createAgent.mockResolvedValueOnce(
      agentReturning(
        failedLoopResult({ details: timeoutFailure, message: 'raw Provider timeout' })
      )
    );

    await renderHarness();
    expect(mocks.createAgent).toHaveBeenCalledOnce();
    unmountHarness();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await flushAsyncWork();

    expect(mocks.createAgent).toHaveBeenCalledOnce();
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
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
    expect(mocks.rememberFollowUpPresentation).toHaveBeenCalledWith(
      'queued-message',
      expect.objectContaining({ displayText: 'run after the previous answer' })
    );
    expect(mocks.addUserMessage).not.toHaveBeenCalled();
  });
});
