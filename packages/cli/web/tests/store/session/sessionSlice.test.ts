import type { Goal, Session, SessionRef } from '@api/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentPhase,
  SendMessagePayload,
  StreamEvent,
} from '../../../src/store/session/types';

vi.mock('../../../src/services', () => ({
  sessionService: {
    listSessions: vi.fn(),
    listSessionPage: vi.fn(),
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    deleteSession: vi.fn(),
    updateSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn(),
    getGoal: vi.fn(),
    createGoal: vi.fn(),
    updateGoal: vi.fn(),
    clearGoal: vi.fn(),
    listRewindCheckpoints: vi.fn(),
    rewindSession: vi.fn(),
    sendMessage: vi.fn(),
    executeUserShellCommand: vi.fn(),
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
import { globalStreamingBuffer } from '../../../src/store/session/handlers/streamingBuffer';
import type { Message } from '../../../src/store/session/types';

const actualReplaceEventSubscription =
  useSessionStore.getState().replaceEventSubscription;
const actualPrepareEventSubscription =
  useSessionStore.getState().prepareEventSubscription;
const actualSubscribeToEvents = useSessionStore.getState().subscribeToEvents;
const actualReconnectSessionEvents = useSessionStore.getState().reconnectSessionEvents;
const actualUnsubscribeFromEvents = useSessionStore.getState().unsubscribeFromEvents;

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/tmp/project-a',
    title: 'Session',
    gitBranch: 'main',
    rootId: 'root-session-1',
    parentId: undefined,
    relationType: undefined,
    taskStatus: 'completed',
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

function createGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    version: 1,
    sessionId: 'shared-id',
    goalId: 'goal-1',
    objective: 'Finish the exact workspace task',
    status: 'active',
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationCount: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function activeStreamingState(
  ref: SessionRef,
  eventUnsubscribe: () => void,
  agentPhase: AgentPhase = 'running'
) {
  return {
    currentSessionId: ref.sessionId,
    currentSessionRef: ref,
    isTemporarySession: false,
    isStreaming: true,
    isStopping: false,
    agentPhase,
    currentRunId: 'run-active',
    pendingSteeringCount: 2,
    pendingInputDelivery: 'current_turn' as const,
    recoveredSteeringCount: 1,
    currentAssistantMessageId: 'assistant-active',
    hasToolCalls: true,
    eventUnsubscribe,
  };
}

function expectStreamingStateReset(): void {
  expect(useSessionStore.getState()).toMatchObject({
    isStreaming: false,
    isStopping: false,
    agentPhase: 'idle',
    currentRunId: null,
    pendingSteeringCount: 0,
    pendingInputDelivery: null,
    recoveredSteeringCount: 0,
    currentAssistantMessageId: null,
    hasToolCalls: false,
    eventUnsubscribe: null,
  });
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

describe('sessionSlice multimodal sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionService.getGoal).mockResolvedValue(null);

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
      archivedSessions: [],
      currentSessionId: TEMP_SESSION_ID,
      currentSessionRef: null,
      forkingSessionRef: null,
      isTemporarySession: true,
      isLoading: false,
      catalogLoadState: 'idle',
      catalogError: null,
      archivedCatalogLoadState: 'idle',
      archivedCatalogError: null,
      error: null,
      errorContext: null,
      messages: [],
      isStreaming: false,
      isStopping: false,
      agentPhase: 'idle',
      providerRetry: null,
      sessionEventConnectionState: 'idle',
      currentRunId: null,
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
      recoveredSteeringCount: 0,
      currentAssistantMessageId: null,
      hasToolCalls: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        maxContextTokens: 128000,
        isDefaultMaxTokens: true,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      },
      eventUnsubscribe: null,
      prepareEventSubscription: vi.fn().mockResolvedValue(() => undefined),
      replaceEventSubscription: vi.fn(),
      subscribeToEvents: vi.fn(),
      reconnectSessionEvents: actualReconnectSessionEvents,
      unsubscribeFromEvents: vi.fn(),
    }));
  });

  it('adds optimistic multimodal user messages and forwards image attachments', async () => {
    useConfigStore.setState({ currentModelId: 'vision-model' });
    vi.mocked(sessionService.createSession).mockResolvedValue(
      createSession({ sessionId: 'session-1', projectPath: '/tmp/project' })
    );
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-1',
      status: 'running',
    });

    const payload: SendMessagePayload = {
      content: 'describe this image',
      reasoningEffort: 'high',
      responseVerbosity: 'high',
      communicationStyle: 'explanatory',
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
      { ...payload, modelId: 'vision-model' },
      'default'
    );
    expect(useSessionStore.getState().sessions).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        selectedModelId: 'vision-model',
        reasoningEffort: 'high',
        responseVerbosity: 'high',
        communicationStyle: 'explanatory',
      }),
    ]);
  });

  it('routes user shell input without sending a model message', async () => {
    const ref = createRef('shell-session', '/tmp/shell-workspace');
    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
      isStreaming: false,
    });
    vi.mocked(sessionService.executeUserShellCommand).mockResolvedValue({
      executionId: 'shell-execution',
      messageId: 'shell-message',
      record: {
        version: 1,
        command: 'pwd',
        status: 'completed',
        exitCode: 0,
        durationMs: 4,
        stdout: '/tmp/shell-workspace\n',
        stderr: '',
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        binaryOutput: false,
        truncated: false,
      },
      auxiliary: false,
    });

    const accepted = await useSessionStore.getState().sendMessage({
      content: '  !  pwd  ',
    });

    expect(accepted).toBe(true);
    expect(sessionService.executeUserShellCommand).toHaveBeenCalledWith(ref, 'pwd');
    expect(sessionService.sendMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: false,
      agentPhase: 'idle',
      error: null,
    });
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
      createRef('persisted-session', '/tmp/a'),
      expect.any(Function)
    );
    expect(replaceEventSubscription).toHaveBeenCalled();
    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'persisted' }),
    ]);
  });

  it('restores the exact session permission mode when selecting history', async () => {
    const setMode = vi.fn();
    useConfigStore.setState({ setMode });
    const session = createSession({
      sessionId: 'persisted-yolo',
      projectPath: '/tmp/yolo',
      permissionMode: 'yolo',
    });
    useSessionStore.setState({ sessions: [session] });
    vi.mocked(sessionService.getMessages).mockResolvedValue([]);

    await useSessionStore
      .getState()
      .selectSession(createRef(session.sessionId, session.projectPath));

    expect(setMode).toHaveBeenCalledWith('yolo');
  });

  it('resets a previously resumed YOLO mode before starting a temporary task', () => {
    useConfigStore.setState({ currentMode: 'yolo' });

    useSessionStore.getState().startTemporarySession('/tmp/new-task');

    expect(useConfigStore.getState().currentMode).toBe('autoEdit');
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: TEMP_SESSION_ID,
      currentSessionRef: null,
      isTemporarySession: true,
    });
  });

  it('restores durable task failure diagnostics when selecting after refresh', async () => {
    const ref = createRef('failed-task', '/tmp/failed-task');
    const failedSession = createSession({
      ...ref,
      taskStatus: 'failed',
      taskRetryAvailable: true,
      taskFailure: {
        code: 'timeout',
        message: 'Provider request timed out.',
        retryable: true,
      },
    });
    useSessionStore.setState({
      sessions: [failedSession],
      error: null,
      errorContext: null,
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([]);

    await useSessionStore.getState().selectSession(ref);

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: ref,
      error: 'Provider request timed out.',
      errorContext: {
        kind: 'execution',
        failureCode: 'timeout',
        sessionRef: ref,
      },
    });
  });

  it('hydrates an unknown worktree deep link and selects its bound source project', async () => {
    const ref = createRef('task-worktree', '/workspace/internal-worktree');
    const exactSession = createSession({
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
      taskSourceProjectPath: '/workspace/source',
      taskWorktreePath: '/workspace/internal-worktree',
    });
    const prepareEventSubscription = vi.fn().mockResolvedValue(() => undefined);
    useSessionStore.setState({
      sessions: [],
      boundProjects: [
        {
          path: '/workspace/source',
          name: 'source',
          available: true,
          isCurrent: true,
          boundAt: '2026-08-07T00:00:00.000Z',
        },
      ],
      selectedProjectPath: null,
      prepareEventSubscription,
    });
    vi.mocked(sessionService.getSession).mockResolvedValue(exactSession);
    vi.mocked(sessionService.getMessages).mockResolvedValue([]);

    await useSessionStore.getState().selectSession(ref);

    expect(sessionService.getSession).toHaveBeenCalledWith(ref);
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: ref,
      selectedProjectPath: '/workspace/source',
      sessions: [
        expect.objectContaining({
          sessionId: ref.sessionId,
          projectPath: ref.projectPath,
          taskSourceProjectPath: '/workspace/source',
        }),
      ],
    });
  });

  it('buffers replayed permission events until the selected session is committed', async () => {
    const sourceRef = createRef('source-session', '/tmp/source');
    const targetRef = createRef('target-session', '/tmp/target');
    const replacementUnsubscribe = vi.fn();
    const prepareEventSubscription = vi.fn(
      async (_ref: SessionRef, onEvent?: (event: StreamEvent) => void) => {
        onEvent?.({
          type: 'permission.asked',
          properties: {
            sessionId: targetRef.sessionId,
            projectPath: targetRef.projectPath,
            requestId: 'permission-replay',
            toolName: 'Write',
            description: 'Write the queued proof',
            replayed: true,
          },
        });
        return replacementUnsubscribe;
      }
    );
    useSessionStore.setState({
      currentSessionId: sourceRef.sessionId,
      currentSessionRef: sourceRef,
      messages: [],
      prepareEventSubscription,
      replaceEventSubscription: actualReplaceEventSubscription,
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([]);

    await useSessionStore.getState().selectSession(targetRef);

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: targetRef.sessionId,
      currentSessionRef: targetRef,
      agentPhase: 'waiting_permission',
      isStreaming: true,
      messages: [
        expect.objectContaining({
          id: 'assistant-permission-permission-replay',
          agentContent: expect.objectContaining({
            confirmation: expect.objectContaining({
              toolCallId: 'permission-replay',
              status: 'pending',
            }),
          }),
        }),
      ],
    });
    expect(useSessionStore.getState().eventUnsubscribe).toBe(replacementUnsubscribe);
  });

  it('replaces stale run state with the selected session status snapshot', async () => {
    const sourceRef = createRef('source-session', '/tmp/source');
    const targetRef = createRef('target-session', '/tmp/target');
    const oldUnsubscribe = vi.fn();
    const nextUnsubscribe = vi.fn();
    const prepareEventSubscription = vi.fn(
      async (_ref: SessionRef, onEvent?: (event: StreamEvent) => void) => {
        onEvent?.({
          type: 'session.status',
          properties: {
            sessionId: targetRef.sessionId,
            projectPath: targetRef.projectPath,
            status: 'running',
            runId: 'target-run',
            queued: 1,
            pendingInputDelivery: 'next_turn',
            recovered: 1,
          },
        });
        return nextUnsubscribe;
      }
    );
    useSessionStore.setState({
      ...activeStreamingState(sourceRef, oldUnsubscribe),
      currentRunId: 'source-run',
      pendingSteeringCount: 4,
      pendingInputDelivery: 'current_turn',
      prepareEventSubscription,
      replaceEventSubscription: actualReplaceEventSubscription,
    });
    vi.mocked(sessionService.getMessages).mockResolvedValue([]);

    await useSessionStore.getState().selectSession(targetRef);

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: targetRef,
      isStreaming: true,
      agentPhase: 'running',
      currentRunId: 'target-run',
      pendingSteeringCount: 1,
      pendingInputDelivery: 'next_turn',
      recoveredSteeringCount: 1,
      eventUnsubscribe: nextUnsubscribe,
    });
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
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
    useConfigStore.setState({ currentModelId: 'model-next-turn' });
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
      modelId: 'model-next-turn',
    });

    expect(sessionService.sendMessage).toHaveBeenLastCalledWith(
      createRef('session-active', '/tmp/project-active'),
      { content: 'Use the updated requirement.' },
      'default'
    );
    expect(subscribeToEvents).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      currentRunId: 'run-active',
      isStreaming: true,
      pendingSteeringCount: 2,
      pendingInputDelivery: 'current_turn',
    });

    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-active',
      status: 'follow_up_queued',
      queued: 1,
    });
    await useSessionStore.getState().sendMessage({
      content: 'Run this after the current answer.',
    });
    expect(useSessionStore.getState()).toMatchObject({
      pendingSteeringCount: 1,
      pendingInputDelivery: 'next_turn',
    });
  });

  it('rolls back rejected steering without stopping the active run', async () => {
    const currentRef = createRef('session-active', '/tmp/project-active');
    const unsubscribe = vi.fn();
    const existingMessage = createMessage({
      id: 'assistant-active',
      role: 'assistant',
      content: 'Still working',
    });
    useSessionStore.setState({
      ...activeStreamingState(currentRef, unsubscribe, 'compacting'),
      messages: [existingMessage],
      error: null,
    });
    vi.mocked(sessionService.sendMessage).mockRejectedValue(new Error('queue_full'));

    const accepted = await useSessionStore.getState().sendMessage({
      content: 'Do this next',
    });

    expect(accepted).toBe(false);
    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: true,
      agentPhase: 'compacting',
      currentRunId: 'run-active',
      pendingSteeringCount: 2,
      error: 'queue_full',
      errorContext: { kind: 'submission', sessionRef: currentRef },
      messages: [existingMessage],
    });
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('rolls back a rejected initial message and reports that it was not accepted', async () => {
    const currentRef = createRef('session-idle', '/tmp/project-idle');
    const existingMessage = createMessage({
      id: 'existing-message',
      role: 'assistant',
      content: 'Previous answer',
    });
    useSessionStore.setState({
      currentSessionId: currentRef.sessionId,
      currentSessionRef: currentRef,
      isTemporarySession: false,
      isStreaming: false,
      messages: [existingMessage],
    });
    vi.mocked(sessionService.sendMessage).mockRejectedValue(
      new Error('turn_unavailable')
    );

    const accepted = await useSessionStore.getState().sendMessage({
      content: 'Try this request',
    });

    expect(accepted).toBe(false);
    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: false,
      agentPhase: 'idle',
      currentRunId: null,
      error: 'turn_unavailable',
      errorContext: { kind: 'submission', sessionRef: currentRef },
      messages: [existingMessage],
    });
  });

  it('keeps the run connected until stopping is confirmed and deduplicates stop requests', async () => {
    const currentRef = createRef('session-active', '/tmp/project-active');
    const unsubscribeFromEvents = vi.fn();
    const stopGate = deferred<void>();
    useSessionStore.setState({
      ...activeStreamingState(currentRef, vi.fn()),
      unsubscribeFromEvents,
    });
    vi.mocked(sessionService.abortSession).mockReturnValue(stopGate.promise);

    const stopping = useSessionStore.getState().abortSession();
    const duplicate = useSessionStore.getState().abortSession();
    await expect(duplicate).resolves.toBe(false);
    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: true,
      isStopping: true,
      currentRunId: 'run-active',
    });
    expect(unsubscribeFromEvents).not.toHaveBeenCalled();
    expect(sessionService.abortSession).toHaveBeenCalledOnce();

    stopGate.resolve();
    await expect(stopping).resolves.toBe(true);
    expect(unsubscribeFromEvents).toHaveBeenCalledOnce();
    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: false,
      isStopping: false,
      currentRunId: null,
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
    });
  });

  it('keeps the active run and event stream when stopping fails', async () => {
    const currentRef = createRef('session-active', '/tmp/project-active');
    const unsubscribeFromEvents = vi.fn();
    useSessionStore.setState({
      ...activeStreamingState(currentRef, vi.fn()),
      unsubscribeFromEvents,
    });
    vi.mocked(sessionService.abortSession).mockRejectedValue(
      new Error('stop unavailable')
    );

    await expect(useSessionStore.getState().abortSession()).resolves.toBe(false);
    expect(unsubscribeFromEvents).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      isStreaming: true,
      isStopping: false,
      currentRunId: 'run-active',
      error: 'stop unavailable',
    });
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
    const prepareEventSubscription = vi
      .fn()
      .mockRejectedValue(new Error('sse unavailable'));
    const replaceEventSubscription = vi.fn();

    useSessionStore.setState({
      currentSessionId: currentRef.sessionId,
      currentSessionRef: currentRef,
      isTemporarySession: false,
      isStreaming: false,
      messages: existingMessages,
      prepareEventSubscription,
      replaceEventSubscription,
    });

    await useSessionStore.getState().sendMessage({ content: 'hello' });

    expect(prepareEventSubscription).toHaveBeenCalledWith(currentRef);
    expect(replaceEventSubscription).not.toHaveBeenCalled();
    expect(sessionService.sendMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages).toEqual(existingMessages);
    expect(useSessionStore.getState().isStreaming).toBe(false);
    expect(useSessionStore.getState().error).toBe('sse unavailable');
    expect(useSessionStore.getState().currentSessionRef).toEqual(currentRef);
    expect(useSessionStore.getState().currentSessionId).toBe(currentRef.sessionId);
  });

  it('keeps a created temporary session durable without activating or sending after navigation changes', async () => {
    const created = createSession({
      sessionId: 'created-stale',
      projectPath: '/tmp/created-stale',
    });
    const createGate = deferred<Session>();
    const prepareEventSubscription = vi.fn();
    const replaceEventSubscription = vi.fn();

    vi.mocked(sessionService.createSession).mockReturnValue(createGate.promise);
    useSessionStore.setState({
      prepareEventSubscription,
      replaceEventSubscription,
    });

    const send = useSessionStore.getState().sendMessage({ content: 'stale send' });
    useSessionStore.getState().startTemporarySession();
    createGate.resolve(created);
    await send;

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [created],
      currentSessionId: TEMP_SESSION_ID,
      currentSessionRef: null,
      isTemporarySession: true,
      messages: [],
      isStreaming: false,
      currentRunId: null,
      error: null,
    });
    expect(prepareEventSubscription).not.toHaveBeenCalled();
    expect(replaceEventSubscription).not.toHaveBeenCalled();
    expect(sessionService.sendMessage).not.toHaveBeenCalled();
  });

  it('closes a stale prepared send subscription without replacing or posting after selecting another session', async () => {
    const refA = createRef('session-a', '/tmp/a');
    const refB = createRef('session-b', '/tmp/b');
    const preparedA = deferred<() => void>();
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const replaceEventSubscription = vi.fn();
    const prepareEventSubscription = vi.fn((ref: SessionRef) =>
      ref.sessionId === refA.sessionId
        ? preparedA.promise
        : Promise.resolve(unsubscribeB)
    );

    vi.mocked(sessionService.getMessages).mockResolvedValue([
      createMessage({ id: 'message-b', role: 'user', content: 'B' }),
    ]);
    useSessionStore.setState({
      currentSessionId: refA.sessionId,
      currentSessionRef: refA,
      isTemporarySession: false,
      isStreaming: false,
      messages: [],
      prepareEventSubscription,
      replaceEventSubscription,
      subscribeToEvents: actualSubscribeToEvents,
    });

    const send = useSessionStore.getState().sendMessage({ content: 'send A' });
    await flushMicrotasks();
    expect(prepareEventSubscription).toHaveBeenCalledWith(refA);

    await useSessionStore.getState().selectSession(refB);
    preparedA.resolve(unsubscribeA);
    await send;

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      messages: [expect.objectContaining({ id: 'message-b' })],
      error: null,
    });
    expect(replaceEventSubscription).toHaveBeenCalledTimes(1);
    expect(replaceEventSubscription).toHaveBeenCalledWith(unsubscribeB);
    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(sessionService.sendMessage).not.toHaveBeenCalled();
  });

  it('does not apply a stale send response to the newly selected session', async () => {
    const refA = createRef('session-a', '/tmp/a');
    const refB = createRef('session-b', '/tmp/b');
    const response = deferred<{ runId: string; status: string; queued?: number }>();
    const unsubscribeB = vi.fn();

    vi.mocked(sessionService.sendMessage).mockReturnValue(response.promise);
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      createMessage({ id: 'message-b', role: 'user', content: 'B' }),
    ]);
    useSessionStore.setState({
      currentSessionId: refA.sessionId,
      currentSessionRef: refA,
      isTemporarySession: false,
      isStreaming: true,
      currentRunId: 'run-a',
      pendingSteeringCount: 0,
      messages: [],
      prepareEventSubscription: vi.fn().mockResolvedValue(unsubscribeB),
      replaceEventSubscription: vi.fn(),
    });

    const send = useSessionStore.getState().sendMessage({ content: 'send A' });
    await flushMicrotasks();
    expect(sessionService.sendMessage).toHaveBeenCalled();

    await useSessionStore.getState().selectSession(refB);
    const stateAfterSelection = useSessionStore.getState();
    response.resolve({ runId: 'stale-run-a', status: 'steering_queued', queued: 4 });
    await send;

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      messages: [expect.objectContaining({ id: 'message-b' })],
      currentRunId: stateAfterSelection.currentRunId,
      pendingSteeringCount: stateAfterSelection.pendingSteeringCount,
      isStreaming: stateAfterSelection.isStreaming,
      error: stateAfterSelection.error,
    });
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

  it('creates a temporary session in the explicitly focused workspace', async () => {
    vi.mocked(sessionService.createSession).mockResolvedValue(
      createSession({ sessionId: 'created-focused', projectPath: '/workspace/focused' })
    );
    vi.mocked(sessionService.sendMessage).mockResolvedValue({
      runId: 'run-focused',
      status: 'running',
    });

    useSessionStore.getState().startTemporarySession('/workspace/focused');
    await useSessionStore.getState().sendMessage({ content: 'inspect this workspace' });

    expect(useSessionStore.getState().selectedProjectPath).toBe('/workspace/focused');
    expect(sessionService.createSession).toHaveBeenCalledWith(
      '/workspace/focused',
      'inspect this workspace'
    );
  });

  it('closes the active subscription and resets streaming state when starting a temporary session', () => {
    const unsubscribeFromEvents = vi.fn();
    useSessionStore.setState({
      ...activeStreamingState(
        createRef('active', '/tmp/project-active'),
        vi.fn(),
        'waiting_permission'
      ),
      unsubscribeFromEvents,
    });

    useSessionStore.getState().startTemporarySession();

    expect(unsubscribeFromEvents).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionId: TEMP_SESSION_ID,
      currentSessionRef: null,
      isTemporarySession: true,
    });
    expectStreamingStateReset();
  });

  it('closes the active subscription and resets streaming state when deleting the current session', async () => {
    const current = createSession({
      sessionId: 'current',
      projectPath: '/tmp/current',
    });
    const unsubscribeFromEvents = vi.fn();
    useSessionStore.setState({
      sessions: [current],
      ...activeStreamingState(
        createRef(current.sessionId, current.projectPath),
        vi.fn()
      ),
      unsubscribeFromEvents,
    });

    await useSessionStore
      .getState()
      .deleteSession(createRef(current.sessionId, current.projectPath));

    expect(unsubscribeFromEvents).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState()).toMatchObject({
      sessions: [],
      currentSessionId: null,
      currentSessionRef: null,
    });
    expectStreamingStateReset();
  });

  it('preserves the active subscription and streaming state when deleting another session', async () => {
    const current = createSession({
      sessionId: 'current',
      projectPath: '/tmp/current',
    });
    const other = createSession({ sessionId: 'other', projectPath: '/tmp/other' });
    const activeUnsubscribe = vi.fn();
    const unsubscribeFromEvents = vi.fn();
    useSessionStore.setState({
      sessions: [current, other],
      currentSessionId: current.sessionId,
      currentSessionRef: createRef(current.sessionId, current.projectPath),
      isStreaming: true,
      agentPhase: 'running',
      currentRunId: 'run-current',
      pendingSteeringCount: 3,
      recoveredSteeringCount: 2,
      currentAssistantMessageId: 'assistant-current',
      hasToolCalls: true,
      eventUnsubscribe: activeUnsubscribe,
      unsubscribeFromEvents,
    });

    await useSessionStore
      .getState()
      .deleteSession(createRef(other.sessionId, other.projectPath));

    expect(unsubscribeFromEvents).not.toHaveBeenCalled();
    expect(activeUnsubscribe).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      sessions: [current],
      currentSessionId: current.sessionId,
      currentSessionRef: createRef(current.sessionId, current.projectPath),
      isStreaming: true,
      agentPhase: 'running',
      currentRunId: 'run-current',
      pendingSteeringCount: 3,
      recoveredSteeringCount: 2,
      currentAssistantMessageId: 'assistant-current',
      hasToolCalls: true,
      eventUnsubscribe: activeUnsubscribe,
    });
  });

  it('removes a deleted session without disrupting a newer pending selection', async () => {
    const sessionA = createSession({ sessionId: 'session-a', projectPath: '/tmp/a' });
    const sessionB = createSession({ sessionId: 'session-b', projectPath: '/tmp/b' });
    const refA = createRef(sessionA.sessionId, sessionA.projectPath);
    const refB = createRef(sessionB.sessionId, sessionB.projectPath);
    const deleteGate = deferred<void>();
    const messagesB = deferred<Message[]>();
    const unsubscribeFromEvents = vi.fn();
    const unsubscribeB = vi.fn();
    const replaceEventSubscription = vi.fn();
    const originalMessages = [
      createMessage({ id: 'message-a', role: 'user', content: 'A' }),
    ];

    vi.mocked(sessionService.deleteSession).mockReturnValue(deleteGate.promise);
    vi.mocked(sessionService.getMessages).mockReturnValue(messagesB.promise);
    useSessionStore.setState({
      sessions: [sessionA, sessionB],
      currentSessionId: sessionA.sessionId,
      currentSessionRef: refA,
      isTemporarySession: false,
      messages: originalMessages,
      error: null,
      eventUnsubscribe: vi.fn(),
      unsubscribeFromEvents,
      prepareEventSubscription: vi.fn().mockResolvedValue(unsubscribeB),
      replaceEventSubscription,
    });

    const deletion = useSessionStore.getState().deleteSession(refA);
    const selection = useSessionStore.getState().selectSession(refB);
    deleteGate.resolve();
    await deletion;

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [sessionB],
      currentSessionRef: refA,
      messages: originalMessages,
      isLoading: true,
      error: null,
    });
    expect(unsubscribeFromEvents).not.toHaveBeenCalled();

    messagesB.resolve([createMessage({ id: 'message-b', role: 'user', content: 'B' })]);
    await selection;

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [sessionB],
      currentSessionRef: refB,
      messages: [expect.objectContaining({ id: 'message-b' })],
      isLoading: false,
      error: null,
    });
    expect(replaceEventSubscription).toHaveBeenCalledWith(unsubscribeB);
  });

  it('does not report a stale current-session deletion failure in a newer selection', async () => {
    const sessionA = createSession({ sessionId: 'session-a', projectPath: '/tmp/a' });
    const sessionB = createSession({ sessionId: 'session-b', projectPath: '/tmp/b' });
    const refA = createRef(sessionA.sessionId, sessionA.projectPath);
    const refB = createRef(sessionB.sessionId, sessionB.projectPath);
    const deleteGate = deferred<void>();

    vi.mocked(sessionService.deleteSession).mockReturnValue(deleteGate.promise);
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      createMessage({ id: 'message-b', role: 'user', content: 'B' }),
    ]);
    useSessionStore.setState({
      sessions: [sessionA, sessionB],
      currentSessionId: sessionA.sessionId,
      currentSessionRef: refA,
      isTemporarySession: false,
      error: null,
      prepareEventSubscription: vi.fn().mockResolvedValue(vi.fn()),
      replaceEventSubscription: vi.fn(),
    });

    const deletion = useSessionStore.getState().deleteSession(refA);
    await useSessionStore.getState().selectSession(refB);
    deleteGate.reject(new Error('delete A failed'));
    await deletion;

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [sessionA, sessionB],
      currentSessionRef: refB,
      messages: [expect.objectContaining({ id: 'message-b' })],
      isLoading: false,
      error: null,
    });
  });

  it('clears a session selected while its earlier non-current deletion is pending', async () => {
    const sessionA = createSession({ sessionId: 'session-a', projectPath: '/tmp/a' });
    const sessionB = createSession({ sessionId: 'session-b', projectPath: '/tmp/b' });
    const refA = createRef(sessionA.sessionId, sessionA.projectPath);
    const refB = createRef(sessionB.sessionId, sessionB.projectPath);
    const deleteGate = deferred<void>();
    const unsubscribeFromEvents = vi.fn();
    const unsubscribeA = vi.fn();

    vi.mocked(sessionService.deleteSession).mockReturnValue(deleteGate.promise);
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      createMessage({ id: 'message-a', role: 'user', content: 'A' }),
    ]);
    useSessionStore.setState({
      sessions: [sessionA, sessionB],
      currentSessionId: sessionB.sessionId,
      currentSessionRef: refB,
      isTemporarySession: false,
      prepareEventSubscription: vi.fn().mockResolvedValue(unsubscribeA),
      replaceEventSubscription: vi.fn(),
      unsubscribeFromEvents,
    });

    const deletion = useSessionStore.getState().deleteSession(refA);
    await useSessionStore.getState().selectSession(refA);
    useSessionStore.setState({
      isStreaming: true,
      agentPhase: 'running',
      currentRunId: 'run-a',
      pendingSteeringCount: 2,
      recoveredSteeringCount: 1,
      currentAssistantMessageId: 'assistant-a',
      hasToolCalls: true,
      eventUnsubscribe: unsubscribeA,
    });

    deleteGate.resolve();
    await deletion;

    expect(unsubscribeFromEvents).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState()).toMatchObject({
      sessions: [sessionB],
      currentSessionId: null,
      currentSessionRef: null,
      messages: [],
      isStreaming: false,
      agentPhase: 'idle',
      currentRunId: null,
      pendingSteeringCount: 0,
      recoveredSteeringCount: 0,
      currentAssistantMessageId: null,
      hasToolCalls: false,
      eventUnsubscribe: null,
    });
  });

  it('cancels a pending fork when its non-current source is asynchronously deleted', async () => {
    const source = createSession({ sessionId: 'source', projectPath: '/tmp/source' });
    const current = createSession({
      sessionId: 'current',
      projectPath: '/tmp/current',
    });
    const child = createSession({
      sessionId: 'child',
      projectPath: source.projectPath,
      rootId: source.rootId,
      parentId: source.sessionId,
      relationType: 'fork',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const currentRef = createRef(current.sessionId, current.projectPath);
    const forkGate = deferred<{ session: Session; messages: Message[] }>();
    const deleteGate = deferred<void>();
    const prepareEventSubscription = vi.fn();
    const replaceEventSubscription = vi.fn();

    vi.mocked(sessionService.forkSession).mockReturnValue(forkGate.promise);
    vi.mocked(sessionService.deleteSession).mockReturnValue(deleteGate.promise);
    useSessionStore.setState({
      sessions: [source, current],
      currentSessionId: current.sessionId,
      currentSessionRef: currentRef,
      isTemporarySession: false,
      prepareEventSubscription,
      replaceEventSubscription,
    });

    const fork = useSessionStore.getState().forkSession(source);
    expect(useSessionStore.getState().forkingSessionRef).toEqual(sourceRef);

    const deletion = useSessionStore.getState().deleteSession(sourceRef);
    expect(useSessionStore.getState().forkingSessionRef).toBeNull();
    deleteGate.resolve();
    await deletion;

    forkGate.resolve({
      session: child,
      messages: [
        createMessage({ id: 'child-message', role: 'user', content: 'child' }),
      ],
    });
    await fork;

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [current, child],
      currentSessionId: current.sessionId,
      currentSessionRef: currentRef,
      forkingSessionRef: null,
    });
    expect(prepareEventSubscription).not.toHaveBeenCalled();
    expect(replaceEventSubscription).not.toHaveBeenCalled();
  });

  it('cancels a pending fork when its non-current source is synchronously removed', async () => {
    const source = createSession({ sessionId: 'source', projectPath: '/tmp/source' });
    const current = createSession({
      sessionId: 'current',
      projectPath: '/tmp/current',
    });
    const child = createSession({
      sessionId: 'child',
      projectPath: source.projectPath,
      rootId: source.rootId,
      parentId: source.sessionId,
      relationType: 'fork',
    });
    const sourceRef = createRef(source.sessionId, source.projectPath);
    const currentRef = createRef(current.sessionId, current.projectPath);
    const forkGate = deferred<{ session: Session; messages: Message[] }>();
    const prepareEventSubscription = vi.fn();
    const replaceEventSubscription = vi.fn();

    vi.mocked(sessionService.forkSession).mockReturnValue(forkGate.promise);
    useSessionStore.setState({
      sessions: [source, current],
      currentSessionId: current.sessionId,
      currentSessionRef: currentRef,
      isTemporarySession: false,
      prepareEventSubscription,
      replaceEventSubscription,
    });

    const fork = useSessionStore.getState().forkSession(source);
    expect(useSessionStore.getState().forkingSessionRef).toEqual(sourceRef);

    useSessionStore.getState().removeSession(sourceRef);
    expect(useSessionStore.getState()).toMatchObject({
      sessions: [current],
      currentSessionRef: currentRef,
      forkingSessionRef: null,
    });

    forkGate.resolve({
      session: child,
      messages: [
        createMessage({ id: 'child-message', role: 'user', content: 'child' }),
      ],
    });
    await fork;

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [current, child],
      currentSessionId: current.sessionId,
      currentSessionRef: currentRef,
      forkingSessionRef: null,
    });
    expect(prepareEventSubscription).not.toHaveBeenCalled();
    expect(replaceEventSubscription).not.toHaveBeenCalled();
  });

  it('resets the active subscription and streaming state when synchronously removing the current session', () => {
    const current = createSession({
      sessionId: 'current',
      projectPath: '/tmp/current',
    });
    const unsubscribeFromEvents = vi.fn();
    useSessionStore.setState({
      sessions: [current],
      ...activeStreamingState(
        createRef(current.sessionId, current.projectPath),
        vi.fn(),
        'compacting'
      ),
      unsubscribeFromEvents,
    });

    useSessionStore
      .getState()
      .removeSession(createRef(current.sessionId, current.projectPath));

    expect(unsubscribeFromEvents).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState()).toMatchObject({
      sessions: [],
      currentSessionId: null,
      currentSessionRef: null,
    });
    expectStreamingStateReset();
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

  it('loads one exact session with its compound workspace identity', async () => {
    const session = createSession({
      sessionId: 'shared-id',
      projectPath: '/tmp/project-b',
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { sessionService: actualSessionService } = await vi.importActual<
      typeof import('../../../src/services/sessionService')
    >('../../../src/services/sessionService');

    await expect(
      actualSessionService.getSession({
        sessionId: 'shared-id',
        projectPath: '/tmp/project-b',
      })
    ).resolves.toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith(
      '/sessions/shared-id?projectPath=%2Ftmp%2Fproject-b',
      undefined
    );
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
        replaceEventSubscription: actualReplaceEventSubscription,
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
    vi.mocked(sessionService.listSessionPage).mockResolvedValue({
      sessions: [source, child],
    });

    await useSessionStore.getState().forkSession(source);

    expect(useSessionStore.getState().currentSessionRef).toEqual(sourceRef);
    expect(useSessionStore.getState().eventUnsubscribe).toBe(originalUnsubscribe);
    expect(useSessionStore.getState().forkingSessionRef).toBeNull();
    expect(useSessionStore.getState().error).toBe('subscription failed');

    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState().sessions).toEqual([source, child]);
  });

  it('renders the first catalog page while loading remaining sessions', async () => {
    const first = createSession({
      sessionId: 'first-page',
      title: 'First page',
    });
    const second = createSession({
      sessionId: 'second-page',
      title: 'Second page',
    });
    const remainingPage = deferred<{
      sessions: Session[];
      nextCursor?: string;
    }>();
    vi.mocked(sessionService.listSessionPage)
      .mockResolvedValueOnce({
        sessions: [first],
        nextCursor: 'next-page',
      })
      .mockReturnValueOnce(remainingPage.promise);

    const loading = useSessionStore.getState().loadSessions();

    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessions).toEqual([first]);
    });
    expect(useSessionStore.getState().isLoading).toBe(false);
    expect(useSessionStore.getState().catalogLoadState).toBe('hydrating');
    expect(sessionService.listSessionPage).toHaveBeenCalledTimes(1);

    remainingPage.resolve({ sessions: [second] });
    await loading;

    expect(useSessionStore.getState().sessions).toEqual([first, second]);
    expect(useSessionStore.getState().catalogLoadState).toBe('ready');
    expect(useSessionStore.getState().catalogError).toBeNull();
    expect(sessionService.listSessionPage).toHaveBeenNthCalledWith(1, undefined);
    expect(sessionService.listSessionPage).toHaveBeenNthCalledWith(2, 'next-page');
  });

  it('keeps the first catalog page visible when background hydration fails', async () => {
    const first = createSession({
      sessionId: 'first-page',
      title: 'First page',
    });
    vi.mocked(sessionService.listSessionPage)
      .mockResolvedValueOnce({
        sessions: [first],
        nextCursor: 'next-page',
      })
      .mockRejectedValueOnce(new Error('history unavailable'));

    await useSessionStore.getState().loadSessions();

    expect(useSessionStore.getState()).toMatchObject({
      sessions: [first],
      catalogLoadState: 'error',
      catalogError: 'history unavailable',
      error: null,
      isLoading: false,
    });
  });

  it('loads archived sessions through an independently paginated catalog', async () => {
    const archived = createSession({
      sessionId: 'archived-root',
      archivedAt: '2026-08-09T00:00:00.000Z',
      archivedBySessionId: 'archived-root',
    });
    vi.mocked(sessionService.listSessionPage).mockResolvedValue({
      sessions: [archived],
    });

    await useSessionStore.getState().loadArchivedSessions();

    expect(sessionService.listSessionPage).toHaveBeenCalledWith(undefined, 50, true);
    expect(useSessionStore.getState()).toMatchObject({
      archivedSessions: [archived],
      archivedCatalogLoadState: 'ready',
      archivedCatalogError: null,
    });
  });

  it('archives a session tree, clears an archived current descendant, and refreshes the archive', async () => {
    const root = createSession({
      sessionId: 'archive-root',
      projectPath: '/tmp/archive',
    });
    const child = createSession({
      sessionId: 'archive-child',
      projectPath: '/tmp/archive',
      rootId: root.sessionId,
      parentId: root.sessionId,
      relationType: 'fork',
    });
    const unrelated = createSession({
      sessionId: 'unrelated',
      projectPath: '/tmp/archive',
    });
    const archivedRoot = {
      ...root,
      archivedAt: '2026-08-09T00:02:00.000Z',
      archivedBySessionId: root.sessionId,
    };
    const archivedChild = {
      ...child,
      archivedAt: archivedRoot.archivedAt,
      archivedBySessionId: root.sessionId,
    };
    const unsubscribe = vi.fn();
    useSessionStore.setState({
      sessions: [root, child, unrelated],
      currentSessionId: child.sessionId,
      currentSessionRef: createRef(child.sessionId, child.projectPath),
      messages: [
        {
          id: 'message',
          role: 'assistant',
          content: 'visible',
          timestamp: Date.now(),
        },
      ],
      eventUnsubscribe: unsubscribe,
      unsubscribeFromEvents: actualUnsubscribeFromEvents,
    });
    vi.mocked(sessionService.archiveSession).mockResolvedValue({
      session: archivedRoot,
      archivedSessionIds: [root.sessionId, child.sessionId],
    });
    vi.mocked(sessionService.listSessionPage).mockResolvedValue({
      sessions: [archivedRoot, archivedChild],
    });

    await useSessionStore
      .getState()
      .archiveSession(createRef(root.sessionId, root.projectPath));

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useSessionStore.getState()).toMatchObject({
      sessions: [unrelated],
      archivedSessions: [archivedRoot, archivedChild],
      currentSessionId: null,
      currentSessionRef: null,
      messages: [],
    });
  });

  it('restores an archive root to the active catalog', async () => {
    const archived = createSession({
      sessionId: 'archive-root',
      projectPath: '/tmp/archive',
      archivedAt: '2026-08-09T00:02:00.000Z',
      archivedBySessionId: 'archive-root',
    });
    const restored = createSession({
      sessionId: archived.sessionId,
      projectPath: archived.projectPath,
    });
    useSessionStore.setState({ archivedSessions: [archived] });
    vi.mocked(sessionService.unarchiveSession).mockResolvedValue({
      session: restored,
      restoredSessionIds: [restored.sessionId],
    });
    vi.mocked(sessionService.listSessionPage)
      .mockResolvedValueOnce({ sessions: [restored] })
      .mockResolvedValueOnce({ sessions: [] });

    await useSessionStore
      .getState()
      .unarchiveSession(createRef(archived.sessionId, archived.projectPath));

    expect(useSessionStore.getState().sessions).toContainEqual(restored);
    expect(useSessionStore.getState().archivedSessions).toEqual([]);
  });

  it('does not let catalog completion clear an active session navigation', async () => {
    const target = createSession({
      sessionId: 'navigation-target',
      projectPath: '/tmp/navigation-target',
    });
    const targetRef = createRef(target.sessionId, target.projectPath);
    const messages = deferred<Message[]>();
    useSessionStore.setState({
      sessions: [target],
      prepareEventSubscription: vi.fn().mockResolvedValue(() => undefined),
    });
    vi.mocked(sessionService.getMessages).mockReturnValue(messages.promise);
    vi.mocked(sessionService.listSessionPage).mockResolvedValue({
      sessions: [target],
    });

    const selection = useSessionStore.getState().selectSession(targetRef);
    expect(useSessionStore.getState().isLoading).toBe(true);

    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState()).toMatchObject({
      isLoading: true,
      catalogLoadState: 'ready',
    });

    messages.resolve([]);
    await selection;
    expect(useSessionStore.getState().isLoading).toBe(false);
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
    expect(prepareEventSubscription).toHaveBeenCalledWith(
      targetRef,
      expect.any(Function)
    );
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
      replaceEventSubscription: actualReplaceEventSubscription,
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

      expect(prepareEventSubscription).toHaveBeenCalledWith(
        targetRef,
        expect.any(Function)
      );
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

  it('keeps the last selected session when an earlier prepared selection finishes later', async () => {
    const refA = createRef('session-a', '/tmp/project-a');
    const refB = createRef('session-b', '/tmp/project-b');
    const messagesA = deferred<Message[]>();
    const preparedA = deferred<() => void>();
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const replaceEventSubscription = vi.fn();

    vi.mocked(sessionService.getMessages).mockImplementation((ref) => {
      if (ref.sessionId === refA.sessionId) return messagesA.promise;
      return Promise.resolve([
        createMessage({ id: 'message-b', role: 'user', content: 'B' }),
      ]);
    });

    const prepareEventSubscription = vi.fn((ref: SessionRef) => {
      if (ref.sessionId === refA.sessionId) return preparedA.promise;
      return Promise.resolve(unsubscribeB);
    });
    useSessionStore.setState({
      prepareEventSubscription,
      replaceEventSubscription,
    });

    const selectA = useSessionStore.getState().selectSession(refA);
    messagesA.resolve([createMessage({ id: 'message-a', role: 'user', content: 'A' })]);
    await flushMicrotasks();
    expect(prepareEventSubscription).toHaveBeenCalledWith(refA, expect.any(Function));

    const selectB = useSessionStore.getState().selectSession(refB);
    await selectB;
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      messages: [expect.objectContaining({ id: 'message-b' })],
      isLoading: false,
      error: null,
    });

    preparedA.resolve(unsubscribeA);
    await selectA;

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      messages: [expect.objectContaining({ id: 'message-b' })],
      isLoading: false,
      error: null,
    });
    expect(replaceEventSubscription).toHaveBeenCalledTimes(1);
    expect(replaceEventSubscription).toHaveBeenCalledWith(unsubscribeB);
    expect(unsubscribeA).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale selection failure clear the latest loading state or error', async () => {
    const refA = createRef('session-a', '/tmp/project-a');
    const refB = createRef('session-b', '/tmp/project-b');
    const messagesA = deferred<Message[]>();
    const messagesB = deferred<Message[]>();
    const unsubscribeB = vi.fn();

    vi.mocked(sessionService.getMessages).mockImplementation((ref) =>
      ref.sessionId === refA.sessionId ? messagesA.promise : messagesB.promise
    );
    useSessionStore.setState({
      prepareEventSubscription: vi.fn().mockResolvedValue(unsubscribeB),
      replaceEventSubscription: vi.fn(),
    });

    const selectA = useSessionStore.getState().selectSession(refA);
    const selectB = useSessionStore.getState().selectSession(refB);
    messagesA.reject(new Error('stale A failed'));
    await selectA;

    expect(useSessionStore.getState().isLoading).toBe(true);
    expect(useSessionStore.getState().error).toBeNull();

    messagesB.resolve([]);
    await selectB;
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      isLoading: false,
      error: null,
    });
  });

  it('keeps a durable stale fork child without activating it and closes its prepared subscription', async () => {
    const source = createSession({
      sessionId: 'source',
      projectPath: '/tmp/project-a',
      rootId: 'source',
    });
    const target = createSession({
      sessionId: 'target',
      projectPath: '/tmp/project-b',
      rootId: 'target',
    });
    const child = createSession({
      sessionId: 'child',
      projectPath: '/tmp/project-a',
      rootId: 'source',
      parentId: 'source',
      relationType: 'fork',
    });
    const targetRef = createRef(target.sessionId, target.projectPath);
    const childRef = createRef(child.sessionId, child.projectPath);
    const forkResult = deferred<{ session: Session; messages: Message[] }>();
    const preparedChild = deferred<() => void>();
    const unsubscribeChild = vi.fn();
    const unsubscribeTarget = vi.fn();
    const replaceEventSubscription = vi.fn();

    vi.mocked(sessionService.forkSession).mockReturnValue(forkResult.promise);
    vi.mocked(sessionService.getMessages).mockResolvedValue([
      createMessage({ id: 'target-message', role: 'user', content: 'target' }),
    ]);
    const prepareEventSubscription = vi.fn((ref: SessionRef) => {
      if (ref.sessionId === childRef.sessionId) return preparedChild.promise;
      return Promise.resolve(unsubscribeTarget);
    });
    useSessionStore.setState({
      sessions: [source, target],
      currentSessionId: source.sessionId,
      currentSessionRef: createRef(source.sessionId, source.projectPath),
      prepareEventSubscription,
      replaceEventSubscription,
    });

    const fork = useSessionStore.getState().forkSession(source);
    forkResult.resolve({
      session: child,
      messages: [
        createMessage({ id: 'child-message', role: 'user', content: 'child' }),
      ],
    });
    await flushMicrotasks();
    expect(prepareEventSubscription).toHaveBeenCalledWith(childRef);

    await useSessionStore.getState().selectSession(targetRef);
    preparedChild.resolve(unsubscribeChild);
    await fork;

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: targetRef,
      messages: [expect.objectContaining({ id: 'target-message' })],
      forkingSessionRef: null,
      isLoading: false,
      error: null,
    });
    expect(useSessionStore.getState().sessions).toEqual([source, target, child]);
    expect(replaceEventSubscription).toHaveBeenCalledTimes(1);
    expect(replaceEventSubscription).toHaveBeenCalledWith(unsubscribeTarget);
    expect(unsubscribeChild).toHaveBeenCalledTimes(1);
  });

  it('tracks the committed session event connection and reconnects the exact session ref', async () => {
    const ref = createRef('session-live', '/tmp/project-live');
    const closes = [vi.fn(), vi.fn()];
    const connectionCallbacks: Array<
      (state: 'connecting' | 'connected' | 'reconnecting' | 'offline') => void
    > = [];

    vi.mocked(sessionService.openEventSubscription).mockImplementation(
      async (_ref, _onEvent, options) => {
        const onState = options?.onConnectionStateChange;
        if (onState) connectionCallbacks.push(onState);
        onState?.('connecting');
        onState?.('connected');
        return closes[connectionCallbacks.length - 1] ?? vi.fn();
      }
    );

    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
      eventUnsubscribe: null,
      sessionEventConnectionState: 'idle',
      prepareEventSubscription: actualPrepareEventSubscription,
      replaceEventSubscription: actualReplaceEventSubscription,
      subscribeToEvents: actualSubscribeToEvents,
      reconnectSessionEvents: actualReconnectSessionEvents,
      unsubscribeFromEvents: actualUnsubscribeFromEvents,
    });
    useSessionStore.getState().unsubscribeFromEvents();

    await useSessionStore.getState().subscribeToEvents(ref);
    expect(useSessionStore.getState().sessionEventConnectionState).toBe('connected');

    connectionCallbacks[0]?.('reconnecting');
    expect(useSessionStore.getState().sessionEventConnectionState).toBe('reconnecting');
    connectionCallbacks[0]?.('offline');
    expect(useSessionStore.getState().sessionEventConnectionState).toBe('offline');

    await useSessionStore.getState().reconnectSessionEvents();

    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(sessionService.openEventSubscription).toHaveBeenNthCalledWith(
      2,
      ref,
      expect.any(Function),
      expect.objectContaining({
        onConnectionStateChange: expect.any(Function),
      })
    );
    expect(useSessionStore.getState().sessionEventConnectionState).toBe('connected');

    useSessionStore.getState().unsubscribeFromEvents();
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().sessionEventConnectionState).toBe('idle');
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
        replaceEventSubscription: actualReplaceEventSubscription,
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

  it('clears a throwing event subscription exactly once and resets buffered streaming data', () => {
    const close = vi.fn(() => {
      throw new Error('close failed');
    });
    const resetSpy = vi.spyOn(globalStreamingBuffer, 'reset');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Suppress expected cleanup warning in this test.
    });

    try {
      useSessionStore.setState({
        eventUnsubscribe: close,
        unsubscribeFromEvents: actualUnsubscribeFromEvents,
      });

      expect(() => useSessionStore.getState().unsubscribeFromEvents()).not.toThrow();
      expect(() => useSessionStore.getState().unsubscribeFromEvents()).not.toThrow();

      expect(close).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState().eventUnsubscribe).toBeNull();
      expect(resetSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to clean up event subscription',
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

  it('parses the Markdown export body and integrity headers from the exact workspace route', async () => {
    const ref = createRef('shared-id', '/tmp/project with spaces');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('# Blade conversation\n', {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename="blade-session-shared-id.md"',
          'content-type': 'text/markdown; charset=utf-8',
          'x-blade-content-sha256': 'a'.repeat(64),
          'x-blade-export-activities': '2',
          'x-blade-export-messages': '3',
          'x-blade-export-redactions': '4',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { sessionService: actualSessionService } = await vi.importActual<
      typeof import('../../../src/services/sessionService')
    >('../../../src/services/sessionService');

    await expect(
      actualSessionService.exportSessionMarkdown(ref, true)
    ).resolves.toEqual({
      filename: 'blade-session-shared-id.md',
      markdown: '# Blade conversation\n',
      contentSha256: 'a'.repeat(64),
      activityCount: 2,
      messageCount: 3,
      redactionCount: 4,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/sessions/shared-id/export?projectPath=%2Ftmp%2Fproject%20with%20spaces&includeReasoning=true'
    );
  });

  it('rejects a Markdown export response without provenance headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('# Blade conversation\n', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        })
      )
    );
    const { sessionService: actualSessionService } = await vi.importActual<
      typeof import('../../../src/services/sessionService')
    >('../../../src/services/sessionService');
    await expect(
      actualSessionService.exportSessionMarkdown(createRef('session', '/workspace'))
    ).rejects.toThrow('integrity hash');
  });

  it.each([
    {
      name: 'pause',
      invoke: () => useSessionStore.getState().pauseGoal(),
      expectedUpdate: { action: 'pause' },
      response: { status: 'paused', goal: createGoal({ status: 'paused' }) },
    },
    {
      name: 'resume',
      invoke: () => useSessionStore.getState().resumeGoal(),
      expectedUpdate: { action: 'resume' },
      response: {
        status: 'running',
        runId: 'goal-run',
        goal: createGoal({ status: 'active' }),
      },
    },
    {
      name: 'edit',
      invoke: () => useSessionStore.getState().editGoal('Revised objective'),
      expectedUpdate: { action: 'edit', objective: 'Revised objective' },
      response: {
        status: 'updated',
        goal: createGoal({ objective: 'Revised objective' }),
      },
    },
  ])('routes the $name goal action through the exact workspace ref', async (testCase) => {
    const ref = createRef('shared-id', '/tmp/project-b');
    vi.mocked(sessionService.updateGoal).mockResolvedValue(testCase.response);
    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
      goal: createGoal(),
    });

    await testCase.invoke();

    expect(sessionService.updateGoal).toHaveBeenCalledWith(
      ref,
      testCase.expectedUpdate
    );
    expect(useSessionStore.getState().goal).toEqual(testCase.response.goal);
  });

  it('routes goal clearing through the exact workspace ref', async () => {
    const ref = createRef('shared-id', '/tmp/project-b');
    vi.mocked(sessionService.clearGoal).mockResolvedValue();
    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
      goal: createGoal(),
    });

    await useSessionStore.getState().clearGoal();

    expect(sessionService.clearGoal).toHaveBeenCalledWith(ref);
    expect(useSessionStore.getState().goal).toBeNull();
  });

  it.each([
    {
      name: 'pause',
      invoke: () => useSessionStore.getState().pauseGoal(),
      resolve: (gate: ReturnType<typeof deferred<{ status: string; goal: Goal }>>) =>
        gate.resolve({
          status: 'paused',
          goal: createGoal({ status: 'paused' }),
        }),
    },
    {
      name: 'resume',
      invoke: () => useSessionStore.getState().resumeGoal(),
      resolve: (gate: ReturnType<typeof deferred<{ status: string; goal: Goal }>>) =>
        gate.resolve({
          status: 'running',
          goal: createGoal({ status: 'active' }),
        }),
    },
    {
      name: 'edit',
      invoke: () => useSessionStore.getState().editGoal('Stale objective'),
      resolve: (gate: ReturnType<typeof deferred<{ status: string; goal: Goal }>>) =>
        gate.resolve({
          status: 'updated',
          goal: createGoal({ objective: 'Stale objective' }),
        }),
    },
  ])('ignores a stale $name response after switching to the same id in another workspace', async (testCase) => {
    const refA = createRef('shared-id', '/tmp/project-a');
    const refB = createRef('shared-id', '/tmp/project-b');
    const goalB = createGoal({ goalId: 'goal-b', objective: 'Workspace B goal' });
    const gate = deferred<{ status: string; goal: Goal }>();
    vi.mocked(sessionService.updateGoal).mockReturnValue(gate.promise);
    useSessionStore.setState({
      currentSessionId: refA.sessionId,
      currentSessionRef: refA,
      isTemporarySession: false,
      goal: createGoal({ goalId: 'goal-a' }),
    });

    const action = testCase.invoke();
    useSessionStore.setState({
      currentSessionId: refB.sessionId,
      currentSessionRef: refB,
      goal: goalB,
    });
    testCase.resolve(gate);
    await action;

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      goal: goalB,
      error: null,
    });
  });

  it('ignores stale goal clearing after switching to the same id in another workspace', async () => {
    const refA = createRef('shared-id', '/tmp/project-a');
    const refB = createRef('shared-id', '/tmp/project-b');
    const goalB = createGoal({ goalId: 'goal-b', objective: 'Workspace B goal' });
    const gate = deferred<void>();
    vi.mocked(sessionService.clearGoal).mockReturnValue(gate.promise);
    useSessionStore.setState({
      currentSessionId: refA.sessionId,
      currentSessionRef: refA,
      isTemporarySession: false,
      goal: createGoal({ goalId: 'goal-a' }),
    });

    const clearing = useSessionStore.getState().clearGoal();
    useSessionStore.setState({
      currentSessionId: refB.sessionId,
      currentSessionRef: refB,
      goal: goalB,
    });
    gate.resolve();
    await clearing;

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      goal: goalB,
      error: null,
    });
  });

  it('rewinds the exact workspace and replaces the active history', async () => {
    const ref = createRef('shared-id', '/tmp/project-b');
    vi.mocked(sessionService.rewindSession).mockResolvedValue({
      checkpoint: {
        messageId: 'user-2',
        preview: 'rewind this turn',
        createdAt: '2026-08-05T00:00:00.000Z',
        fileCount: 1,
      },
      mode: 'both',
      removedTurns: 1,
      restoredFiles: ['/tmp/project-b/result.txt'],
      messages: [
        createMessage({
          id: 'kept-message',
          role: 'user',
          content: 'kept history',
        }),
      ],
    });
    useSessionStore.setState({
      sessions: [
        createSession({
          sessionId: ref.sessionId,
          projectPath: ref.projectPath,
          messageCount: 4,
        }),
      ],
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
      messages: [createMessage({ id: 'old-message', role: 'user', content: 'old' })],
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        maxContextTokens: 128000,
        isDefaultMaxTokens: true,
        totalInputTokens: 10,
        totalOutputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      },
    });

    await useSessionStore.getState().rewindSession('user-2', 'both');

    expect(sessionService.rewindSession).toHaveBeenCalledWith(ref, 'user-2', 'both');
    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: ref,
      messages: [expect.objectContaining({ content: 'kept history' })],
      tokenUsage: expect.objectContaining({ totalTokens: 0 }),
      error: null,
      sessions: [expect.objectContaining({ messageCount: 1 })],
    });
  });

  it('ignores a stale rewind response after switching to the same id in another workspace', async () => {
    const refA = createRef('shared-id', '/tmp/project-a');
    const refB = createRef('shared-id', '/tmp/project-b');
    const gate = deferred<Awaited<ReturnType<typeof sessionService.rewindSession>>>();
    vi.mocked(sessionService.rewindSession).mockReturnValue(gate.promise);
    const workspaceBMessages = [
      createMessage({ id: 'workspace-b', role: 'user', content: 'workspace B' }),
    ];
    useSessionStore.setState({
      currentSessionId: refA.sessionId,
      currentSessionRef: refA,
      isTemporarySession: false,
    });

    const rewinding = useSessionStore
      .getState()
      .rewindSession('user-a', 'conversation');
    useSessionStore.setState({
      currentSessionId: refB.sessionId,
      currentSessionRef: refB,
      messages: workspaceBMessages,
    });
    gate.resolve({
      checkpoint: {
        messageId: 'user-a',
        preview: 'stale',
        createdAt: '2026-08-05T00:00:00.000Z',
        fileCount: 0,
      },
      mode: 'conversation',
      removedTurns: 1,
      restoredFiles: [],
      messages: [],
    });
    await rewinding;

    expect(useSessionStore.getState()).toMatchObject({
      currentSessionRef: refB,
      messages: workspaceBMessages,
      error: null,
    });
  });

  it('rejects rewind locally while a run is active', async () => {
    const ref = createRef('session-active', '/tmp/project-active');
    useSessionStore.setState({
      currentSessionId: ref.sessionId,
      currentSessionRef: ref,
      isTemporarySession: false,
      isStreaming: true,
    });

    await useSessionStore.getState().rewindSession('user-active', 'conversation');

    expect(sessionService.rewindSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().error).toBe(
      'Stop the active run before rewinding'
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

  it('waits for a matching connected event and rejects pre-ready errors/timeouts', async () => {
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
      const connectionStates: string[] = [];

      const readyPromise = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-a'),
        onEvent,
        {
          onConnectionStateChange: (state) => connectionStates.push(state),
        }
      );
      let readiness: 'pending' | 'resolved' = 'pending';
      void readyPromise.then(() => {
        readiness = 'resolved';
      });
      const first = FakeEventSource.instances[0];
      expect(first).toBeDefined();
      expect(first?.url).toContain('projectPath=%2Ftmp%2Fproject-a');

      first?.onopen?.();
      await Promise.resolve();
      expect(readiness).toBe('pending');

      first?.onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: {
            sessionId: 'foreign-id',
            projectPath: '/tmp/project-a',
          },
        }),
      });
      await Promise.resolve();
      expect(readiness).toBe('pending');

      first?.onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: { sessionId: 'shared-id' },
        }),
      });
      await Promise.resolve();
      expect(readiness).toBe('pending');

      first?.onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: {
            sessionId: 'shared-id',
            projectPath: '/tmp/project-a',
            status: 'running',
            runId: 'run-restored',
            queued: 1,
            pendingInputDelivery: 'next_turn',
          },
        }),
      });
      const unsubscribe = await readyPromise;
      expect(typeof unsubscribe).toBe('function');
      expect(connectionStates).toEqual(['connecting', 'connected']);
      expect(onEvent).toHaveBeenCalledWith({
        type: 'session.status',
        properties: expect.objectContaining({
          status: 'running',
          runId: 'run-restored',
          queued: 1,
          pendingInputDelivery: 'next_turn',
        }),
      });

      const preReadyError = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-c'),
        onEvent
      );
      const second = FakeEventSource.instances[1];
      expect(second).toBeDefined();
      second?.onerror?.();
      await expect(preReadyError).rejects.toThrow();
      expect(second?.closed).toBe(true);

      const timeoutPromise = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-d'),
        onEvent
      );
      expect(FakeEventSource.instances[2]).toBeDefined();
      vi.advanceTimersByTime(10001);
      await expect(timeoutPromise).rejects.toThrow();
      expect(FakeEventSource.instances[2]?.closed).toBe(true);

      const exhaustedStates: string[] = [];
      const exhaustedPromise = actualService.openEventSubscription(
        createRef('shared-id', '/tmp/project-e'),
        onEvent,
        {
          maxRetries: 2,
          onConnectionStateChange: (state) => exhaustedStates.push(state),
        }
      );
      const exhaustedInitial = FakeEventSource.instances[3];
      exhaustedInitial?.onmessage?.({
        data: JSON.stringify({
          type: 'connected',
          properties: {
            sessionId: 'shared-id',
            projectPath: '/tmp/project-e',
            status: 'running',
          },
        }),
      });
      const exhaustedUnsubscribe = await exhaustedPromise;
      exhaustedInitial?.onerror?.();
      vi.advanceTimersByTime(1000);
      FakeEventSource.instances[4]?.onerror?.();
      vi.advanceTimersByTime(2000);
      FakeEventSource.instances[5]?.onerror?.();

      expect(exhaustedStates).toEqual([
        'connecting',
        'connected',
        'reconnecting',
        'reconnecting',
        'offline',
      ]);
      exhaustedUnsubscribe();
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
