// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const snapshot = {
    version: 'a'.repeat(64),
    pending: 1,
    mutable: 1,
    locked: 0,
    internal: 0,
    items: [],
  };
  return {
    abortController: null as AbortController | null,
    commandProcessing: false,
    followUpQueue: snapshot,
    createAgent: vi.fn(),
    cleanupAgent: vi.fn(),
    askSideQuestion: vi.fn(),
    executeShell: vi.fn(),
    getQueue: vi.fn(),
    mutateQueue: vi.fn(),
    processSlash: vi.fn(),
    sessionActions: {
      addAssistantMessage: vi.fn(),
      addUserMessage: vi.fn(),
      addMessage: vi.fn(),
      clearFinalizingStreamingMessageId: vi.fn(),
      discardStreamingMessage: vi.fn(),
      finalizeStreamingMessage: vi.fn(),
      setCommand: vi.fn(),
      setCompactedContext: vi.fn(),
      setCurrentThinkingContent: vi.fn(),
      setError: vi.fn(),
      updateTokenUsage: vi.fn(),
    },
    appActions: {
      claimFollowUpQueueOwner: vi.fn(),
      clearFollowUpQueue: vi.fn(),
      completeSideConversation: vi.fn(),
      dismissSideConversation: vi.fn(),
      failSideConversation: vi.fn(),
      projectFollowUpQueue: vi.fn(),
      setFollowUpQueueMutation: vi.fn(),
      setTasks: vi.fn(),
      setTeams: vi.fn(),
      startSideConversation: vi.fn(),
    },
  };
});

vi.mock('../../../../../src/ui/hooks/useAgent.js', () => ({
  useAgent: () => ({
    createAgent: state.createAgent,
    cleanupAgent: state.cleanupAgent,
    steerActiveTurn: vi.fn(),
    enqueueSessionInput: vi.fn(),
    getFollowUpQueue: state.getQueue,
    mutateFollowUpQueue: state.mutateQueue,
    askSideQuestion: state.askSideQuestion,
    executeUserShellCommand: state.executeShell,
    getTurnRecoveryAssessment: () => ({ state: 'none' }),
    listRewindCheckpoints: vi.fn(),
    rewindSession: vi.fn(),
    listSubagents: vi.fn(),
    resumeSubagent: vi.fn(),
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
  }),
}));

vi.mock('../../../../../src/store/selectors/index.js', () => ({
  useIsProcessing: () => false,
  useSessionId: () => 'session-1',
  useWorkspaceRoot: () => '/workspace',
  useCurrentModelId: () => 'model-1',
  usePermissionMode: () => 'default',
  useThinkingModeEnabled: () => false,
  useReasoningEffort: () => 'off',
  useServiceTier: () => 'auto',
  useResponseVerbosity: () => 'auto',
  useCommunicationStyle: () => 'auto',
  useSideConversation: () => null,
  useAgentTeamsEnabled: () => false,
  useSessionActions: () => state.sessionActions,
  useAppActions: () => state.appActions,
  useCommandActions: () => ({
    createAbortController: () => {
      state.abortController?.abort('replaced');
      state.abortController = new AbortController();
      return state.abortController;
    },
    getAbortController: () => state.abortController,
    clearAbortController: () => {
      state.abortController = null;
    },
    setProcessing: (processing: boolean) => {
      state.commandProcessing = processing;
    },
    setRecoveredSteeringCount: vi.fn(),
    rememberFollowUpPresentation: vi.fn(),
    takeFollowUpPresentation: vi.fn(),
    clearFollowUpPresentations: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../../../../../src/store/vanilla.js', () => ({
  configActions: () => ({ setPermissionMode: vi.fn() }),
  ensureStoreInitialized: vi.fn(),
  getState: () => ({
    app: {
      activeModal: 'none',
      followUpQueue: state.followUpQueue,
      followUpQueueMutation: { pending: false },
    },
    command: { isProcessing: state.commandProcessing },
    session: {
      sessionId: 'session-1',
      workspaceRoot: '/workspace',
      messages: [],
      restoredContextMessages: [],
      restoredContextMessageCount: 0,
      currentStreamingMessageId: null,
    },
  }),
}));

vi.mock('../../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    hasPendingInbox: vi.fn().mockResolvedValue(false),
    hasActiveGoal: vi.fn().mockResolvedValue(false),
    hasRecoverableTurn: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../../../../../src/services/SessionInteractionService.js', () => ({
  SessionInteractionService: {
    resolvePendingWithHandler: vi.fn().mockResolvedValue(false),
    cancelPendingNonInteractive: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('../../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: () => ({
      executeUserPromptSubmitHooks: vi.fn().mockResolvedValue({ proceed: true }),
    }),
  },
}));

