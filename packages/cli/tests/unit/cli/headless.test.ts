import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentState = vi.hoisted(() => ({
  createWithRuntime: vi.fn(),
  chatStream: vi.fn(),
}));

const runtimeState = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  resolveNonInteractiveSession: vi.fn(),
}));

vi.mock('../../../src/agent/Agent.js', () => ({
  Agent: {
    createWithRuntime: agentState.createWithRuntime,
  },
}));

vi.mock('../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: runtimeState.create,
  },
}));

vi.mock('../../../src/commands/shared/sessionContext.js', () => ({
  resolveNonInteractiveSession: sessionState.resolveNonInteractiveSession,
}));

describe('headless runner', () => {
  /** Helper: create a mock async generator that yields events and returns a LoopResult */
  function mockChatGenerator(
    events: Array<Record<string, unknown>>,
    finalMessage = 'final response'
  ) {
    return async function* () {
      for (const event of events) {
        yield event;
      }
      return {
        success: true,
        finalMessage,
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.resolveNonInteractiveSession.mockResolvedValue({
      sessionId: 'headless-session',
      messages: [],
    });
    runtimeState.dispose.mockResolvedValue(undefined);
    runtimeState.create.mockResolvedValue({
      dispose: runtimeState.dispose,
    });
    agentState.chatStream.mockImplementation(mockChatGenerator([]));
    agentState.createWithRuntime.mockResolvedValue({
      chatStream: agentState.chatStream,
    });
  });

  it('parses custom agents and passes them to the session runtime', async () => {
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'delegate this task',
        agents: JSON.stringify({
          specialist: {
            description: 'Handles focused changes',
            prompt: 'Make the requested change and verify it.',
            tools: ['Read', 'Edit', 'Bash'],
          },
        }),
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
    expect(runtimeState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [
          expect.objectContaining({
            name: 'specialist',
            systemPrompt: 'Make the requested change and verify it.',
            source: 'flag',
          }),
        ],
      })
    );
  });

  it('defaults to yolo permissions and prints streamed frontend events', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        { kind: 'thinking_delta', delta: 'reasoning' },
        { kind: 'content_delta', delta: 'hello' },
        {
          kind: 'tool_start',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: '/tmp/demo.ts' }),
            },
          },
        },
        {
          kind: 'tool_result',
          toolCall: {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: '/tmp/demo.ts' }),
            },
          },
          result: {
            success: true,
            llmContent: 'const demo = true;',
            metadata: {
              summary: 'Read demo.ts',
              content_preview: 'const demo = true;',
            },
          },
        },
        {
          kind: 'task_update',
          tasks: [
            {
              id: 'task-1',
              subject: 'Ship headless mode',
              description: 'Ship headless mode',
              status: 'in_progress',
              activeForm: 'Shipping headless mode',
              priority: 'high',
              blocks: [],
              blockedBy: [],
              createdAt: new Date().toISOString(),
            },
          ],
        },
        {
          kind: 'token_usage',
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            maxContextTokens: 1000,
          },
        },
        { kind: 'stream_end' },
      ])
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect this repo',
      },
      { stdout, stderr }
    );
    const stderrOutput = stderr.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('');

    expect(exitCode).toBe(0);
    expect(agentState.createWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'headless-session',
        permissionMode: 'yolo',
      })
    );
    expect(stdout.write).toHaveBeenCalledWith('hello');
    expect(stderrOutput).toContain('[thinking] reasoning');
    expect(stderrOutput).toContain('Reading demo.ts');
    expect(stderrOutput).toContain('Read demo.ts');
    expect(stderrOutput).toContain('[task] [in_progress] Ship headless mode');
    expect(stderrOutput).toContain('[tokens] in=10 out=20 total=30 / 1000');
  });

  it('emits structured jsonl events when outputFormat=jsonl', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        { kind: 'content_delta', delta: 'hello' },
        {
          kind: 'tool_start',
          toolCall: {
            id: 'tool-2',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: '/tmp/demo.ts' }),
            },
          },
        },
        {
          kind: 'tool_result',
          toolCall: {
            id: 'tool-2',
            type: 'function',
            function: {
              name: 'Bash',
              arguments: JSON.stringify({
                command: 'npm test',
                description: 'Run failing tests',
              }),
            },
          },
          result: {
            success: false,
            llmContent: 'command failed',
            error: {
              type: 'execution_error',
              message: 'Command exited with code 1',
            },
            metadata: { summary: 'npm test failed' },
          },
        },
        {
          kind: 'task_update',
          tasks: [
            {
              id: 'task-2',
              subject: 'Capture jsonl',
              description: 'Capture jsonl',
              status: 'pending',
              activeForm: 'Capturing jsonl',
              priority: 'medium',
              blocks: [],
              blockedBy: [],
              createdAt: new Date().toISOString(),
            },
          ],
        },
        { kind: 'stream_end' },
      ])
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const { HeadlessJsonlEventSchema } = await import(
      '../../../src/commands/headlessEvents.js'
    );
    const exitCode = await runHeadless(
      {
        headless: true,
        outputFormat: 'jsonl',
        message: 'inspect this repo',
      },
      { stdout, stderr }
    );

    const lines = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));

    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(lines.every((line) => line.event_version === 1)).toBe(true);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'phase',
          event_version: 1,
          phase: 'inspecting',
          status: 'ongoing',
          tool_name: 'Read',
          target: '/tmp/demo.ts',
        }),
        expect.objectContaining({
          type: 'content_delta',
          event_version: 1,
          delta: 'hello',
        }),
        expect.objectContaining({
          type: 'tool_start',
          event_version: 1,
          tool_name: 'Read',
          target: '/tmp/demo.ts',
        }),
        expect.objectContaining({
          type: 'tool_result',
          event_version: 1,
          tool_name: 'Bash',
          target: 'npm test',
          success: false,
          error_type: 'execution_error',
          error_message: 'Command exited with code 1',
        }),
        expect.objectContaining({
          type: 'task_update',
          event_version: 1,
          tasks: expect.arrayContaining([
            expect.objectContaining({ subject: 'Capture jsonl' }),
          ]),
        }),
        expect.objectContaining({ type: 'stream_end', event_version: 1 }),
      ])
    );
  });

  it('reuses resolved sessions and forwards tool filters to runtime-backed agents', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    sessionState.resolveNonInteractiveSession.mockResolvedValueOnce({
      sessionId: 'resume-session',
      messages: [{ role: 'assistant', content: 'previous answer' }],
    });
    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([{ kind: 'stream_end' }])
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'continue from here',
        allowedTools: ['Read'],
        disallowedTools: ['Write'],
        continue: true,
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
    expect(sessionState.resolveNonInteractiveSession).toHaveBeenCalledWith({
      sessionId: undefined,
      continue: true,
      resume: undefined,
      fallbackSessionPrefix: 'headless',
    });
    expect(runtimeState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'resume-session',
      })
    );
    expect(agentState.createWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'resume-session',
        toolWhitelist: ['Read'],
        toolBlacklist: ['Write'],
      })
    );
    expect(agentState.chatStream).toHaveBeenCalledWith(
      'continue from here',
      expect.objectContaining({
        sessionId: 'resume-session',
        messages: [{ role: 'assistant', content: 'previous answer' }],
      }),
      expect.anything()
    );
  });

  it('rejects invalid runtime options before creating the agent', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect this repo',
        outputFormat: 'xml',
      },
      { stdout, stderr }
    );

    const stderrOutput = stderr.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('');

    expect(exitCode).toBe(1);
    expect(agentState.createWithRuntime).not.toHaveBeenCalled();
    expect(stderrOutput).toContain('outputFormat');
  });

  it('emits compacting markers and resets streamed state across stream cycles', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        { kind: 'thinking_delta', delta: 'first' },
        { kind: 'content_delta', delta: 'hello' },
        { kind: 'stream_end' },
        { kind: 'compaction', phase: 'start' },
        { kind: 'compaction', phase: 'end' },
        { kind: 'thinking_delta', delta: 'second' },
        { kind: 'stream_end' },
      ])
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect this repo',
      },
      { stdout, stderr }
    );

    const stdoutOutput = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('');
    const stderrOutput = stderr.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('');

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toBe('hello\n');
    expect(stderrOutput).toContain('[thinking] first\n');
    expect(stderrOutput).toContain('[thinking] second');
    expect(stderrOutput).toContain('[context] compacting started');
    expect(stderrOutput).toContain('[context] compacting completed');
  });

  it('prints structured error events when agent execution fails', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 1 };
      throw new Error('boom');
    });

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const { HeadlessJsonlEventSchema } = await import(
      '../../../src/commands/headlessEvents.js'
    );

    const exitCode = await runHeadless(
      {
        headless: true,
        outputFormat: 'jsonl',
        message: 'inspect this repo',
      },
      { stdout, stderr }
    );

    const lines = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));

    expect(exitCode).toBe(1);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'phase',
          event_version: 1,
          phase: 'turn',
          status: 'ongoing',
        }),
        expect.objectContaining({
          type: 'error',
          event_version: 1,
          message: 'Error: boom',
        }),
      ])
    );
  });

  it('returns a non-zero exit code when the agent loop reports failure', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 1 };
      return {
        success: false,
        error: {
          type: 'api_error',
          message: 'upstream unavailable',
        },
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 10 },
      };
    });

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const { HeadlessJsonlEventSchema } = await import(
      '../../../src/commands/headlessEvents.js'
    );

    const exitCode = await runHeadless(
      {
        headless: true,
        outputFormat: 'jsonl',
        message: 'inspect this repo',
      },
      { stdout, stderr }
    );

    const lines = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));

    expect(exitCode).toBe(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          message: 'Error: upstream unavailable',
        }),
      ])
    );
    expect(lines).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'phase',
          phase: 'completed',
        }),
      ])
    );
  });

  it('forwards cancellation to the active turn and disposes runtime before returning', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let markLoopStarted: (() => void) | undefined;
    const loopStarted = new Promise<void>((resolve) => {
      markLoopStarted = resolve;
    });

    agentState.chatStream.mockImplementationOnce(
      async function* (_message, _context, options) {
        observedSignal = options?.signal;
        markLoopStarted?.();
        await new Promise<void>((resolve) => {
          if (observedSignal?.aborted) {
            resolve();
            return;
          }
          observedSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          success: false,
          error: { type: 'aborted', message: 'turn interrupted' },
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 10 },
        };
      }
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const run = runHeadless(
      {
        headless: true,
        message: 'inspect this repo',
      },
      { stdout, stderr },
      { signal: controller.signal }
    );

    await loopStarted;
    controller.abort('interrupt');

    await expect(run).resolves.toBe(1);
    expect(observedSignal).toBe(controller.signal);
    expect(runtimeState.dispose).toHaveBeenCalledTimes(1);
  });

  it('emits stronger phase events so consumers can distinguish searching vs target-hit', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        {
          kind: 'tool_start',
          toolCall: {
            id: 'tool-search',
            type: 'function',
            function: {
              name: 'Grep',
              arguments: JSON.stringify({
                pattern: 'phase',
                path: '/tmp',
              }),
            },
          },
        },
        {
          kind: 'tool_start',
          toolCall: {
            id: 'tool-edit',
            type: 'function',
            function: {
              name: 'Edit',
              arguments: JSON.stringify({
                file_path: '/tmp/demo.ts',
              }),
            },
          },
        },
      ])
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const { HeadlessJsonlEventSchema } = await import(
      '../../../src/commands/headlessEvents.js'
    );

    const exitCode = await runHeadless(
      {
        headless: true,
        outputFormat: 'jsonl',
        message: 'inspect this repo',
      },
      { stdout, stderr }
    );

    const lines = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));

    expect(exitCode).toBe(0);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'phase',
          phase: 'searching',
          status: 'ongoing',
          tool_name: 'Grep',
        }),
        expect.objectContaining({
          type: 'phase',
          phase: 'target_hit',
          status: 'hit',
          tool_name: 'Edit',
          target: '/tmp/demo.ts',
        }),
      ])
    );
  });
});
