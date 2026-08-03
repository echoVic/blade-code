import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services', () => ({
  sessionService: {
    listSessions: vi.fn(),
    createSession: vi.fn(),
    forkSession: vi.fn(),
    deleteSession: vi.fn(),
    updateSession: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    abortSession: vi.fn(),
    subscribeEvents: vi.fn(() => () => {
      /* noop */
    }),
    respondPermission: vi.fn(),
  },
}));

import { sessionService } from '../../../src/services';
import { useConfigStore } from '../../../src/store/ConfigStore';
import { TEMP_SESSION_ID, useSessionStore } from '../../../src/store/session';

describe('sessionSlice multimodal sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useConfigStore.setState({
      currentModelId: null,
      currentMode: 'default',
      configuredModels: [],
      availableModels: [],
      isLoading: false,
      error: null,
      loadModels: vi.fn().mockResolvedValue(undefined),
      setCurrentModel: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
    });

    useSessionStore.setState((state) => ({
      ...state,
      sessions: [],
      currentSessionId: TEMP_SESSION_ID,
      isTemporarySession: true,
      isLoading: false,
      error: null,
      messages: [],
      isStreaming: false,
      agentPhase: 'idle',
      currentRunId: null,
      pendingSteeringCount: 0,
      recoveredSteeringCount: 0,
      currentAssistantMessageId: null,
      hasToolCalls: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        maxContextTokens: 128000,
        isDefaultMaxTokens: true,
      },
      eventUnsubscribe: null,
      subscribeToEvents: vi.fn(),
      unsubscribeFromEvents: vi.fn(),
    }));
  });

  it('adds optimistic multimodal user messages and forwards image attachments', async () => {
    vi.mocked(sessionService.createSession).mockResolvedValue({
      sessionId: 'session-1',
      projectPath: '/tmp/project',
      title: 'Session',
      messageCount: 0,
      firstMessageTime: '2026-03-31T00:00:00.000Z',
      lastMessageTime: '2026-03-31T00:00:00.000Z',
      hasErrors: false,
    });
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-1',
      status: 'running',
    });

    const payload = {
      content: 'describe this image',
      attachments: [
        {
          type: 'image',
          content: 'data:image/png;base64,abc',
          mimeType: 'image/png',
          name: 'pasted.png',
        },
      ],
    };

    await useSessionStore.getState().sendMessage(payload as never);

    expect(useSessionStore.getState().messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    });
    expect(sessionService.sendMessage).toHaveBeenCalledWith(
      'session-1',
      payload,
      'default'
    );
  });

  it('subscribes after persisted history is loaded', async () => {
    const subscribeToEvents = vi.fn();
    useSessionStore.setState({ subscribeToEvents });
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      {
        id: 'history-1',
        role: 'user',
        content: 'persisted',
        timestamp: Date.now(),
      },
    ] as never);

    await useSessionStore.getState().selectSession('persisted-session');

    expect(subscribeToEvents).toHaveBeenCalledWith('persisted-session');
    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'persisted' }),
    ]);
  });

  it('forks the current session and atomically selects inherited history', async () => {
    const subscribeToEvents = vi.fn();
    useSessionStore.setState({
      currentSessionId: 'parent-session',
      isTemporarySession: false,
      subscribeToEvents,
    });
    vi.mocked(sessionService.forkSession).mockResolvedValue({
      sessionId: 'child-session',
      projectPath: '/tmp/project',
      title: 'Session child',
      parentId: 'parent-session',
      relationType: 'fork',
      messageCount: 1,
      firstMessageTime: '2026-08-04T00:00:00.000Z',
      lastMessageTime: '2026-08-04T00:00:00.000Z',
      hasErrors: false,
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      {
        id: 'history-1',
        role: 'user',
        content: 'inherited context',
        timestamp: Date.now(),
      },
    ] as never);

    await useSessionStore.getState().forkSession('parent-session');

    expect(sessionService.forkSession).toHaveBeenCalledWith('parent-session');
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: 'child-session',
      isTemporarySession: false,
      messages: [expect.objectContaining({ content: 'inherited context' })],
      sessions: [
        expect.objectContaining({
          sessionId: 'child-session',
          parentId: 'parent-session',
          relationType: 'fork',
        }),
      ],
    });
    expect(subscribeToEvents).toHaveBeenCalledWith('child-session');
  });

  it('adds optimistic image-only user messages without fabricating text content', async () => {
    vi.mocked(sessionService.createSession).mockResolvedValue({
      sessionId: 'session-2',
      projectPath: '/tmp/project',
      title: 'Session',
      messageCount: 0,
      firstMessageTime: '2026-03-31T00:00:00.000Z',
      lastMessageTime: '2026-03-31T00:00:00.000Z',
      hasErrors: false,
    });
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-2',
      status: 'running',
    });

    const payload = {
      content: '',
      attachments: [
        {
          type: 'image',
          content: 'data:image/png;base64,image-only',
          mimeType: 'image/png',
          name: 'image-only.png',
        },
      ],
    };

    await useSessionStore.getState().sendMessage(payload as never);

    expect(useSessionStore.getState().messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,image-only' } },
      ],
    });
    expect(sessionService.sendMessage).toHaveBeenCalledWith(
      'session-2',
      payload,
      'default'
    );
  });

  it('keeps the active SSE subscription and records queued steering depth', async () => {
    const subscribeToEvents = vi.fn();
    useSessionStore.setState({
      currentSessionId: 'session-active',
      isTemporarySession: false,
      isStreaming: true,
      currentRunId: 'run-active',
      pendingSteeringCount: 0,
      subscribeToEvents,
    });
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-active',
      status: 'steering_queued',
      queued: 2,
    });

    await useSessionStore.getState().sendMessage({
      content: 'Use the updated requirement.',
    });

    expect(subscribeToEvents).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      currentRunId: 'run-active',
      isStreaming: true,
      pendingSteeringCount: 2,
    });

    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-active',
      status: 'follow_up_queued',
      queued: 1,
    });
    await useSessionStore.getState().sendMessage({
      content: 'Run this after the current answer.',
    });
    expect(useSessionStore.getState().pendingSteeringCount).toBe(1);
  });
});
