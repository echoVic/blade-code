import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionRef } from '@api/schemas';
import type { SendMessagePayload } from '../../../src/store/session/types';

vi.mock('../../../src/services', () => ({
  sessionService: {
    listSessions: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    updateSession: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    abortSession: vi.fn(),
    forkSession: vi.fn(),
    subscribeEvents: vi.fn(() => () => {
      /* noop */
    }),
    openEventSubscription: vi.fn(),
    respondPermission: vi.fn(),
  },
}));

import { sessionService } from '../../../src/services';
import { useConfigStore } from '../../../src/store/ConfigStore';
import { TEMP_SESSION_ID, useSessionStore } from '../../../src/store/session';
import type { Message } from '../../../src/store/session/types';
import { globalStreamingBuffer } from '../../../src/store/session/handlers/streamingBuffer';
import { createStreamingSlice } from '../../../src/store/session/slices/streamingSlice';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/tmp/project-a',
    title: 'Session',
    gitBranch: 'main',
    rootId: 'root-session-1',
    parentId: undefined,
    relationType: undefined,
    messageCount: 0,
    firstMessageTime: '2026-03-31T00:00:00.000Z',
    lastMessageTime: '2026-03-31T00:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

function createRef(sessionId: string, projectPath: string): SessionRef {
  return { sessionId, projectPath };
}

function createMessage(
  overrides: Partial<Message> & Pick<Message, 'role' | 'content'>
): Message {
  return {
    id: overrides.id ?? `message-${Date.now()}`,
    role: overrides.role,
    content: overrides.content,
    timestamp: overrides.timestamp ?? Date.now(),
    metadata: overrides.metadata,
    tool_call_id: overrides.tool_call_id,
    name: overrides.name,
    tool_calls: overrides.tool_calls,
    thinkingContent: overrides.thinkingContent,
    agentContent: overrides.agentContent,
  };
}

