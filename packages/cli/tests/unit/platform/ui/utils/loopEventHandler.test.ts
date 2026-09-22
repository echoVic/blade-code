import { describe, expect, it, vi } from 'vitest';
import {
  createLoopEventHandler,
  type LoopEventDeps,
  type LoopEventStats,
} from '../../../../../src/ui/utils/loopEventHandler.js';
import { comprehensiveLoopEvents } from '../../../../support/comprehensiveLoopEvents.js';

vi.mock('../../../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { UI: 'UI' },
}));

vi.mock('../../../../../src/logging/StreamDebugLogger.js', () => ({
  streamDebug: vi.fn(),
}));

vi.mock('../../../../../src/ui/utils/toolFormatters.js', () => ({
  formatToolCallSummary: vi.fn((name: string) => `${name} summary`),
  formatToolDisplay: vi.fn((name: string) => ({
    status: 'ok',
    summary: `${name} result`,
  })),
}));

function createHarness() {
  const sessionActions = {
    addMessage: vi.fn(),
    finalizeStreamingMessage: vi.fn(),
    discardStreamingMessage: vi.fn(),
    setCurrentThinkingContent: vi.fn(),
    addUserMessage: vi.fn(),
    replaceLastAssistantMessage: vi.fn(),
    addToolMessage: vi.fn(),
    updateTokenUsage: vi.fn(),
    setCompacting: vi.fn(),
    setProviderAdmission: vi.fn(),
    setProviderCircuit: vi.fn(),
    setProviderRetry: vi.fn(),
    setProviderStall: vi.fn(),
    setProviderRecovery: vi.fn(),
    setTurnActivity: vi.fn(),
    setActionStationarity: vi.fn(),
    resetContextUsage: vi.fn(),
  };
  const appActions = {
    setTasks: vi.fn(),
    projectFollowUpQueue: vi.fn(),
  };
  const commandActions = {
    takeFollowUpPresentation: vi.fn(),
    setRecoveredSteeringCount: vi.fn(),
  };
  const streamingBuffer = {
    batchAppendContent: vi.fn(),
    batchAppendThinking: vi.fn(),
    flushContentBuffer: vi.fn(),
    flushThinkingBuffer: vi.fn(),
    resetStreamingBuffers: vi.fn(),
    drainPendingBuffers: vi.fn(() => ({
      extraContent: '',
      extraThinking: '',
    })),
  };
  const deps = {
    sessionActions,
    appActions,
    commandActions,
    streamingBuffer,
    thinkingModeEnabled: true,
    getStreamingMessageId: () => 'streaming-1',
    signal: new AbortController().signal,
  } as unknown as LoopEventDeps;
  const stats: LoopEventStats = {
    contentDeltaCount: 0,
    contentDeltaTotalLen: 0,
    outputStarted: false,
    toolExecutionStarted: false,
  };
  return {
    appActions,
    commandActions,
    handler: createLoopEventHandler(deps, stats),
    sessionActions,
    stats,
    streamingBuffer,
  };
}

describe('createLoopEventHandler', () => {
  it('inserts recap as a separate display message without touching the main response', () => {
    const harness = createHarness();
    harness.handler({
      kind: 'conversation_recap',
      messageId: 'recap-id',
      text: 'Goal: ship.',
    });
    expect(harness.sessionActions.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'recap-id',
        role: 'assistant',
        content: 'Goal: ship.',
        metadata: { conversationRecap: true },
      })
    );
    expect(harness.streamingBuffer.batchAppendContent).not.toHaveBeenCalled();
    expect(harness.stats.outputStarted).toBe(false);
  });

  it('projects the complete shared event contract', () => {
    const harness = createHarness();
    for (const event of comprehensiveLoopEvents()) harness.handler(event);

    expect(harness.stats).toMatchObject({
      contentDeltaCount: 1,
      contentDeltaTotalLen: 6,
      outputStarted: true,
      toolExecutionStarted: true,
      compactionCount: 1,
    });
    expect(harness.streamingBuffer.batchAppendContent).toHaveBeenCalledWith('answer');
    expect(harness.streamingBuffer.batchAppendThinking).toHaveBeenCalledWith(
      'reasoning'
    );
    expect(harness.sessionActions.addToolMessage).toHaveBeenCalledWith(
      'Recovered completed turn',
      expect.objectContaining({ toolName: 'Runtime Recovery' })
    );
    expect(harness.sessionActions.setProviderAdmission).toHaveBeenCalled();
    expect(harness.sessionActions.setProviderCircuit).toHaveBeenCalled();
    expect(harness.sessionActions.setProviderRetry).toHaveBeenCalled();
    expect(harness.sessionActions.setProviderStall).toHaveBeenCalled();
    expect(harness.sessionActions.setProviderRecovery).toHaveBeenCalled();
    expect(harness.sessionActions.setTurnActivity).toHaveBeenCalled();
    expect(harness.sessionActions.setActionStationarity).toHaveBeenCalled();
    expect(harness.appActions.setTasks).toHaveBeenCalled();
    expect(harness.appActions.projectFollowUpQueue).toHaveBeenCalled();
    expect(harness.commandActions.setRecoveredSteeringCount).toHaveBeenCalledWith(2);
  });
});
