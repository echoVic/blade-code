import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_USER_MESSAGE_TEXT_CHARS } from '../../../src/api/attachmentLimits.js';
import { Bus } from '../../../src/server/bus.js';
import { comprehensiveLoopEvents } from '../../support/comprehensiveLoopEvents.js';

const agentState = vi.hoisted(() => ({
  createWithRuntime: vi.fn(),
  chatStream: vi.fn(),
}));

const runtimeState = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
  executeUserShellCommand: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  resolveNonInteractiveSession: vi.fn(),
}));

const taskState = vi.hoisted(() => ({
  createSessionTask: vi.fn(),
}));

const sessionServiceState = vi.hoisted(() => ({
  setSessionPermissionMode: vi.fn(),
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

vi.mock('../../../src/services/SessionTaskService.js', () => ({
  SessionTaskService: {
    createSessionTask: taskState.createSessionTask,
  },
}));

vi.mock('../../../src/services/SessionService.js', () => ({
  SessionService: sessionServiceState,
}));

describe('headless runner', () => {
  it.each(['text', 'jsonl'] as const)(
    'emits recap separately from the answer in %s output',
    async (outputFormat) => {
      const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
      const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
      agentState.chatStream.mockImplementationOnce(
        mockChatGenerator([
          { kind: 'conversation_recap', messageId: 'r', text: 'Goal: ship.' },
        ])
      );
      const { runHeadless } = await import('../../../src/commands/headless.js');
      expect(
        await runHeadless(
          { headless: true, message: 'continue', outputFormat },
          { stdout, stderr }
        )
      ).toBe(0);
      const out = stdout.write.mock.calls.map(([text]) => text).join('');
      const err = stderr.write.mock.calls.map(([text]) => text).join('');
      if (outputFormat === 'jsonl') {
        expect(
          out
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        ).toContainEqual({
          event_version: 1,
          type: 'conversation_recap',
          message_id: 'r',
          text: 'Goal: ship.',
        });
      } else {
        expect(err).toContain('recap: Goal: ship.');
        expect(out).not.toContain('recap:');
      }
    }
  );

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
    taskState.createSessionTask.mockReset();
    runtimeState.create.mockResolvedValue({
      dispose: runtimeState.dispose,
      getConfig: () => ({ maxTurns: -1 }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => null,
      getRecoveredFinalResponse: async () => undefined,
      executeUserShellCommand: runtimeState.executeUserShellCommand,
    });
    runtimeState.executeUserShellCommand.mockReset();
    sessionServiceState.setSessionPermissionMode.mockResolvedValue({
      permissionMode: 'yolo',
    });
    agentState.chatStream.mockImplementation(mockChatGenerator([]));
    agentState.createWithRuntime.mockResolvedValue({
      chatStream: agentState.chatStream,
    });
  });

  it('returns a blocked exit without reporting completion for recovery attention', async () => {
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ maxTurns: -1 }),
      getPendingSteeringCount: () => 1,
      getGoal: async () => null,
      getRecoveredFinalResponse: async () => undefined,
      executeUserShellCommand: runtimeState.executeUserShellCommand,
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      const assessment = {
        state: 'requires_attention' as const,
        turnId: 'turn-before-restart',
        inputMessageCount: 1,
        reason: 'interrupted_tool_call' as const,
      };
      yield { kind: 'turn_recovery' as const, assessment };
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
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        resume: 'headless-session',
        outputFormat: 'jsonl',
      },
      { stdout, stderr },
      { stdin: Readable.from([]) as NodeJS.ReadStream }
    );

    const events = stdout.write.mock.calls.map(([chunk]) => JSON.parse(chunk));
    expect(exitCode).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn_recovery',
        state: 'requires_attention',
      })
    );
    expect(
      events.some((event) => event.type === 'phase' && event.phase === 'completed')
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('requires explicit user attention'),
      })
    );
  }, 15_000);

  it('projects inputless recovery attention before declaring there is no work', async () => {
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ maxTurns: -1 }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => ({ status: 'paused' }),
      getTurnRecoveryAssessment: () => ({
        state: 'requires_attention',
        turnId: 'turn-inputless-goal',
        inputMessageCount: 0,
        reason: 'successful_tool_result',
      }),
      getRecoveredFinalResponse: async () => undefined,
      executeUserShellCommand: runtimeState.executeUserShellCommand,
    });
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        resume: 'headless-session',
        outputFormat: 'jsonl',
      },
      { stdout, stderr },
      { stdin: Readable.from([]) as NodeJS.ReadStream }
    );

    expect(exitCode).toBe(2);
    expect(stdout.write.mock.calls.map(([chunk]) => JSON.parse(chunk))).toContainEqual(
      expect.objectContaining({
        type: 'turn_recovery',
        state: 'requires_attention',
        turn_id: 'turn-inputless-goal',
      })
    );
    expect(agentState.createWithRuntime).not.toHaveBeenCalled();
  });

  it('rejects oversized input before resolving a durable Session', async () => {
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'x'.repeat(MAX_USER_MESSAGE_TEXT_CHARS + 1),
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(1);
    expect(sessionState.resolveNonInteractiveSession).not.toHaveBeenCalled();
    expect(runtimeState.create).not.toHaveBeenCalled();
    expect(
      stderr.write.mock.calls.map((call) => String(call[0] ?? '')).join('')
    ).toContain(
      `User prompt exceeds the ${MAX_USER_MESSAGE_TEXT_CHARS}-character durable input limit`
    );
  });

  it('replays a final response recovered by this startup without calling a model', async () => {
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ maxTurns: -1 }),
      getPendingSteeringCount: () => 0,
      getGoal: async () => ({
        goalId: 'goal-recovered',
        status: 'complete',
        objective: 'recover exactly once',
      }),
      getRecoveredFinalResponse: async () => ({
        turnId: 'turn-recovered',
        content: 'GOAL_FINALIZATION_RECOVERED',
      }),
      getTurnRecoveryAssessment: () => ({
        state: 'completed',
        turnId: 'turn-recovered',
        inputMessageCount: 1,
      }),
      executeUserShellCommand: runtimeState.executeUserShellCommand,
    });
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        resume: 'headless-session',
        outputFormat: 'jsonl',
      },
      { stdout, stderr },
      { stdin: Readable.from([]) as NodeJS.ReadStream }
    );

    expect(exitCode).toBe(0);
    expect(agentState.createWithRuntime).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();
    expect(stdout.write.mock.calls.map(([chunk]) => JSON.parse(chunk))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn_recovery',
          state: 'completed',
          turn_id: 'turn-recovered',
        }),
        expect.objectContaining({
          type: 'goal',
          goal_id: 'goal-recovered',
          status: 'complete',
        }),
        expect.objectContaining({
          type: 'content',
          content: 'GOAL_FINALIZATION_RECOVERED',
        }),
        expect.objectContaining({
          type: 'phase',
          phase: 'completed',
          status: 'done',
        }),
      ])
    );
  });

  it('fails closed when a bare resume has no unfinished work', async () => {
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        resume: 'headless-session',
      },
      { stdout, stderr },
      { stdin: Readable.from([]) as NodeJS.ReadStream }
    );

    expect(exitCode).toBe(1);
    expect(agentState.chatStream).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(
      'Error: No unfinished turn or active goal to resume\n'
    );
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

  it('executes bang input without creating an Agent or calling a model', async () => {
    runtimeState.executeUserShellCommand.mockImplementationOnce(
      async (_command, options) => {
        await options.onEvent({
          type: 'started',
          executionId: 'shell-headless',
          command: 'pwd',
          auxiliary: false,
        });
        await options.onEvent({
          type: 'output',
          executionId: 'shell-headless',
          stream: 'stdout',
          chunk: '/workspace\n',
          streamedBytes: 11,
          streamTruncated: false,
          auxiliary: false,
        });
        return {
          executionId: 'shell-headless',
          messageId: 'shell-message',
          record: {
            version: 1,
            command: 'pwd',
            status: 'completed',
            exitCode: 0,
            durationMs: 3,
            stdout: '/workspace',
            stderr: '',
            stdoutOmittedBytes: 0,
            stderrOmittedBytes: 0,
            binaryOutput: false,
            truncated: false,
          },
          modelContent: '<user_shell_command>pwd</user_shell_command>',
          auxiliary: false,
        };
      }
    );
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: '! pwd',
        outputFormat: 'jsonl',
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
    expect(runtimeState.executeUserShellCommand).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(agentState.createWithRuntime).not.toHaveBeenCalled();
    const events = stdout.write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(events.map((event) => event.type)).toEqual([
      'user_shell_started',
      'user_shell_output',
      'user_shell_completed',
    ]);
  });

  it('dispatches a worktree task and emits its stable JSONL identity', async () => {
    const taskWorktree = {
      sessionId: 'headless-session',
      name: 'task/headless-session',
      branch: 'blade-worktree-headless',
      baseCommit: 'abc123',
      originalBranch: 'main',
      repositoryRoot: '/tmp/source',
      originalWorkspaceRoot: '/tmp/source',
      worktreeRoot: '/tmp/task-worktree',
      workspaceRoot: '/tmp/task-worktree',
      sourceHadChanges: false,
    };
    taskState.createSessionTask.mockResolvedValueOnce({
      metadata: {
        sessionId: 'headless-session',
        projectPath: '/tmp/task-worktree',
        rootId: 'headless-session',
        taskStatus: 'queued',
        taskIsolation: 'worktree',
        taskSourceProjectPath: '/tmp/source',
        taskWorktreePath: '/tmp/task-worktree',
        taskWorktreeBranch: taskWorktree.branch,
        taskBaseCommit: taskWorktree.baseCommit,
        messageCount: 0,
        firstMessageTime: '2026-08-06T00:00:00.000Z',
        lastMessageTime: '2026-08-06T00:00:00.000Z',
        hasErrors: false,
      },
      taskWorktree,
    });
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(async function* (
      _message: unknown,
      context: { sessionId: string; workspaceRoot: string }
    ) {
      if (Date.now() < 0) yield undefined;
      Bus.publish(
        {
          sessionId: context.sessionId,
          projectPath: context.workspaceRoot,
        },
        'task.status',
        {
          taskStatus: 'queued',
          taskQueuePosition: 1,
          taskQueueDepth: 1,
          taskInFlight: 1,
          taskConcurrencyLimit: 1,
        }
      );
      Bus.publish(
        {
          sessionId: context.sessionId,
          projectPath: context.workspaceRoot,
        },
        'task.status',
        {
          taskStatus: 'running',
          taskQueueDepth: 0,
          taskInFlight: 1,
          taskConcurrencyLimit: 1,
        }
      );
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'Implement isolated task dispatch',
        taskIsolation: 'worktree',
        outputFormat: 'jsonl',
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
    expect(taskState.createSessionTask).toHaveBeenCalledWith({
      sessionId: 'headless-session',
      prompt: 'Implement isolated task dispatch',
      sourceProjectPath: expect.any(String),
      isolation: 'worktree',
      dispatch: {
        version: 1,
        prompt: 'Implement isolated task dispatch',
        sourceProjectPath: expect.any(String),
        isolation: 'worktree',
        permissionMode: 'yolo',
      },
    });
    expect(runtimeState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'headless-session',
        workspaceRoot: '/tmp/task-worktree',
        taskWorktree,
      })
    );
    expect(agentState.createWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toolBlacklist: ['EnterWorktree', 'ExitWorktree'],
      })
    );
    expect(agentState.chatStream).toHaveBeenCalledWith(
      'Implement isolated task dispatch',
      expect.objectContaining({
        workspaceRoot: '/tmp/task-worktree',
        worktreeActive: true,
      }),
      expect.any(Object)
    );
    const events = stdout.write.mock.calls
      .map(([line]) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task_session',
        session_id: 'headless-session',
        project_path: '/tmp/task-worktree',
        isolation: 'worktree',
        worktree_branch: 'blade-worktree-headless',
      })
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'task_admission',
          state: 'queued',
          queue_position: 1,
          max_concurrent_tasks: 1,
        }),
        expect.objectContaining({
          type: 'task_admission',
          state: 'running',
          max_concurrent_tasks: 1,
        }),
      ])
    );
  });

  it('projects background child Provider admission through Headless JSONL', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(async function* (
      _message: unknown,
      context: { sessionId: string; workspaceRoot: string }
    ) {
      if (Date.now() < 0) yield undefined;
      Bus.publish(
        {
          sessionId: context.sessionId,
          projectPath: context.workspaceRoot,
        },
        'subagent.provider.admission',
        {
          subagentSessionId: 'child-session',
          phase: 'rejected',
          requestClass: 'background',
          resource: 'pending_bytes',
          scope: 'class',
          reason: 'queue_full',
          queuePosition: 0,
          queueDepth: 1,
          inFlight: 1,
          limit: 1,
          waitMs: 0,
          maxWaitMs: 120_000,
        }
      );
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'run one background child',
        outputFormat: 'jsonl',
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
    const events = stdout.write.mock.calls
      .map(([line]) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'provider_admission',
        phase: 'rejected',
        request_class: 'background',
        resource: 'pending_bytes',
        scope: 'class',
        reason: 'queue_full',
      })
    );
    expect(JSON.stringify(events)).not.toContain('child-session');
  });

  it('rejects task isolation when resuming an existing session', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const { runHeadless } = await import('../../../src/commands/headless.js');

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'continue',
        taskIsolation: 'worktree',
        resume: 'existing-session',
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(1);
    expect(taskState.createSessionTask).not.toHaveBeenCalled();
    expect(runtimeState.create).not.toHaveBeenCalled();
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
            cacheReadTokens: 5,
            cacheWriteTokens: 3,
            costUsd: 0.004,
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
    expect(sessionServiceState.setSessionPermissionMode).toHaveBeenCalledWith(
      'headless-session',
      expect.any(String),
      'yolo'
    );
    expect(stdout.write).toHaveBeenCalledWith('hello');
    expect(stderrOutput).toContain('[thinking] reasoning');
    expect(stderrOutput).toContain('Reading demo.ts');
    expect(stderrOutput).toContain('Read demo.ts');
    expect(stderrOutput).toContain('[task] [in_progress] Ship headless mode');
    expect(stderrOutput).toContain('[tokens] in=10 out=20 total=30 / 1000');
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
        forkSession: true,
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
    expect(sessionState.resolveNonInteractiveSession).toHaveBeenCalledWith({
      sessionId: undefined,
      continue: true,
      resume: undefined,
      forkSession: true,
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

  it('accepts arbitrarily large maxTurns without upper cap', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const { runHeadless } = await import('../../../src/commands/headless.js');

    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([{ kind: 'turn_start', turn: 1, maxTurns: 500 }])
    );

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'large task',
        maxTurns: 500,
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
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

  it('emits the unified Provider recovery envelope and its terminal clear', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        {
          kind: 'provider_recovery',
          recovery: {
            version: 1,
            generation: 'generation-1',
            revision: 1,
            snapshot: {
              activity: 'retry_wait',
              reason: 'rate_limit',
              updatedAt: 1_000,
              nextActionAt: 3_000,
              retry: {
                attempt: 1,
                maxRetries: 12,
                statusCode: 429,
                delayMs: 2_000,
              },
            },
          },
        },
        {
          kind: 'provider_recovery',
          recovery: {
            version: 1,
            generation: 'generation-1',
            revision: 2,
            snapshot: null,
          },
        },
      ])
    );
    const { runHeadless } = await import('../../../src/commands/headless.js');

    expect(
      await runHeadless(
        { headless: true, outputFormat: 'jsonl', message: 'recover' },
        { stdout, stderr }
      )
    ).toBe(0);

    const events = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'provider_recovery');
    expect(events).toEqual([
      expect.objectContaining({
        generation: 'generation-1',
        revision: 1,
        snapshot: expect.objectContaining({
          activity: 'retry_wait',
          updated_at: 1_000,
          next_action_at: 3_000,
        }),
      }),
      expect.objectContaining({
        generation: 'generation-1',
        revision: 2,
        snapshot: null,
      }),
    ]);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('keeps auto-continue available when headless maxTurns is not explicit', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    let continued = false;

    agentState.chatStream.mockImplementationOnce(
      async function* (_message, _context, options) {
        const decision = await options?.onTurnLimitReached?.({ turnsCount: 100 });
        continued = decision?.continue === true;
        yield { kind: 'turn_start', turn: 100, maxTurns: 100 };
        return {
          success: true,
          finalMessage: 'continued',
          metadata: { turnsCount: 100, toolCallsCount: 0, duration: 10 },
        };
      }
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect this repo',
      },
      { stdout, stderr }
    );

    expect(continued).toBe(true);
    expect(exitCode).toBe(0);
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
    expect(observedSignal).not.toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe('interrupt');
    expect(runtimeState.dispose).toHaveBeenCalledTimes(1);
  });

  it('projects the complete loop event surface and disposes the runtime', async () => {
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect and edit',
        outputFormat: 'jsonl',
      },
      { stdout, stderr },
      { stdin: Readable.from([]) as NodeJS.ReadStream }
    );

    const events = stdout.write.mock.calls.map(([line]) => JSON.parse(line));
    expect(exitCode).toBe(0);
    expect(new Set(events.map((event) => event.type))).toEqual(
      expect.objectContaining(
        new Set([
          'content_delta',
          'thinking_delta',
          'stream_end',
          'tool_start',
          'tool_progress',
          'tool_result',
          'tool_detail',
          'token_usage',
          'compacting',
          'task_update',
          'goal_frontier',
          'turn_recovery',
          'structured_output',
          'mcp_catalog_changed',
          'mcp_content_changed',
          'mcp_resource_updated',
          'mcp_connection_changed',
          'mcp_log',
          'mcp_instructions_changed',
          'mcp_task_changed',
          'project_rules_loaded',
          'goal',
          'subagent',
          'model_fallback',
          'provider_admission',
          'provider_retry',
          'provider_circuit',
          'provider_stall',
          'provider_recovery',
          'turn_activity',
          'action_stationarity',
          'phase',
        ])
      )
    );
    expect(agentState.createWithRuntime).toHaveBeenCalledOnce();
    expect(runtimeState.dispose).toHaveBeenCalledOnce();
    expect(stderr.write).not.toHaveBeenCalled();
  });
});