function createActualReplaceEventSubscription() {
  const set = (
    partial:
      | Parameters<typeof useSessionStore.setState>[0]
      | ((
          state: ReturnType<typeof useSessionStore.getState>
        ) => Partial<ReturnType<typeof useSessionStore.getState>>)
  ) => {
    if (typeof partial === 'function') {
      useSessionStore.setState(partial(useSessionStore.getState()));
      return;
    }
    useSessionStore.setState(partial);
  };
  const get = () => useSessionStore.getState();
  return createStreamingSlice(set as never, get as never, {} as never)
    .replaceEventSubscription;
}

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
      currentSessionRef: null,
      forkingSessionRef: null,
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
      prepareEventSubscription: vi.fn(),
      replaceEventSubscription: vi.fn(),
      subscribeToEvents: vi.fn(),
      unsubscribeFromEvents: vi.fn(),
    }));
  });

  it('adds optimistic multimodal user messages and forwards image attachments', async () => {
    vi.mocked(sessionService.createSession).mockResolvedValue(
      createSession({ sessionId: 'session-1', projectPath: '/tmp/project' })
    );
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-1',
      status: 'running',
    });

    const payload: SendMessagePayload = {
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

    await useSessionStore.getState().sendMessage(payload satisfies SendMessagePayload);

    expect(useSessionStore.getState().messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
    });
    expect(sessionService.sendMessage).toHaveBeenCalledWith(
      createRef('session-1', '/tmp/project'),
      payload,
      'default'
    );
  });

  it('subscribes after persisted history is loaded', async () => {
    const subscribeToEvents = vi.fn();
    const prepareEventSubscription = vi.fn().mockResolvedValue(() => undefined);
    const replaceEventSubscription = vi.fn();
    useSessionStore.setState({
      subscribeToEvents,
      prepareEventSubscription,
      replaceEventSubscription,
      sessions: [
        createSession({ sessionId: 'persisted-session', projectPath: '/tmp/a' }),
      ],
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      {
        id: 'history-1',
        role: 'user',
        content: 'persisted',
        timestamp: Date.now(),
      },
    ]);

    await useSessionStore
      .getState()
      .selectSession(createRef('persisted-session', '/tmp/a'));

    expect(prepareEventSubscription).toHaveBeenCalledWith(
      createRef('persisted-session', '/tmp/a')
    );
    expect(replaceEventSubscription).toHaveBeenCalled();
    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'persisted' }),
    ]);
  });

  it('adds optimistic image-only user messages without fabricating text content', async () => {
    vi.mocked(sessionService.createSession).mockResolvedValue(
      createSession({ sessionId: 'session-2', projectPath: '/tmp/project' })
    );
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-2',
      status: 'running',
    });

    const payload: SendMessagePayload = {
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

    await useSessionStore.getState().sendMessage(payload);

    expect(useSessionStore.getState().messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,image-only' } },
      ],
    });
    expect(sessionService.sendMessage).toHaveBeenCalledWith(
      createRef('session-2', '/tmp/project'),
      payload,
      'default'
    );
  });

  it('keeps the active SSE subscription and records queued steering depth', async () => {
    const subscribeToEvents = vi.fn();
    useSessionStore.setState({
      currentSessionId: 'session-active',
      currentSessionRef: createRef('session-active', '/tmp/project-active'),
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

  it('rolls back optimistic send state when initial subscription startup fails', async () => {
    const currentRef = createRef('session-active', '/tmp/project-active');
    const existingMessages = [
      createMessage({
        id: 'existing-message',
        role: 'assistant',
        content: 'persisted assistant',
      }),
    ];
    const subscribeToEvents = vi.fn().mockRejectedValue(new Error('sse unavailable'));

    useSessionStore.setState({
      currentSessionId: currentRef.sessionId,
      currentSessionRef: currentRef,
      isTemporarySession: false,
      isStreaming: false,
      messages: existingMessages,
      subscribeToEvents,
    });

    await useSessionStore.getState().sendMessage({ content: 'hello' });

    expect(subscribeToEvents).toHaveBeenCalledWith(currentRef);
    expect(sessionService.sendMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages).toEqual(existingMessages);
    expect(useSessionStore.getState().isStreaming).toBe(false);
    expect(useSessionStore.getState().error).toBe('sse unavailable');
    expect(useSessionStore.getState().currentSessionRef).toEqual(currentRef);
    expect(useSessionStore.getState().currentSessionId).toBe(currentRef.sessionId);
  });

  it('keeps same-id sessions from different workspaces distinct for selection and deletion', async () => {
    const sessionA = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-a',
      title: 'A',
      rootId: 'root-a',
    });
    const sessionB = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-b',
      title: 'B',
      rootId: 'root-b',
    });
    const prepareEventSubscription = vi.fn().mockResolvedValue(() => undefined);
    const replaceEventSubscription = vi.fn();
    useSessionStore.setState({
      sessions: [sessionA, sessionB],
      prepareEventSubscription,
      replaceEventSubscription,
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([]);

    await useSessionStore
      .getState()
      .selectSession(createRef('shared-id', '/tmp/project-b'));

    expect(sessionService.getMessages).toHaveBeenCalledWith(
      createRef('shared-id', '/tmp/project-b')
    );
    expect(useSessionStore.getState().currentSessionRef).toEqual(
      createRef('shared-id', '/tmp/project-b')
    );
    expect(useSessionStore.getState().currentSessionId).toBe('shared-id');

    await useSessionStore
      .getState()
      .deleteSession(createRef('shared-id', '/tmp/project-a'));

    expect(sessionService.deleteSession).toHaveBeenCalledWith(
      createRef('shared-id', '/tmp/project-a')
    );
    expect(useSessionStore.getState().sessions).toEqual([sessionB]);
    expect(useSessionStore.getState().currentSessionRef).toEqual(
      createRef('shared-id', '/tmp/project-b')
    );
  });

  it('starts temporary sessions without preserving a durable current session ref and create sets both ref and id', async () => {
    vi.mocked(sessionService.createSession).mockResolvedValue(
      createSession({ sessionId: 'created-1', projectPath: '/tmp/project-created' })
    );
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-created',
      status: 'running',
    });

    useSessionStore.getState().startTemporarySession();
    expect(useSessionStore.getState().currentSessionRef).toBeNull();
    expect(useSessionStore.getState().currentSessionId).toBe(TEMP_SESSION_ID);

    await useSessionStore.getState().sendMessage({ content: 'hello' });

    expect(useSessionStore.getState().currentSessionRef).toEqual(
      createRef('created-1', '/tmp/project-created')
    );
    expect(useSessionStore.getState().currentSessionId).toBe('created-1');
  });

  it('lists sessions through SessionSchema parsing and rejects missing rootId payloads', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => [
        createSession({ sessionId: 'valid-list', projectPath: '/tmp/project-list' }),
        {
          sessionId: 'invalid-list',
          projectPath: '/tmp/project-invalid',
          title: 'Invalid',
          gitBranch: 'main',
          messageCount: 0,
          firstMessageTime: '2026-03-31T00:00:00.000Z',
          lastMessageTime: '2026-03-31T00:00:00.000Z',
          hasErrors: false,
        },
      ],
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { sessionService: actualSessionService } = await vi.importActual<
      typeof import('../../../src/services/sessionService')
    >('../../../src/services/sessionService');

    await expect(actualSessionService.listSessions()).rejects.toThrow();
  });

  it('keeps fork pending state isolated until the child subscription is ready', async () => {
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-a',
      title: 'Parent A',
      rootId: 'root-a',
    });
    const child = createSession({
      sessionId: 'child-id',
      projectPath: '/tmp/project-a',
      title: 'Child',
      rootId: 'root-a',
      parentId: 'shared-id',
      relationType: 'fork',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const childRef = createRef(child.sessionId, child.projectPath);
    const originalUnsubscribe = vi.fn();
    const replacementUnsubscribe = vi.fn();
    const prepareEventSubscription = vi.fn().mockResolvedValue(replacementUnsubscribe);
    const replaceEventSubscription = vi.fn();

    useSessionStore.setState({
      sessions: [source],
      currentSessionId: source.sessionId,
      currentSessionRef: sourceRef,
      messages: [
        {
          id: 'existing-message',
          role: 'user',
          content: 'persisted',
          timestamp: Date.now(),
        },
      ],
      eventUnsubscribe: originalUnsubscribe,
      prepareEventSubscription,
      replaceEventSubscription,
    });

    vi.mocked(sessionService.forkSession).mockImplementation(async () => {
      expect(useSessionStore.getState().forkingSessionRef).toEqual(sourceRef);
      expect(useSessionStore.getState().currentSessionRef).toEqual(sourceRef);
      expect(useSessionStore.getState().messages).toEqual([
        expect.objectContaining({ id: 'existing-message' }),
      ]);
      return {
        session: child,
        messages: [
          createMessage({ id: 'history-user', role: 'user', content: 'hello child' }),
        ],
      };
    });

    await useSessionStore.getState().forkSession(source);

    expect(sessionService.forkSession).toHaveBeenCalledWith(source);
    expect(prepareEventSubscription).toHaveBeenCalledWith(childRef);
    expect(useSessionStore.getState().forkingSessionRef).toBeNull();
    expect(useSessionStore.getState().currentSessionRef).toEqual(childRef);
    expect(useSessionStore.getState().currentSessionId).toBe(child.sessionId);
    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello child' }),
    ]);
    expect(useSessionStore.getState().tokenUsage.totalTokens).toBe(0);
    expect(replaceEventSubscription).toHaveBeenCalledWith(replacementUnsubscribe);
    expect(originalUnsubscribe).not.toHaveBeenCalled();
  });

  it('keeps committed child state when replacing the old subscription cleanup throws during fork', async () => {
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-a',
      title: 'Parent A',
      rootId: 'root-a',
    });
    const child = createSession({
      sessionId: 'child-id',
      projectPath: '/tmp/project-a',
      title: 'Child',
      rootId: 'root-a',
      parentId: 'shared-id',
      relationType: 'fork',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const childRef = createRef(child.sessionId, child.projectPath);
    const replacementUnsubscribe = vi.fn();
    const oldUnsubscribe = vi.fn(() => {
      throw new Error('old close failed');
    });

    useSessionStore.setState({
      sessions: [source],
      currentSessionId: source.sessionId,
      currentSessionRef: sourceRef,
      messages: [
        createMessage({ id: 'existing-message', role: 'user', content: 'persisted' }),
      ],
      eventUnsubscribe: oldUnsubscribe,
    });

    vi.mocked(sessionService.forkSession).mockResolvedValue({
      session: child,
      messages: [
        createMessage({ id: 'history-user', role: 'user', content: 'hello child' }),
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Suppress expected cleanup warning in this test.
    });

    try {
      useSessionStore.setState({
        prepareEventSubscription: vi.fn().mockResolvedValue(replacementUnsubscribe),
        replaceEventSubscription: createActualReplaceEventSubscription(),
      });

      await useSessionStore.getState().forkSession(source);

      expect(useSessionStore.getState().sessions).toEqual([source, child]);
      expect(useSessionStore.getState().currentSessionRef).toEqual(childRef);
      expect(useSessionStore.getState().currentSessionId).toBe(child.sessionId);
      expect(useSessionStore.getState().messages).toEqual([
        expect.objectContaining({ role: 'user', content: 'hello child' }),
      ]);
      expect(useSessionStore.getState().eventUnsubscribe).toBe(replacementUnsubscribe);
      expect(useSessionStore.getState().forkingSessionRef).toBeNull();
      expect(useSessionStore.getState().error).toBeNull();
      expect(replacementUnsubscribe).not.toHaveBeenCalled();
      expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps the source view unchanged when fork route fails', async () => {
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-a',
      title: 'Parent A',
      rootId: 'root-a',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const originalMessages = [
      createMessage({
        id: 'existing-message',
        role: 'user',
        content: 'persisted',
      }),
    ];
    const originalUnsubscribe = vi.fn();

    useSessionStore.setState({
      sessions: [source],
      currentSessionId: source.sessionId,
      currentSessionRef: sourceRef,
      messages: originalMessages,
      eventUnsubscribe: originalUnsubscribe,
    });
    vi.mocked(sessionService.forkSession).mockRejectedValue(new Error('fork failed'));

    await useSessionStore.getState().forkSession(source);

    expect(useSessionStore.getState().currentSessionRef).toEqual(sourceRef);
    expect(useSessionStore.getState().currentSessionId).toBe(source.sessionId);
    expect(useSessionStore.getState().messages).toEqual(originalMessages);
    expect(useSessionStore.getState().eventUnsubscribe).toBe(originalUnsubscribe);
    expect(useSessionStore.getState().forkingSessionRef).toBeNull();
    expect(useSessionStore.getState().error).toBe('fork failed');
  });

  it('keeps the source view unchanged when child subscription preparation fails after a durable server fork', async () => {
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-a',
      title: 'Parent A',
      rootId: 'root-a',
    });
    const child = createSession({
      sessionId: 'child-id',
      projectPath: '/tmp/project-a',
      title: 'Child',
      rootId: 'root-a',
      parentId: 'shared-id',
      relationType: 'fork',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const originalUnsubscribe = vi.fn();
    const prepareEventSubscription = vi
      .fn()
      .mockRejectedValue(new Error('subscription failed'));

    useSessionStore.setState({
      sessions: [source],
      currentSessionId: source.sessionId,
      currentSessionRef: sourceRef,
      messages: [
        {
          id: 'existing-message',
          role: 'user',
          content: 'persisted',
          timestamp: Date.now(),
        },
      ],
      eventUnsubscribe: originalUnsubscribe,
      prepareEventSubscription,
    });
    vi.mocked(sessionService.forkSession).mockResolvedValue({
      session: child,
      messages: [],
    });
    vi.mocked(sessionService.listSessions).mockResolvedValue([source, child]);

    await useSessionStore.getState().forkSession(source);

    expect(useSessionStore.getState().currentSessionRef).toEqual(sourceRef);
    expect(useSessionStore.getState().eventUnsubscribe).toBe(originalUnsubscribe);
    expect(useSessionStore.getState().forkingSessionRef).toBeNull();
    expect(useSessionStore.getState().error).toBe('subscription failed');

    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState().sessions).toEqual([source, child]);
  });

  it('does not commit selectSession state until messages and subscription readiness both succeed', async () => {
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-a',
      title: 'Parent A',
      rootId: 'root-a',
    });
    const target = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-b',
      title: 'Parent B',
      rootId: 'root-b',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const targetRef = createRef(target.sessionId, target.projectPath);
    const originalUnsubscribe = vi.fn();
    const prepareEventSubscription = vi
      .fn()
      .mockRejectedValue(new Error('prepare failed'));

    useSessionStore.setState({
      sessions: [source, target],
      currentSessionId: source.sessionId,
      currentSessionRef: sourceRef,
      messages: [
        {
          id: 'source-message',
          role: 'user',
          content: 'persisted source',
          timestamp: Date.now(),
        },
      ],
      eventUnsubscribe: originalUnsubscribe,
      prepareEventSubscription,
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      createMessage({
        id: 'target-message',
        role: 'user',
        content: 'persisted target',
      }),
    ]);

    await useSessionStore.getState().selectSession(targetRef);

    expect(sessionService.getMessages).toHaveBeenCalledWith(targetRef);
    expect(prepareEventSubscription).toHaveBeenCalledWith(targetRef);
    expect(useSessionStore.getState().currentSessionRef).toEqual(sourceRef);
    expect(useSessionStore.getState().currentSessionId).toBe(source.sessionId);
    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ id: 'source-message' }),
    ]);
    expect(useSessionStore.getState().eventUnsubscribe).toBe(originalUnsubscribe);
    expect(useSessionStore.getState().error).toBe('prepare failed');
  });

  it('keeps committed target state when replacing the old subscription cleanup throws during select', async () => {
    const source = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-a',
      title: 'Parent A',
      rootId: 'root-a',
    });
    const target = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-b',
      title: 'Parent B',
      rootId: 'root-b',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const targetRef = createRef(target.sessionId, target.projectPath);
    const replacementUnsubscribe = vi.fn();
    const oldUnsubscribe = vi.fn(() => {
      throw new Error('old close failed');
    });
    const prepareEventSubscription = vi.fn().mockResolvedValue(replacementUnsubscribe);

    useSessionStore.setState({
      sessions: [source, target],
      currentSessionId: source.sessionId,
      currentSessionRef: sourceRef,
      messages: [
        createMessage({
          id: 'source-message',
          role: 'user',
          content: 'persisted source',
        }),
      ],
      eventUnsubscribe: oldUnsubscribe,
      prepareEventSubscription,
      replaceEventSubscription: createActualReplaceEventSubscription(),
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      createMessage({
        id: 'target-message',
        role: 'user',
        content: 'persisted target',
      }),
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Suppress expected cleanup warning in this test.
    });

    try {
      await useSessionStore.getState().selectSession(targetRef);

      expect(prepareEventSubscription).toHaveBeenCalledWith(targetRef);
      expect(useSessionStore.getState().currentSessionRef).toEqual(targetRef);
      expect(useSessionStore.getState().currentSessionId).toBe(target.sessionId);
      expect(useSessionStore.getState().messages).toEqual([
        expect.objectContaining({ id: 'target-message' }),
      ]);
      expect(useSessionStore.getState().eventUnsubscribe).toBe(replacementUnsubscribe);
      expect(useSessionStore.getState().error).toBeNull();
      expect(replacementUnsubscribe).not.toHaveBeenCalled();
      expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('replaces subscriptions fail-safely after setting next and resetting the global buffer', () => {
    const next = vi.fn();
    const previous = vi.fn(() => {
      throw new Error('old close failed');
    });
    const resetSpy = vi.spyOn(globalStreamingBuffer, 'reset');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Suppress expected cleanup warning in this test.
    });

    try {
      useSessionStore.setState({
        eventUnsubscribe: previous,
        replaceEventSubscription: createActualReplaceEventSubscription(),
      });

      expect(() =>
        useSessionStore.getState().replaceEventSubscription(next)
      ).not.toThrow();
      expect(useSessionStore.getState().eventUnsubscribe).toBe(next);
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(previous).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to clean up previous event subscription',
        expect.any(Error)
      );
    } finally {
      resetSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('encodes projectPath on all session-ref service routes and session directory headers', async () => {
    const { sessionDirectoryHeaders, withSessionRef } = await import(
      '../../../src/services/sessionService'
    );
    const ref = createRef('shared-id', '/tmp/project with spaces');

    expect(sessionDirectoryHeaders(ref)).toEqual({
      'x-blade-directory': '/tmp/project with spaces',
    });
    expect(withSessionRef('/sessions/shared-id/message', ref)).toBe(
      '/sessions/shared-id/message?projectPath=%2Ftmp%2Fproject%20with%20spaces'
    );
  });

  it('normalizes raw persisted history without requiring UI ids or timestamps', async () => {
    const actual = await vi.importActual<
      typeof import('../../../src/services/sessionService')
    >('../../../src/services/sessionService');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            role: 'assistant',
            content: 'persisted answer',
            reasoningContent: 'persisted reasoning',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const previousFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    try {
      const messages = await actual.sessionService.getMessages(
        createRef('persisted', '/tmp/project-a')
      );
      expect(messages).toEqual([
        expect.objectContaining({
          id: expect.stringContaining('history-0-'),
          role: 'assistant',
          content: 'persisted answer',
          thinkingContent: 'persisted reasoning',
          timestamp: expect.any(Number),
        }),
      ]);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: previousFetch,
      });
    }
  });

  it('opens event subscriptions only after onopen or connected and rejects pre-ready errors/timeouts', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];

      public onopen: (() => void) | null = null;
      public onmessage: ((event: { data: string }) => void) | null = null;
      public onerror: (() => void) | null = null;
      public closed = false;

      constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
      }

      close(): void {
        this.closed = true;
      }
    }

    vi.useFakeTimers();
    const previousDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'EventSource'
    );
    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });

    try {
      const onEvent = vi.fn();
      const actual = await vi.importActual<
        typeof import('../../../src/services/sessionService')
      >('../../../src/services/sessionService');
      const actualService = actual.sessionService;

      const readyPromise = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-a'),
        onEvent
      );
      const first = FakeEventSource.instances[0];
      expect(first).toBeDefined();
      expect(first?.url).toContain('projectPath=%2Ftmp%2Fproject-a');

      first?.onopen?.();
      const unsubscribe = await readyPromise;
      expect(typeof unsubscribe).toBe('function');

      const connectedPromise = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-b'),
        onEvent
      );
      const second = FakeEventSource.instances[1];
      expect(second).toBeDefined();
      second?.onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: {
            sessionId: 'shared-id',
            projectPath: '/tmp/project-b',
          },
        }),
      });
      await expect(connectedPromise).resolves.toEqual(expect.any(Function));

      const preReadyError = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-c'),
        onEvent
      );
      const third = FakeEventSource.instances[2];
      expect(third).toBeDefined();
      third?.onerror?.();
      await expect(preReadyError).rejects.toThrow();
      expect(third?.closed).toBe(true);

      const timeoutPromise = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-d'),
        onEvent
      );
      expect(FakeEventSource.instances[3]).toBeDefined();
      vi.advanceTimersByTime(10001);
      await expect(timeoutPromise).rejects.toThrow();
      expect(FakeEventSource.instances[3]?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
      if (previousDescriptor) {
        Object.defineProperty(globalThis, 'EventSource', previousDescriptor);
      } else {
        delete (globalThis as { EventSource?: unknown }).EventSource;
      }
    }
  });
});
