import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandInputState = vi.hoisted(() => ({
  initializeCliPlugins: vi.fn(),
  readCliInput: vi.fn(),
  normalizeCliInput: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  resolveNonInteractiveSession: vi.fn(),
}));

const runtimeState = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
}));

const agentState = vi.hoisted(() => ({
  createWithRuntime: vi.fn(),
  chatStream: vi.fn(),
}));

const loopState = vi.hoisted(() => ({
  drainLoop: vi.fn(),
}));

vi.mock('../../../../src/commands/shared/commandInput.js', () => ({
  initializeCliPlugins: commandInputState.initializeCliPlugins,
  readCliInput: commandInputState.readCliInput,
  normalizeCliInput: commandInputState.normalizeCliInput,
}));

vi.mock('../../../../src/commands/shared/sessionContext.js', () => ({
  resolveNonInteractiveSession: sessionState.resolveNonInteractiveSession,
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: runtimeState.create,
  },
}));

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    createWithRuntime: agentState.createWithRuntime,
  },
}));

vi.mock('../../../../src/agent/loop/index.js', () => ({
  drainLoop: loopState.drainLoop,
}));

describe('print command runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    commandInputState.initializeCliPlugins.mockResolvedValue(undefined);
    commandInputState.readCliInput.mockResolvedValue('hello');
    commandInputState.normalizeCliInput.mockResolvedValue({
      mode: 'agent',
      content: 'hello',
    });
    sessionState.resolveNonInteractiveSession.mockResolvedValue({
      sessionId: 'print-session',
      messages: [{ role: 'assistant', content: 'history' }],
    });
    runtimeState.dispose.mockResolvedValue(undefined);
    runtimeState.create.mockResolvedValue({
      dispose: runtimeState.dispose,
    });
    agentState.chatStream.mockReturnValue({ kind: 'mock-loop' });
    agentState.createWithRuntime.mockResolvedValue({
      chatStream: agentState.chatStream,
    });
    loopState.drainLoop.mockResolvedValue({
      success: true,
      finalMessage: 'final answer',
      metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
    });
  });

  it('uses resolved session/runtime and forwards tool restrictions', async () => {
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint(
      {
        print: true,
        message: 'hello',
        sessionId: 'cli-session',
        allowedTools: ['Read'],
        disallowedTools: ['Write'],
        permissionMode: 'default',
      },
      { stdout, stderr } as unknown as Pick<typeof process, 'stdout' | 'stderr'>
    );

    expect(exitCode).toBe(0);
    expect(sessionState.resolveNonInteractiveSession).toHaveBeenCalledWith({
      sessionId: 'cli-session',
      continue: undefined,
      resume: undefined,
      fallbackSessionPrefix: 'print',
    });
    expect(runtimeState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'print-session',
      })
    );
    expect(agentState.createWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'print-session',
        permissionMode: 'default',
        toolWhitelist: ['Read'],
        toolBlacklist: ['Write'],
      })
    );
    expect(agentState.chatStream).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        sessionId: 'print-session',
        messages: [{ role: 'assistant', content: 'history' }],
      })
    );
    expect(stdout.write).toHaveBeenCalledWith('final answer\n');
    expect(stderr.write).not.toHaveBeenCalled();
    expect(runtimeState.dispose).toHaveBeenCalledTimes(1);
  });

  it('prints slash-command output directly instead of short status text', async () => {
    commandInputState.normalizeCliInput.mockResolvedValueOnce({
      mode: 'output',
      content: 'full help text',
      exitCode: 0,
    });

    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint(
      {
        print: true,
        message: '/help',
      },
      { stdout, stderr } as unknown as Pick<typeof process, 'stdout' | 'stderr'>
    );

    expect(exitCode).toBe(0);
    expect(stdout.write).toHaveBeenCalledWith('full help text\n');
    expect(agentState.createWithRuntime).not.toHaveBeenCalled();
    expect(runtimeState.create).not.toHaveBeenCalled();
  });

  it('returns a clear error when interactive resume is requested in print mode', async () => {
    sessionState.resolveNonInteractiveSession.mockRejectedValueOnce(
      new Error(
        '--resume without a session ID is only supported in interactive UI mode'
      )
    );

    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint(
      {
        print: true,
        message: 'hello',
        resume: true,
      },
      { stdout, stderr } as unknown as Pick<typeof process, 'stdout' | 'stderr'>
    );

    expect(exitCode).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(
      'Error: --resume without a session ID is only supported in interactive UI mode\n'
    );
  });
});