vi.mock('../../../../../src/ui/hooks/useStreamingBuffer.js', () => ({
  useStreamingBuffer: () => ({
    resetStreamingBuffers: vi.fn(),
    drainPendingBuffers: () => ({ extraContent: '', extraThinking: '' }),
    batchAppendContent: vi.fn(),
    batchAppendThinking: vi.fn(),
  }),
}));

vi.mock('../../../../../src/ui/utils/loopEventHandler.js', () => ({
  projectTurnRecoveryAssessment: vi.fn(),
  createLoopEventHandler: () => (event: { kind: string; delta?: string }) => {
    if (event.kind === 'content_delta' && event.delta) {
      state.sessionActions.addAssistantMessage(event.delta);
    }
  },
}));

vi.mock('../../../../../src/ui/utils/slashCommandRouter.js', () => ({
  processSlashCommand: state.processSlash,
}));

vi.mock('../../../../../src/ui/utils/sessionContext.js', () => ({
  buildContextMessagesFromSession: () => [],
}));

import { useCommandHandler } from '../../../../../src/ui/hooks/useCommandHandler.js';

const input = (text: string) => ({
  text,
  displayText: text,
  images: [],
  parts: text ? [{ type: 'text' as const, text }] : [],
});

describe('useCommandHandler', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let hook: ReturnType<typeof useCommandHandler>;

  function Harness() {
    hook = useCommandHandler();
    return null;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    state.abortController = null;
    state.commandProcessing = false;
    state.getQueue.mockResolvedValue(state.followUpQueue);
    state.mutateQueue.mockResolvedValue({
      snapshot: { ...state.followUpQueue, version: 'b'.repeat(64), pending: 0 },
    });
    state.askSideQuestion.mockResolvedValue({
      response: 'side answer',
      durationMs: 2,
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    });
    state.executeShell.mockResolvedValue({
      executionId: 'shell-1',
      delivery: 'completed',
      record: {
        version: 1,
        command: 'pwd',
        status: 'completed',
        exitCode: 0,
        durationMs: 1,
        stdout: '/workspace',
        stderr: '',
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        binaryOutput: false,
        truncated: false,
      },
    });
    state.processSlash.mockImplementation(async (resolved: { text: string }) =>
      resolved.text.startsWith('/')
        ? {
            type: 'handled',
            commandResult: { success: true },
          }
        : {
            type: 'continue_as_agent',
            result: {
              agentInput: resolved,
              userMessageAlreadyAdded: false,
            },
          }
    );
    state.createAgent.mockResolvedValue({
      chatStream: vi.fn(async function* () {
        yield { kind: 'content_delta', delta: 'done' };
        return {
          success: true,
          finalMessage: 'done',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
        };
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('coordinates commands, side work, shell, queue state, and cleanup', async () => {
    await hook.executeCommand(input(''));
    await hook.executeCommand(input('/help'));
    await hook.executeCommand(input('/btw why?'));
    await hook.executeCommand(input('! pwd'));
    await hook.executeCommand(input('finish the task'));

    await hook.refreshFollowUpQueue();
    await expect(
      hook.controlFollowUpQueue({ type: 'remove', messageId: 'message-1' })
    ).resolves.toBe(true);
    hook.handleAbort();

    expect(state.processSlash).toHaveBeenCalledTimes(2);
    expect(state.askSideQuestion).toHaveBeenCalledWith('why?', expect.any(AbortSignal));
    expect(state.executeShell).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(state.createAgent).toHaveBeenCalledOnce();
    expect(state.appActions.projectFollowUpQueue).toHaveBeenCalled();
    expect(state.sessionActions.addUserMessage).toHaveBeenCalledWith('finish the task');
    expect(state.commandProcessing).toBe(false);
    expect(hook.cleanupAgent).toBe(state.cleanupAgent);
  });
});
