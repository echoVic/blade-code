import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandInputState = vi.hoisted(() => ({
  initializeCliPlugins: vi.fn(),
  readCliInput: vi.fn(),
  readOptionalCliInput: vi.fn(),
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

const sessionServiceState = vi.hoisted(() => ({
  setSessionPermissionMode: vi.fn(),
}));

vi.mock('../../../../src/commands/shared/commandInput.js', () => ({
  initializeCliPlugins: commandInputState.initializeCliPlugins,
  readCliInput: commandInputState.readCliInput,
  readOptionalCliInput: commandInputState.readOptionalCliInput,
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

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: sessionServiceState,
}));

describe('print command runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    commandInputState.initializeCliPlugins.mockResolvedValue(undefined);
    commandInputState.readCliInput.mockResolvedValue('hello');
    commandInputState.readOptionalCliInput.mockResolvedValue('hello');
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
      getConfig: () => ({ permissionMode: 'default' }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => null,
      getRecoveredFinalResponse: async () => undefined,
    });
    sessionServiceState.setSessionPermissionMode.mockResolvedValue({
      permissionMode: 'default',
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

  it('resumes durable input without the default Hello prompt', async () => {
    commandInputState.readOptionalCliInput.mockResolvedValueOnce(undefined);
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ permissionMode: 'default' }),
      getPendingSteeringCount: () => 1,
      getGoal: async () => null,
      getRecoveredFinalResponse: async () => undefined,
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint(
      {
        print: true,
        resume: 'print-session',
      },
      { stdout, stderr } as unknown as Pick<typeof process, 'stdout' | 'stderr'>
    );

    expect(exitCode).toBe(0);
    expect(commandInputState.readCliInput).not.toHaveBeenCalled();
    expect(commandInputState.normalizeCliInput).not.toHaveBeenCalled();
    expect(agentState.chatStream).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        sessionId: 'print-session',
      }),
      expect.objectContaining({
        pendingInputOnly: true,
        goalContinuationOnly: false,
      })
    );
  });

  it('fails visibly when an inputless recovery requires attention', async () => {
    commandInputState.readOptionalCliInput.mockResolvedValueOnce(undefined);
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ permissionMode: 'default' }),
      getPendingSteeringCount: () => 1,
      getGoal: async () => null,
      getRecoveredFinalResponse: async () => undefined,
    });
    const assessment = {
      state: 'requires_attention' as const,
      turnId: 'turn-before-restart',
      inputMessageCount: 1,
      reason: 'interrupted_tool_call' as const,
    };
    loopState.drainLoop.mockImplementationOnce(async (_stream, onEvent) => {
      await onEvent?.({ kind: 'turn_recovery', assessment });
      return {
        success: true,
        finalMessage: '',
        metadata: {
          turnsCount: 0,
          toolCallsCount: 0,
          duration: 0,
          recoveryAttention: assessment,
        },
      };
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint({ print: true, resume: 'print-session' }, {
      stdout,
      stderr,
    } as unknown as Pick<typeof process, 'stdout' | 'stderr'>);

    expect(exitCode).toBe(1);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join('')).toContain(
      '[turn-recovery:requires_attention] turn-before-restart'
    );
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join('')).toContain(
      'requires explicit user attention'
    );
  });

  it('projects attention even when the inputless Session has no pending work', async () => {
    commandInputState.readOptionalCliInput.mockResolvedValueOnce(undefined);
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ permissionMode: 'default' }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => ({ status: 'paused' }),
      getTurnRecoveryAssessment: () => ({
        state: 'requires_attention',
        turnId: 'turn-inputless-goal',
        inputMessageCount: 0,
        reason: 'successful_tool_result',
      }),
      getRecoveredFinalResponse: async () => undefined,
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint({ print: true, resume: 'print-session' }, {
      stdout,
      stderr,
    } as unknown as Pick<typeof process, 'stdout' | 'stderr'>);

    expect(exitCode).toBe(1);
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join('')).toContain(
      '[turn-recovery:requires_attention] turn-inputless-goal'
    );
    expect(stderr.write.mock.calls.map(([chunk]) => chunk).join('')).not.toContain(
      'No unfinished turn'
    );
    expect(agentState.createWithRuntime).not.toHaveBeenCalled();
  });

  it('shows recovery attention before continuing an explicit print prompt', async () => {
    const assessment = {
      state: 'requires_attention' as const,
      turnId: 'turn-before-restart',
      inputMessageCount: 1,
      reason: 'interrupted_tool_call' as const,
    };
    loopState.drainLoop.mockImplementationOnce(async (_stream, onEvent) => {
      await onEvent?.({ kind: 'turn_recovery', assessment });
      return {
        success: true,
        finalMessage: 'continued safely',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint(
      { print: true, message: 'I inspected state; continue safely' },
      { stdout, stderr } as unknown as Pick<typeof process, 'stdout' | 'stderr'>
    );

    expect(exitCode).toBe(0);
    expect(stdout.write).toHaveBeenCalledWith('continued safely\n');
    expect(stderr.write).toHaveBeenCalledWith(
      '[turn-recovery:requires_attention] turn-before-restart\n'
    );
  });

  it('prints a final response recovered by this startup without calling a model', async () => {
    commandInputState.readOptionalCliInput.mockResolvedValueOnce(undefined);
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ permissionMode: 'default' }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => ({ status: 'complete' }),
      getRecoveredFinalResponse: async () => ({
        turnId: 'turn-print-recovered',
        content: 'PRINT_GOAL_FINALIZATION_RECOVERED',
      }),
      getTurnRecoveryAssessment: () => ({
        state: 'completed',
        turnId: 'turn-print-recovered',
        inputMessageCount: 1,
      }),
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    await expect(
      runPrint(
        {
          print: true,
          resume: 'print-session',
          outputFormat: 'json',
        },
        { stdout, stderr } as unknown as Pick<typeof process, 'stdout' | 'stderr'>
      )
    ).resolves.toBe(0);

    expect(agentState.createWithRuntime).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();
    expect(loopState.drainLoop).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.write.mock.calls[0]![0])).toMatchObject({
      response: 'PRINT_GOAL_FINALIZATION_RECOVERED',
      input: '',
    });
    expect(stderr.write).toHaveBeenCalledWith(
      '[turn-recovery:completed] turn-print-recovered\n'
    );
  });

  it('continues a verifying goal without a wake-up prompt', async () => {
    commandInputState.readOptionalCliInput.mockResolvedValueOnce(undefined);
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ permissionMode: 'default' }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => ({ status: 'verifying' }),
      getRecoveredFinalResponse: async () => undefined,
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    await expect(
      runPrint(
        {
          print: true,
          continue: true,
        },
        { stdout, stderr } as unknown as Pick<typeof process, 'stdout' | 'stderr'>
      )
    ).resolves.toBe(0);

    expect(agentState.chatStream).toHaveBeenCalledWith(
      '',
      expect.any(Object),
      expect.objectContaining({
        pendingInputOnly: false,
        goalContinuationOnly: true,
      })
    );
  });

  it('uses resolved session/runtime and forwards tool restrictions', async () => {
    sessionState.resolveNonInteractiveSession.mockResolvedValueOnce({
      sessionId: 'print-session',
      messages: [{ role: 'assistant', content: 'history' }],
      metadata: {
        projectPath: '/workspace/persisted-yolo',
        permissionMode: 'yolo',
      },
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runPrint(
      {
        print: true,
        message: 'hello',
        sessionId: 'cli-session',
        forkSession: true,
        agents: JSON.stringify({
          reviewer: {
            description: 'Reviews changes',
            prompt: 'Review the change carefully.',
          },
        }),
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
      forkSession: true,
      fallbackSessionPrefix: 'print',
    });
    expect(runtimeState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'print-session',
        agents: [
          expect.objectContaining({
            name: 'reviewer',
            systemPrompt: 'Review the change carefully.',
            source: 'flag',
          }),
        ],
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
    expect(sessionServiceState.setSessionPermissionMode).toHaveBeenCalledWith(
      'print-session',
      '/workspace/persisted-yolo',
      'default'
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

  it('restores a durable permission mode when no CLI override is provided', async () => {
    sessionState.resolveNonInteractiveSession.mockResolvedValueOnce({
      sessionId: 'print-session',
      messages: [{ role: 'assistant', content: 'history' }],
      metadata: {
        projectPath: '/workspace/restored',
        permissionMode: 'yolo',
      },
    });
    const { runPrint } = await import('../../../../src/commands/print.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    await expect(
      runPrint({ print: true, message: 'continue' }, {
        stdout,
        stderr,
      } as unknown as Pick<typeof process, 'stdout' | 'stderr'>)
    ).resolves.toBe(0);

    expect(runtimeState.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/workspace/restored' })
    );
    expect(agentState.createWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permissionMode: 'yolo' })
    );
    expect(sessionServiceState.setSessionPermissionMode).toHaveBeenCalledWith(
      'print-session',
      '/workspace/restored',
      'yolo'
    );
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
