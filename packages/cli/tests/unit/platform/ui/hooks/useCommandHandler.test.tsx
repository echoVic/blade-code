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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function successfulLoopResult(finalMessage = 'resumed'): LoopResult {
  return {
    success: true,
    finalMessage,
    metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
  };
}

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

  it('projects completed recovery after startup reconciliation removes pending work', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.hasActiveGoal.mockResolvedValue(false);
    mocks.hasRecoverableTurn.mockResolvedValue(true);
    mocks.getTurnRecoveryAssessment.mockReturnValue({
      state: 'completed',
      turnId: 'turn-finalized-before-restart',
      inputMessageCount: 1,
    });

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mocks.projectTurnRecoveryAssessment).toHaveBeenCalledWith(
        expect.any(Object),
        {
          state: 'completed',
          turnId: 'turn-finalized-before-restart',
          inputMessageCount: 1,
        }
      );
    });
    const agent = await mocks.createAgent.mock.results[0]?.value;
    expect(agent.chatStream).not.toHaveBeenCalled();
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

  it('shows one canonical non-abort failure from automatic pending recovery', async () => {
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
        taskFailureForCode('runtime').message
      );
    });
    expect(mocks.addAssistantMessage).toHaveBeenCalledTimes(1);
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith(
      '输出因达到 token 上限被截断，部分内容可能不完整。'
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith(
      'Recovered turn still produced an empty final response.'
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

  it('silently retries one replay-safe pending-input failure after the shared delay', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const sessionIdentity = JSON.stringify([
      '/active-workspace',
      'recovered-cli-session',
    ]);
    const delayMs = stablePendingResumeRetryDelay(sessionIdentity, 1);
    const timeoutFailure = Object.assign(new Error('upstream secret'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    const firstAgent = agentReturning(
      failedLoopResult({ details: timeoutFailure, message: 'raw Provider timeout' })
    );
    const secondAgent = agentReturning(successfulLoopResult());
    mocks.createAgent
      .mockResolvedValueOnce(firstAgent)
      .mockResolvedValueOnce(secondAgent);

    await renderHarness();

    expect(mocks.createAgent).toHaveBeenCalledOnce();
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
    });
    expect(mocks.createAgent).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushAsyncWork();

    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
    expect(firstAgent.chatStream).toHaveBeenCalledWith(
      '',
      expect.any(Object),
      expect.objectContaining({ pendingInputOnly: true })
    );
    expect(secondAgent.chatStream).toHaveBeenCalledWith(
      '',
      expect.any(Object),
      expect.objectContaining({ pendingInputOnly: true })
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
    expect(mocks.setError).not.toHaveBeenCalled();
  });

  it.each([
    [
      'content output',
      [{ kind: 'content_delta', delta: 'visible output' } satisfies LoopEvent],
    ],
    [
      'hidden thinking output',
      [{ kind: 'thinking_delta', delta: 'hidden thought' } satisfies LoopEvent],
    ],
    [
      'structured output',
      [
        {
          kind: 'structured_output',
          output: { result: 'partial' },
          schemaDigest: 'schema-digest',
        } satisfies LoopEvent,
      ],
    ],
    [
      'tool lifecycle',
      [
        {
          kind: 'tool_start',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: { name: 'Bash', arguments: '{}' },
          },
        } satisfies LoopEvent,
      ],
    ],
  ])('does not retry a pending failure after %s', async (_label, events) => {
    vi.useFakeTimers({ now: 10_000 });
    const timeoutFailure = Object.assign(new Error('upstream secret'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    mocks.createAgent.mockResolvedValueOnce(
      agentReturning(
        failedLoopResult({ details: timeoutFailure, message: 'raw Provider timeout' }),
        events
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
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith('raw Provider timeout');
  });

  it.each([
    ['positive', { toolCallsCount: 1 }],
    ['missing', { omitMetadata: true }],
    ['malformed', { toolCallsCount: Number.NaN }],
    ['negative', { toolCallsCount: -1 }],
  ])(
    'does not retry a pending failure with %s tool-count evidence',
    async (_label, failureOptions) => {
      vi.useFakeTimers({ now: 10_000 });
      const timeoutFailure = Object.assign(new Error('upstream secret'), {
        code: 'STREAM_IDLE_TIMEOUT',
      });
      mocks.createAgent.mockResolvedValueOnce(
        agentReturning(
          failedLoopResult({
            ...failureOptions,
            details: timeoutFailure,
            message: 'raw Provider timeout',
          })
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
    }
  );

  it('does not retry a nonretryable pending-input failure', async () => {
    vi.useFakeTimers({ now: 10_000 });
    mocks.createAgent.mockResolvedValueOnce(
      agentReturning(
        failedLoopResult({
          details: new Error('401 invalid api key'),
          message: 'raw Provider authentication error',
        })
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
      taskFailureForCode('authentication').message
    );
  });

  it('does not retry when a fresh durable inbox check is empty', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const timeoutFailure = Object.assign(new Error('upstream secret'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    mocks.hasPendingInbox
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mocks.createAgent.mockResolvedValueOnce(
      agentReturning(
        failedLoopResult({ details: timeoutFailure, message: 'raw Provider timeout' })
      )
    );

    await renderHarness();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await flushAsyncWork();

    expect(mocks.hasPendingInbox).toHaveBeenCalledTimes(4);
    expect(mocks.createAgent).toHaveBeenCalledOnce();
    expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
      taskFailureForCode('timeout').message
    );
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

  it('routes bang input to the Session shell without creating an Agent', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.hasActiveGoal.mockResolvedValue(false);
    mocks.hasRecoverableTurn.mockResolvedValue(false);
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

  it('defers an interrupted pending run until the foreground command releases idle', async () => {
    const pendingCompletion = deferred<LoopResult>();
    const foregroundCompletion = deferred<LoopResult>();
    const interruptedAgent = {
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return await pendingCompletion.promise;
      }),
    };
    const foregroundAgent = {
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return await foregroundCompletion.promise;
      }),
    };
    const resumedAgent = agentReturning(successfulLoopResult('pending done'));
    mocks.createAgent
      .mockResolvedValueOnce(interruptedAgent)
      .mockResolvedValueOnce(foregroundAgent)
      .mockResolvedValueOnce(resumedAgent);
    mocks.processSlashCommand.mockResolvedValue({ type: 'not_slash' });

    await renderHarness();
    expect(mocks.createAgent).toHaveBeenCalledOnce();
    const interruptedController = mocks.currentAbortController;

    let foregroundCommand!: Promise<void>;
    act(() => {
      foregroundCommand = hook!.executeCommand({
        displayText: 'foreground command',
        text: 'foreground command',
        images: [],
        parts: [{ type: 'text', text: 'foreground command' }],
      });
    });
    await flushAsyncWork();
    expect(interruptedController?.signal.reason).toBe('interrupted-by-new-command');
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    pendingCompletion.resolve(
      failedLoopResult({
        type: 'aborted',
        message: '任务已被用户中止',
        abortReason: 'interrupt',
      })
    );
    await flushAsyncWork();
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);

    foregroundCompletion.resolve(successfulLoopResult('foreground done'));
    await act(async () => {
      await foregroundCommand;
    });
    await flushAsyncWork();
    expect(mocks.createAgent).toHaveBeenCalledTimes(3);
    expect(resumedAgent.chatStream).toHaveBeenCalledWith(
      '',
      expect.any(Object),
      expect.objectContaining({ pendingInputOnly: true })
    );
    expect(mocks.addAssistantMessage).not.toHaveBeenCalledWith(
      taskFailureForCode('runtime').message
    );
  });

  it('defers an interruption received during the fresh inbox check', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const freshInbox = deferred<boolean>();
    const foregroundCompletion = deferred<LoopResult>();
    const timeoutFailure = Object.assign(new Error('upstream secret'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    const failedAgent = agentReturning(
      failedLoopResult({ details: timeoutFailure, message: 'raw Provider timeout' })
    );
    const foregroundAgent = {
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return await foregroundCompletion.promise;
      }),
    };
    const resumedAgent = agentReturning(successfulLoopResult('pending done'));
    mocks.hasPendingInbox
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(freshInbox.promise)
      .mockResolvedValue(true);
    mocks.createAgent
      .mockResolvedValueOnce(failedAgent)
      .mockResolvedValueOnce(foregroundAgent)
      .mockResolvedValueOnce(resumedAgent);
    mocks.processSlashCommand.mockResolvedValue({ type: 'not_slash' });

    await renderHarness();
    expect(mocks.hasPendingInbox).toHaveBeenCalledTimes(4);
    const interruptedController = mocks.currentAbortController;

    let foregroundCommand!: Promise<void>;
    act(() => {
      foregroundCommand = hook!.executeCommand({
        displayText: 'foreground during inbox check',
        text: 'foreground during inbox check',
        images: [],
        parts: [{ type: 'text', text: 'foreground during inbox check' }],
      });
    });
    await flushAsyncWork();
    expect(interruptedController?.signal.reason).toBe('interrupted-by-new-command');

    freshInbox.resolve(true);
    await flushAsyncWork();
    foregroundCompletion.resolve(successfulLoopResult('foreground done'));
    await act(async () => {
      await foregroundCommand;
    });
    await flushAsyncWork();

    expect(mocks.createAgent).toHaveBeenCalledTimes(3);
    expect(resumedAgent.chatStream).toHaveBeenCalledOnce();
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
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

  it('cancels an old Session retry when the hook switches identity', async () => {
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
    mocks.sessionId = 'replacement-session';
    mocks.workspaceRoot = '/replacement-workspace';
    mocks.storeSessionId = 'replacement-session';
    mocks.storeWorkspaceRoot = '/replacement-workspace';
    mocks.hasPendingInbox.mockResolvedValue(false);
    await renderHarness();
    mocks.createAgent.mockClear();
    mocks.addAssistantMessage.mockClear();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await flushAsyncWork();

    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(mocks.addAssistantMessage).not.toHaveBeenCalled();
  });

  it('lets an old foreground completion notify the current Session coordinator', async () => {
    const foregroundCompletion = deferred<LoopResult>();
    const oldForegroundAgent = {
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return await foregroundCompletion.promise;
      }),
    };
    const replacementPendingAgent = agentReturning(
      successfulLoopResult('replacement pending done')
    );
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.processSlashCommand.mockResolvedValue({ type: 'not_slash' });
    mocks.createAgent
      .mockResolvedValueOnce(oldForegroundAgent)
      .mockResolvedValueOnce(replacementPendingAgent);

    await renderHarness();
    let oldCommand!: Promise<void>;
    act(() => {
      oldCommand = hook!.executeCommand({
        displayText: 'old foreground command',
        text: 'old foreground command',
        images: [],
        parts: [{ type: 'text', text: 'old foreground command' }],
      });
    });
    await flushAsyncWork();
    expect(mocks.createAgent).toHaveBeenCalledOnce();

    mocks.sessionId = 'replacement-session';
    mocks.workspaceRoot = '/replacement-workspace';
    mocks.storeSessionId = 'replacement-session';
    mocks.storeWorkspaceRoot = '/replacement-workspace';
    mocks.hasPendingInbox.mockResolvedValue(true);
    await renderHarness();
    expect(mocks.createAgent).toHaveBeenCalledOnce();

    foregroundCompletion.resolve(successfulLoopResult('old foreground done'));
    await act(async () => {
      await oldCommand;
    });
    await flushAsyncWork();

    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
    expect(replacementPendingAgent.chatStream).toHaveBeenCalledOnce();
  });

  it('does not publish a coordinator from a discarded render', async () => {
    const foregroundCompletion = deferred<LoopResult>();
    const requestSpy = vi.spyOn(PendingResumeCoordinator.prototype, 'request');
    const notifyIdleSpy = vi.spyOn(PendingResumeCoordinator.prototype, 'notifyIdle');
    const oldForegroundAgent = {
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        return await foregroundCompletion.promise;
      }),
    };
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.processSlashCommand.mockResolvedValue({ type: 'not_slash' });
    mocks.createAgent.mockResolvedValueOnce(oldForegroundAgent);

    await renderHarness();
    let oldCommand!: Promise<void>;
    act(() => {
      oldCommand = hook!.executeCommand({
        displayText: 'committed foreground command',
        text: 'committed foreground command',
        images: [],
        parts: [{ type: 'text', text: 'committed foreground command' }],
      });
    });
    await flushAsyncWork();
    expect(mocks.createAgent).toHaveBeenCalledOnce();

    act(() => {
      Bus.publish(
        {
          sessionId: 'recovered-cli-session',
          projectPath: '/active-workspace',
        },
        'subagent.completion.queued',
        {}
      );
    });
    await flushAsyncWork();
    expect(requestSpy).toHaveBeenCalledOnce();
    const committedCoordinator = requestSpy.mock.instances[0];

    mocks.sessionId = 'discarded-session';
    mocks.workspaceRoot = '/discarded-workspace';
    const discardedRender = new Promise<never>(() => {
      // Intentionally unresolved: Suspense must discard this render.
    });
    await act(async () => {
      startTransition(() => {
        root.render(
          <Suspense fallback={null}>
            <Harness suspendWith={discardedRender} />
          </Suspense>
        );
      });
      await Promise.resolve();
    });

    foregroundCompletion.resolve(successfulLoopResult('foreground done'));
    await act(async () => {
      await oldCommand;
    });

    expect(notifyIdleSpy).toHaveBeenCalledOnce();
    expect(notifyIdleSpy.mock.instances[0]).toBe(committedCoordinator);
  });

  it('does not let an old shell completion wake the replacement Session', async () => {
    const shellCompletion = deferred<{
      executionId: string;
      messageId: string;
      record: {
        version: 1;
        command: string;
        status: 'completed';
        exitCode: number;
        durationMs: number;
        stdout: string;
        stderr: string;
        stdoutOmittedBytes: number;
        stderrOmittedBytes: number;
        binaryOutput: boolean;
        truncated: boolean;
      };
      modelContent: string;
      auxiliary: boolean;
      delivery: 'next_turn';
    }>();
    mocks.hasPendingInbox.mockResolvedValue(false);
    mocks.executeUserShellCommand.mockReturnValueOnce(shellCompletion.promise);

    await renderHarness();
    let oldShellCommand!: Promise<void>;
    act(() => {
      oldShellCommand = hook!.executeCommand({
        displayText: '! pwd',
        text: '! pwd',
        images: [],
        parts: [{ type: 'text', text: '! pwd' }],
      });
    });
    await flushAsyncWork();

    mocks.sessionId = 'replacement-session';
    mocks.workspaceRoot = '/replacement-workspace';
    mocks.storeSessionId = 'replacement-session';
    mocks.storeWorkspaceRoot = '/replacement-workspace';
    await renderHarness();
    mocks.createAgent.mockClear();
    mocks.hasPendingInbox.mockResolvedValue(true);
    mocks.storeProcessing = false;

    shellCompletion.resolve({
      executionId: 'old-shell',
      messageId: 'old-shell-message',
      record: {
        version: 1,
        command: 'pwd',
        status: 'completed',
        exitCode: 0,
        durationMs: 3,
        stdout: '/old-workspace',
        stderr: '',
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        binaryOutput: false,
        truncated: false,
      },
      modelContent: '<user_shell_command>pwd</user_shell_command>',
      auxiliary: false,
      delivery: 'next_turn',
    });
    await act(async () => {
      await oldShellCommand;
    });
    await flushAsyncWork();

    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it('exposes agent cleanup to orchestration owners', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(hook?.cleanupAgent).toBe(mocks.cleanupAgent);
  });

  it('rejects a stale command callback while remote history is open', async () => {
    mocks.hasPendingInbox.mockResolvedValue(false);
    await renderHarness();
    mocks.activeModal = 'sessionHistoryViewer';

    await act(async () => {
      await hook?.executeCommand({
        text: '/fork parent-session',
        displayText: '/fork parent-session',
        images: [],
        parts: [{ type: 'text', text: '/fork parent-session' }],
      });
    });

    expect(mocks.processSlashCommand).not.toHaveBeenCalled();
    expect(mocks.createAbortController).not.toHaveBeenCalled();
    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(mocks.addUserMessage).not.toHaveBeenCalled();
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
    expect(mocks.rememberFollowUpPresentation).toHaveBeenCalledWith(
      'queued-message',
      expect.objectContaining({ displayText: 'run after the previous answer' })
    );
    expect(mocks.addUserMessage).not.toHaveBeenCalled();
  });

  it('coalesces concurrent next-turn wakeups into one recovery run', async () => {
    mocks.isProcessing = true;
    mocks.storeProcessing = false;
    mocks.hasPendingInbox.mockResolvedValue(false);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.hasPendingInbox).toHaveBeenCalled();
    });

    let resolvePending!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });
    mocks.hasPendingInbox.mockReset().mockReturnValue(pending);
    mocks.createAgent.mockClear();

    await act(async () => {
      await Promise.all([
        hook!.executeCommand({
          text: 'first queued instruction',
          displayText: 'first queued instruction',
          images: [],
          parts: [{ type: 'text', text: 'first queued instruction' }],
        }),
        hook!.executeCommand({
          text: 'second queued instruction',
          displayText: 'second queued instruction',
          images: [],
          parts: [{ type: 'text', text: 'second queued instruction' }],
        }),
      ]);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.hasPendingInbox).toHaveBeenCalledOnce();
    });

    resolvePending(true);
    await act(async () => {
      await pending;
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mocks.createAgent).toHaveBeenCalledOnce();
    });
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

  it('allows /queue during an active turn without steering or aborting', async () => {
    mocks.isProcessing = true;
    mocks.storeProcessing = true;
    mocks.processSlashCommand.mockResolvedValueOnce({
      type: 'handled',
      commandResult: { success: true },
    });

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const resolved = {
      text: '/queue',
      displayText: '/queue',
      images: [],
      parts: [{ type: 'text' as const, text: '/queue' }],
    };
    await hook?.executeCommand(resolved);

    expect(mocks.processSlashCommand).toHaveBeenCalledOnce();
    expect(mocks.processSlashCommand.mock.calls[0]?.[0]).toBe(resolved);
    expect(mocks.createAbortController).not.toHaveBeenCalled();
    expect(mocks.steerActiveTurn).not.toHaveBeenCalled();
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it('uses the exact queue version and installs a conflict snapshot without retrying', async () => {
    const before = {
      version: 'a'.repeat(64),
      pending: 1,
      mutable: 1,
      locked: 0,
      internal: 0,
      items: [],
    };
    const latest = { ...before, version: 'b'.repeat(64), pending: 0, mutable: 0 };
    mocks.followUpQueue = before;
    mocks.mutateFollowUpQueue.mockRejectedValueOnce(
      new FollowUpQueueMutationError('revision_conflict', latest)
    );

    await renderHarness();
    await expect(
      hook?.controlFollowUpQueue({ type: 'remove', messageId: 'queued-message' })
    ).resolves.toBe(false);

    expect(mocks.mutateFollowUpQueue).toHaveBeenCalledOnce();
    expect(mocks.mutateFollowUpQueue).toHaveBeenCalledWith({
      expectedVersion: before.version,
      operation: { type: 'remove', messageId: 'queued-message' },
    });
    expect(mocks.projectFollowUpQueue).toHaveBeenCalledWith(
      latest,
      expect.stringContaining('/active-workspace\0recovered-cli-session\0')
    );
    expect(mocks.setFollowUpQueueMutation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pending: false,
        errorCode: 'revision_conflict',
      }),
      expect.any(String)
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
