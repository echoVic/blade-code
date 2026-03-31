import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services', () => ({
  sessionService: {
    listSessions: vi.fn(),
    createSession: vi.fn(),
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
      currentRunId: null,
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
});
