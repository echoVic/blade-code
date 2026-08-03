// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const abortController = new AbortController();
  return {
    abortController,
    createAgent: vi.fn(),
    steerActiveTurn: vi.fn(),
    hasPendingInbox: vi.fn(),
    enqueueCommand: vi.fn(),
    addUserMessage: vi.fn(),
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
  },
}));

vi.mock('../../../../../src/ui/hooks/useAgent.js', () => ({
  useAgent: () => ({
    createAgent: mocks.createAgent,
    steerActiveTurn: mocks.steerActiveTurn,
  }),
}));

vi.mock('../../../../../src/store/selectors/index.js', () => ({
  useIsProcessing: () => mocks.isProcessing,
  useSessionId: () => 'recovered-cli-session',
  usePermissionMode: () => 'default',
  useThinkingModeEnabled: () => false,
  useSessionActions: () => ({
    clearFinalizingStreamingMessageId: mocks.clearFinalizingStreamingMessageId,
    setCurrentThinkingContent: mocks.setCurrentThinkingContent,
    addAssistantMessage: vi.fn(),
    addUserMessage: mocks.addUserMessage,
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
    mocks.hasPendingInbox.mockResolvedValue(true);
    mocks.createAgent.mockResolvedValue({
      chatStream: vi.fn(async function* (
        _message: string,
        _context: unknown,
        options: { pendingInputOnly?: boolean }
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
});
