import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = vi.hoisted(() => ({
  runtime: {
    sessionId: 'session-1',
    dispose: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(() => ({})),
    createToolExecutor: vi.fn(() => ({})),
    getChatService: vi.fn(),
    getExecutionEngine: vi.fn(),
    getAttachmentCollector: vi.fn(),
    getCurrentModelId: vi.fn(() => 'model-1'),
    getCurrentModelMaxContextTokens: vi.fn(() => 128000),
    enqueueSteering: vi.fn(() => ({
      accepted: true,
      turnId: 'turn-1',
      queued: 1,
    })),
    getPendingSteeringCount: vi.fn(() => 0),
  },
}));

const agentState = vi.hoisted(() => ({
  chatStream: vi.fn(),
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
  },
}));

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    createWithRuntime: vi.fn(async () => ({
      chatStream: agentState.chatStream,
    })),
  },
}));

vi.mock('../../../../src/server/bus.js', () => ({
  Bus: {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {
      /* noop */
    }),
  },
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: {
    listSessions: vi.fn(async () => []),
    loadSession: vi.fn(async () => []),
    deleteSession: vi.fn(async () => {
      /* noop */
    }),
  },
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  LogCategory: {
    SERVICE: 'service',
  },
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('SessionRoutes runtime reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.runtime.dispose.mockClear();
    runtimeState.runtime.refresh.mockClear();
    runtimeState.runtime.enqueueSteering.mockClear();
    agentState.chatStream.mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield undefined;
      }
      return {
        success: true,
        finalMessage: 'assistant reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('reuses one SessionRuntime for repeated messages in the same session', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    const { Agent } = await import('../../../../src/agent/Agent.js');

    const app = SessionRoutes();

    const sendMessage = async (content: string) => {
      const response = await app.request('/session-1/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      expect(response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await sendMessage('first');
    await sendMessage('second');

    expect(SessionRuntime.create).toHaveBeenCalledTimes(1);
    expect(SessionRuntime.create).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceRoot: expect.any(String),
    });
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(2);
    expect(Agent.createWithRuntime).toHaveBeenNthCalledWith(1, runtimeState.runtime, {
      sessionId: 'session-1',
    });
    expect(Agent.createWithRuntime).toHaveBeenNthCalledWith(2, runtimeState.runtime, {
      sessionId: 'session-1',
    });
  });

  it('routes a second message into the active turn instead of starting a concurrent run', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'steered reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const first = await app.request('/steering-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'initial request' }),
    });
    expect(first.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'steering-session',
        'turn.started',
        expect.any(Object)
      );
    });

    const second = await app.request('/steering-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'updated requirement' }),
    });

    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      status: 'steering_queued',
      queued: 1,
    });
    expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
      'updated requirement',
      { allowBeforeTurn: true }
    );
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(1);
    expect(Bus.publish).toHaveBeenCalledWith(
      'steering-session',
      'steering.queued',
      expect.objectContaining({ queued: 1 })
    );

    releaseRun();
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'steering-session',
        'session.completed',
        expect.any(Object)
      );
    });
  });

  it('waits for one runtime initialization before acknowledging startup steering', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    let releaseRuntime: () => void = () => undefined;
    vi.mocked(SessionRuntime.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRuntime = () => resolve(runtimeState.runtime as never);
        })
    );

    const app = SessionRoutes();
    const first = await app.request('/startup-steering/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'initial request' }),
    });
    expect(first.status).toBe(202);

    let secondSettled = false;
    const secondPromise = Promise.resolve(
      app.request('/startup-steering/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'guidance during startup' }),
      })
    ).then((response) => {
      secondSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondSettled).toBe(false);

    releaseRuntime();
    const second = await secondPromise;
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      status: 'steering_queued',
      queued: 1,
    });
    expect(SessionRuntime.create).toHaveBeenCalledTimes(1);
    expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
      'guidance during startup',
      { allowBeforeTurn: true }
    );
  });

  it('builds multimodal user content from image attachments', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = SessionRoutes();

    const response = await app.request('/session-2/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'describe this image',
        attachments: [{ type: 'image', content: 'data:image/png;base64,abc' }],
      }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentState.chatStream).toHaveBeenCalledWith(
      [
        { type: 'text', text: 'describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('builds image-only user content when the request only contains image attachments', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = SessionRoutes();

    const response = await app.request('/session-3/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '',
        attachments: [{ type: 'image', content: 'data:image/png;base64,image-only' }],
      }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentState.chatStream).toHaveBeenCalledWith(
      [{ type: 'image_url', image_url: { url: 'data:image/png;base64,image-only' } }],
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('hydrates persisted session history before sending a follow-up message', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    vi.mocked(SessionService.loadSession).mockResolvedValue([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ] as never);

    const app = SessionRoutes();

    const response = await app.request('/persisted-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'follow up' }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(SessionService.loadSession).toHaveBeenCalledWith('persisted-session');
    expect(agentState.chatStream.mock.calls[0]?.[1]).toMatchObject({
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    });
  });

  it('publishes loop lifecycle events and preserves canonical tool failure state', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');

    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 2, maxTurns: 8 };
      yield { kind: 'compaction', phase: 'start' };
      yield { kind: 'compaction', phase: 'end' };
      yield { kind: 'model_fallback' };
      yield {
        kind: 'steering_applied',
        messageIds: ['recovered-steer'],
        count: 1,
        recovered: 1,
      };
      yield {
        kind: 'tool_result',
        toolCall: {
          id: 'tool-failed-without-error-payload',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"false"}' },
        },
        result: {
          success: false,
          llmContent: 'Command exited with code 1',
          metadata: { summary: 'Command failed' },
        },
      };
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 2, toolCallsCount: 1, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const response = await app.request('/surface-events/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'recover from the failed command' }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'surface-events',
        'session.completed',
        expect.any(Object)
      );
    });

    expect(Bus.publish).toHaveBeenCalledWith('surface-events', 'turn.started', {
      turn: 2,
      maxTurns: 8,
    });
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'compaction.started',
      {}
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'compaction.completed',
      {}
    );
    expect(Bus.publish).toHaveBeenCalledWith('surface-events', 'model.fallback', {});
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'steering.applied',
      expect.objectContaining({
        messageIds: ['recovered-steer'],
        count: 1,
        recovered: 1,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-failed-without-error-payload',
        success: false,
      })
    );
  });
});
