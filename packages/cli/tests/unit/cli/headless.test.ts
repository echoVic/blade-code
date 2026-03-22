import { beforeEach, describe, expect, it, vi } from 'vitest';

const agentState = vi.hoisted(() => ({
  create: vi.fn(),
  chat: vi.fn(),
}));

vi.mock('../../../src/agent/Agent.js', () => ({
  Agent: {
    create: agentState.create,
  },
}));

describe('headless runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentState.chat.mockResolvedValue('final response');
    agentState.create.mockResolvedValue({
      chat: agentState.chat,
    });
  });

  it('defaults to yolo permissions and prints streamed frontend events', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chat.mockImplementationOnce(async (_input, _context, loopOptions) => {
      loopOptions?.onThinkingDelta?.('reasoning');
      loopOptions?.onContentDelta?.('hello');
      loopOptions?.onToolStart?.({
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'Read',
          arguments: JSON.stringify({ file_path: '/tmp/demo.ts' }),
        },
      });
      await loopOptions?.onToolResult?.(
        {
          id: 'tool-1',
          type: 'function',
          function: {
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/tmp/demo.ts' }),
          },
        },
        {
          success: true,
          displayContent: 'const demo = true;',
          metadata: {
            summary: 'Read demo.ts',
            content_preview: 'const demo = true;',
          },
        }
      );
      loopOptions?.onTodoUpdate?.([
        {
          id: 'todo-1',
          content: 'Ship headless mode',
          status: 'in_progress',
          activeForm: 'Shipping headless mode',
          priority: 'high',
          createdAt: new Date().toISOString(),
        },
      ]);
      loopOptions?.onTokenUsage?.({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        maxContextTokens: 1000,
      });
      loopOptions?.onStreamEnd?.();
      return 'final response';
    });

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
    expect(agentState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'yolo',
      })
    );
    expect(stdout.write).toHaveBeenCalledWith('hello');
    expect(stderrOutput).toContain('[thinking] reasoning');
    expect(stderrOutput).toContain('Reading demo.ts');
    expect(stderrOutput).toContain('Read demo.ts');
    expect(stderrOutput).toContain('[todo] [in_progress] Ship headless mode');
    expect(stderrOutput).toContain('[tokens] in=10 out=20 total=30 / 1000');
  });

  it('emits structured jsonl events when outputFormat=jsonl', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chat.mockImplementationOnce(async (_input, _context, loopOptions) => {
      loopOptions?.onContentDelta?.('hello');
      loopOptions?.onToolStart?.({
        id: 'tool-2',
        type: 'function',
        function: {
          name: 'Read',
          arguments: JSON.stringify({ file_path: '/tmp/demo.ts' }),
        },
      });
      loopOptions?.onTodoUpdate?.([
        {
          id: 'todo-2',
          content: 'Capture jsonl',
          status: 'pending',
          activeForm: 'Capturing jsonl',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);
      loopOptions?.onStreamEnd?.();
      return 'final response';
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

    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(lines.every((line) => line.event_version === 1)).toBe(true);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'content_delta',
          event_version: 1,
          delta: 'hello',
        }),
        expect.objectContaining({
          type: 'tool_start',
          event_version: 1,
          tool_name: 'Read',
        }),
        expect.objectContaining({
          type: 'todo_update',
          event_version: 1,
          todos: expect.arrayContaining([
            expect.objectContaining({ content: 'Capture jsonl' }),
          ]),
        }),
        expect.objectContaining({ type: 'stream_end', event_version: 1 }),
      ])
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
    expect(agentState.create).not.toHaveBeenCalled();
    expect(stderrOutput).toContain('outputFormat');
  });

  it('emits compacting markers and resets streamed state across stream cycles', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    agentState.chat.mockImplementationOnce(async (_input, _context, loopOptions) => {
      loopOptions?.onThinkingDelta?.('first');
      loopOptions?.onContentDelta?.('hello');
      loopOptions?.onStreamEnd?.();
      loopOptions?.onCompacting?.(true);
      loopOptions?.onCompacting?.(false);
      loopOptions?.onThinkingDelta?.('second');
      loopOptions?.onStreamEnd?.();
      return 'final response';
    });

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

    agentState.chat.mockRejectedValueOnce(new Error('boom'));

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
    expect(lines).toEqual([
      expect.objectContaining({
        type: 'error',
        event_version: 1,
        message: 'Error: boom',
      }),
    ]);
  });
});
