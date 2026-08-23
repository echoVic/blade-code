import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Bus } from '../../../src/server/bus.js';

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

  it('resumes durable input without creating a synthetic wake-up prompt', async () => {
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ maxTurns: -1 }),
      getPendingSteeringCount: () => 1,
      getGoal: async () => null,
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
      },
      { stdout, stderr },
      { stdin: Readable.from([]) as NodeJS.ReadStream }
    );

    expect(exitCode).toBe(0);
    expect(agentState.chatStream).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        sessionId: 'headless-session',
      }),
      expect.objectContaining({
        pendingInputOnly: true,
        goalContinuationOnly: false,
      })
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

  it('disables only the built-in independent verifier when requested', async () => {
    const { runHeadless } = await import('../../../src/commands/headless.js');
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };

    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'implement and run the requested tests',
        verificationAgent: false,
      },
      { stdout, stderr }
    );

    expect(exitCode).toBe(0);
    expect(agentState.chatStream).toHaveBeenCalledWith(
      'implement and run the requested tests',
      expect.any(Object),
      expect.objectContaining({ builtinVerification: false })
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

  it('restores the durable permission mode unless the invocation overrides it', async () => {
    sessionState.resolveNonInteractiveSession.mockResolvedValueOnce({
      sessionId: 'headless-session',
      messages: [{ role: 'assistant', content: 'history' }],
      metadata: {
        projectPath: '/workspace/restored',
        permissionMode: 'plan',
      },
    });
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const { runHeadless } = await import('../../../src/commands/headless.js');

    await expect(
      runHeadless({ headless: true, message: 'continue' }, { stdout, stderr })
    ).resolves.toBe(0);

    expect(agentState.createWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permissionMode: 'plan' })
    );
    expect(sessionServiceState.setSessionPermissionMode).toHaveBeenCalledWith(
      'headless-session',
      '/workspace/restored',
      'plan'
    );
  });

  it('gives an explicit headless permission mode precedence over durable state', async () => {
    sessionState.resolveNonInteractiveSession.mockResolvedValueOnce({
      sessionId: 'headless-session',
      messages: [{ role: 'assistant', content: 'history' }],
      metadata: {
        projectPath: '/workspace/restored',
        permissionMode: 'plan',
      },
    });
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const { runHeadless } = await import('../../../src/commands/headless.js');

    await runHeadless(
      {
        headless: true,
        message: 'continue',
        permissionMode: 'autoEdit',
      },
      { stdout, stderr }
    );

    expect(agentState.createWithRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ permissionMode: 'autoEdit' })
    );
    expect(sessionServiceState.setSessionPermissionMode).toHaveBeenCalledWith(
      'headless-session',
      '/workspace/restored',
      'autoEdit'
    );
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
        {
          kind: 'mcp_catalog_changed',
          revision: 2,
          serverName: 'dynamic',
          reason: 'notification',
          added: ['mcp__dynamic__new_tool'],
          removed: ['mcp__dynamic__old_tool'],
          updated: [],
        },
        {
          kind: 'mcp_content_changed',
          revision: 4,
          serverName: 'content',
          contentKind: 'prompts',
          reason: 'notification',
          added: ['new_prompt'],
          removed: [],
          updated: ['compose_report'],
        },
        {
          kind: 'mcp_resource_updated',
          revision: 5,
          serverName: 'content',
          uri: 'context://live',
        },
        {
          kind: 'mcp_connection_changed',
          revision: 6,
          serverName: 'content',
          phase: 'reconnecting',
          reason: 'transport_closed',
          attempt: 1,
          maxAttempts: 5,
          nextRetryAt: 1_000,
          error: 'Connection closed',
        },
        {
          kind: 'mcp_log',
          revision: 7,
          serverName: 'content',
          level: 'warning',
          logger: 'fixture',
          message: 'SAFE_LOG_MARKER',
          projectedBytes: 15,
          dataSha256: 'a'.repeat(64),
          truncated: false,
          detailsOmitted: false,
          timestamp: 1_000,
        },
        {
          kind: 'mcp_instructions_changed',
          revision: 8,
          serverName: 'content',
          action: 'added',
          reason: 'snapshot',
          text: 'Use INSTRUCTION_CODE_42',
          sourceBytes: 23,
          projectedBytes: 23,
          sha256: 'b'.repeat(64),
          truncated: false,
          detailsOmitted: false,
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
            cacheBreak: {
              reason: 'system_prompt_changed',
              previousCacheReadTokens: 5_000,
              cacheReadTokens: 5,
              cacheWriteTokens: 3,
              tokenDrop: 4_995,
              elapsedMs: 1_000,
              callNumber: 2,
              systemPromptChanged: true,
              systemCharDelta: 25,
              toolsChanged: false,
              addedToolCount: 0,
              removedToolCount: 0,
              changedToolCount: 0,
              modelChanged: false,
              requestPolicyChanged: false,
            },
            costUsd: 0.004,
          },
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
        expect.objectContaining({
          type: 'mcp_catalog_changed',
          event_version: 1,
          revision: 2,
          server_name: 'dynamic',
          added: ['mcp__dynamic__new_tool'],
          removed: ['mcp__dynamic__old_tool'],
          updated: [],
        }),
        expect.objectContaining({
          type: 'mcp_content_changed',
          event_version: 1,
          revision: 4,
          server_name: 'content',
          content_kind: 'prompts',
          added: ['new_prompt'],
          removed: [],
          updated: ['compose_report'],
        }),
        expect.objectContaining({
          type: 'mcp_resource_updated',
          event_version: 1,
          revision: 5,
          server_name: 'content',
          uri: 'context://live',
        }),
        expect.objectContaining({
          type: 'mcp_connection_changed',
          event_version: 1,
          revision: 6,
          server_name: 'content',
          phase: 'reconnecting',
          reason: 'transport_closed',
          attempt: 1,
          max_attempts: 5,
          next_retry_at: 1_000,
          error: 'Connection closed',
        }),
        expect.objectContaining({
          type: 'mcp_log',
          event_version: 1,
          revision: 7,
          server_name: 'content',
          level: 'warning',
          logger: 'fixture',
          message: 'SAFE_LOG_MARKER',
          data_sha256: 'a'.repeat(64),
        }),
        expect.objectContaining({
          type: 'mcp_instructions_changed',
          event_version: 1,
          revision: 8,
          server_name: 'content',
          action: 'added',
          reason: 'snapshot',
          text: 'Use INSTRUCTION_CODE_42',
          sha256: 'b'.repeat(64),
        }),
        expect.objectContaining({
          type: 'token_usage',
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          max_context_tokens: 1000,
          cache_read_tokens: 5,
          cache_write_tokens: 3,
          prompt_cache_break: {
            reason: 'system_prompt_changed',
            previous_cache_read_tokens: 5_000,
            cache_read_tokens: 5,
            cache_write_tokens: 3,
            token_drop: 4_995,
            elapsed_ms: 1_000,
            call_number: 2,
            system_prompt_changed: true,
            system_char_delta: 25,
            tools_changed: false,
            added_tool_count: 0,
            removed_tool_count: 0,
            changed_tool_count: 0,
            model_changed: false,
            request_policy_changed: false,
          },
          cost_usd: 0.004,
        }),
        expect.objectContaining({ type: 'stream_end', event_version: 1 }),
      ])
    );
  });

  it('emits one bounded Bash tool_detail without changing the v1 result event', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        {
          kind: 'tool_result',
          toolCall: {
            id: 'bash-bounded',
            type: 'function',
            function: {
              name: 'Bash',
              arguments: '{"command":"fixture"}',
            },
          },
          result: {
            success: true,
            llmContent: {
              stdout: `${'x'.repeat(3_000)}STDOUT_TAIL`,
              stderr: `${'y'.repeat(3_000)}STDERR_TAIL`,
              output_truncated: true,
              truncation_info: 'Output truncated: earliest bytes omitted',
            },
            metadata: {
              summary: 'Command completed',
              output_truncated: true,
            },
          },
        },
        { kind: 'stream_end' },
      ])
    );
    const { runHeadless } = await import('../../../src/commands/headless.js');

    await runHeadless(
      {
        headless: true,
        outputFormat: 'jsonl',
        message: 'run fixture',
      },
      { stdout, stderr }
    );

    const events = stdout.write.mock.calls
      .map(([chunk]) => String(chunk))
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const results = events.filter((event) => event.type === 'tool_result');
    const details = events.filter((event) => event.type === 'tool_detail');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ event_version: 1, tool_name: 'Bash' });
    expect(details).toHaveLength(1);
    const detail = String(details[0]?.detail ?? '');
    expect(detail.length).toBeLessThanOrEqual(2_000);
    expect(detail).toContain('STDOUT_TAIL');
    expect(detail).toContain('STDERR_TAIL');
    expect(detail.split('Output truncated')).toHaveLength(2);
    expect(detail.split('\n').at(-1)).toBe('Output truncated: earliest bytes omitted');
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('writes bounded Bash detail only to stderr in text mode', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        {
          kind: 'tool_result',
          toolCall: {
            id: 'bash-text',
            type: 'function',
            function: {
              name: 'Bash',
              arguments: '{"command":"fixture"}',
            },
          },
          result: {
            success: true,
            llmContent: {
              stdout: 'TEXT_MODE_STDOUT_TAIL',
              stderr: '',
            },
            metadata: { summary: 'Command completed' },
          },
        },
        { kind: 'stream_end' },
      ])
    );
    const { runHeadless } = await import('../../../src/commands/headless.js');

    await runHeadless({ headless: true, message: 'run fixture' }, { stdout, stderr });

    const stdoutText = stdout.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    const stderrText = stderr.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stderrText).toContain('TEXT_MODE_STDOUT_TAIL');
    expect(stdoutText).not.toContain('TEXT_MODE_STDOUT_TAIL');
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

  it('emits reactive compaction metadata in JSONL mode', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        {
          kind: 'compaction',
          phase: 'start',
          reason: 'context_limit',
        },
        {
          kind: 'compaction',
          phase: 'end',
          reason: 'context_limit',
          strategy: 'fallback',
          outcome: 'fallback',
          preTokens: 120_000,
          postTokens: 2_000,
          sampleAttempts: 3,
          inputReductions: 2,
          messagesOmitted: 4,
          filesOmitted: 0,
          failureReason: 'context_exhausted',
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
        message: 'recover context',
      },
      { stdout, stderr }
    );
    const events = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)))
      .filter((event) => event.type === 'compacting');

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      {
        event_version: 1,
        type: 'compacting',
        state: 'started',
        reason: 'context_limit',
      },
      {
        event_version: 1,
        type: 'compacting',
        state: 'completed',
        reason: 'context_limit',
        strategy: 'fallback',
        outcome: 'fallback',
        pre_tokens: 120_000,
        post_tokens: 2_000,
        sample_attempts: 3,
        input_reductions: 2,
        messages_omitted: 4,
        files_omitted: 0,
        failure_reason: 'context_exhausted',
      },
    ]);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('emits sanitized Provider retry lifecycle events in JSONL mode', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        {
          kind: 'provider_admission',
          phase: 'queued',
          requestClass: 'foreground',
          resource: 'stream',
          scope: 'domain',
          reason: 'capacity',
          queuePosition: 1,
          queueDepth: 1,
          inFlight: 4,
          limit: 4,
          waitMs: 15_000,
          maxWaitMs: 180_000,
          recoveryRemainingMs: 585_000,
        },
        {
          kind: 'provider_admission',
          phase: 'admitted',
          requestClass: 'foreground',
          resource: 'stream',
          scope: 'domain',
          queuePosition: 0,
          queueDepth: 0,
          inFlight: 4,
          limit: 4,
          waitMs: 15_250,
          maxWaitMs: 180_000,
          recoveryRemainingMs: 584_750,
        },
        {
          kind: 'provider_circuit',
          phase: 'opened',
          reason: 'server_error',
          statusCode: 503,
          retryAfterMs: 2_000,
          nextProbeAt: 3_000,
          openDurationMs: 2_000,
          sampleCount: 4,
          failureCount: 4,
          recoveryRemainingMs: 600_000,
        },
        {
          kind: 'provider_circuit',
          phase: 'waiting',
          reason: 'server_error',
          statusCode: 503,
          retryAfterMs: 2_000,
          nextProbeAt: 3_000,
          openDurationMs: 2_000,
          sampleCount: 4,
          failureCount: 4,
          recoveryRemainingMs: 600_000,
        },
        {
          kind: 'provider_circuit',
          phase: 'probe',
          reason: 'server_error',
          statusCode: 503,
          openDurationMs: 2_000,
          sampleCount: 4,
          failureCount: 4,
          recoveryRemainingMs: 598_000,
        },
        {
          kind: 'provider_circuit',
          phase: 'closed',
          reason: 'server_error',
          statusCode: 503,
          openDurationMs: 2_000,
          sampleCount: 0,
          failureCount: 0,
          recoveryRemainingMs: 598_000,
        },
        {
          kind: 'provider_retry',
          phase: 'scheduled',
          attempt: 1,
          maxRetries: 12,
          reason: 'server_error',
          statusCode: 503,
          delayMs: 750,
          nextRetryAt: 1_750,
          mode: 'bounded_foreground',
          recoveryBudgetMs: 600_000,
          recoveryElapsedMs: 0,
          recoveryRemainingMs: 600_000,
        },
        {
          kind: 'provider_retry',
          phase: 'waiting',
          attempt: 1,
          maxRetries: 12,
          reason: 'server_error',
          mode: 'bounded_foreground',
          recoveryBudgetMs: 600_000,
          recoveryElapsedMs: 15_000,
          recoveryRemainingMs: 585_000,
        },
        {
          kind: 'provider_retry',
          phase: 'recovered',
          attempt: 1,
          maxRetries: 12,
          reason: 'server_error',
          statusCode: 503,
          mode: 'bounded_foreground',
          recoveryBudgetMs: 600_000,
          recoveryElapsedMs: 15_250,
          recoveryRemainingMs: 584_750,
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
        message: 'recover transparently',
      },
      { stdout, stderr }
    );
    const allEvents = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
    const events = allEvents.filter((event) => event.type === 'provider_retry');
    const circuitEvents = allEvents.filter(
      (event) => event.type === 'provider_circuit'
    );
    const admissionEvents = allEvents.filter(
      (event) => event.type === 'provider_admission'
    );

    expect(exitCode).toBe(0);
    expect(admissionEvents.map((event) => event.phase)).toEqual(['queued', 'admitted']);
    expect(admissionEvents[0]).toEqual({
      event_version: 1,
      type: 'provider_admission',
      phase: 'queued',
      request_class: 'foreground',
      resource: 'stream',
      scope: 'domain',
      reason: 'capacity',
      queue_position: 1,
      queue_depth: 1,
      in_flight: 4,
      limit: 4,
      wait_ms: 15_000,
      max_wait_ms: 180_000,
      recovery_remaining_ms: 585_000,
    });
    expect(events).toEqual([
      {
        event_version: 1,
        type: 'provider_retry',
        phase: 'scheduled',
        attempt: 1,
        max_retries: 12,
        reason: 'server_error',
        status_code: 503,
        delay_ms: 750,
        next_retry_at: 1_750,
        mode: 'bounded_foreground',
        recovery_budget_ms: 600_000,
        recovery_elapsed_ms: 0,
        recovery_remaining_ms: 600_000,
      },
      {
        event_version: 1,
        type: 'provider_retry',
        phase: 'waiting',
        attempt: 1,
        max_retries: 12,
        reason: 'server_error',
        mode: 'bounded_foreground',
        recovery_budget_ms: 600_000,
        recovery_elapsed_ms: 15_000,
        recovery_remaining_ms: 585_000,
      },
      {
        event_version: 1,
        type: 'provider_retry',
        phase: 'recovered',
        attempt: 1,
        max_retries: 12,
        reason: 'server_error',
        status_code: 503,
        mode: 'bounded_foreground',
        recovery_budget_ms: 600_000,
        recovery_elapsed_ms: 15_250,
        recovery_remaining_ms: 584_750,
      },
    ]);
    expect(circuitEvents.map((event) => event.phase)).toEqual([
      'opened',
      'waiting',
      'probe',
      'closed',
    ]);
    expect(circuitEvents[1]).toEqual({
      event_version: 1,
      type: 'provider_circuit',
      phase: 'waiting',
      reason: 'server_error',
      status_code: 503,
      retry_after_ms: 2_000,
      next_probe_at: 3_000,
      open_duration_ms: 2_000,
      sample_count: 4,
      failure_count: 4,
      recovery_remaining_ms: 600_000,
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('emits sanitized Provider stall lifecycle events in JSONL mode', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    agentState.chatStream.mockImplementationOnce(
      mockChatGenerator([
        {
          kind: 'provider_stall',
          phase: 'detected',
          stallCount: 1,
          durationMs: 30_000,
          warningAfterMs: 30_000,
          timeoutMs: 300_000,
          outputStarted: true,
        },
        {
          kind: 'provider_stall',
          phase: 'recovered',
          stallCount: 1,
          durationMs: 31_250,
          warningAfterMs: 30_000,
          timeoutMs: 300_000,
          outputStarted: true,
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
        message: 'wait for the provider',
      },
      { stdout, stderr }
    );
    const events = stdout.write.mock.calls
      .map((call) => String(call[0] ?? ''))
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)))
      .filter((event) => event.type === 'provider_stall');

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      {
        event_version: 1,
        type: 'provider_stall',
        phase: 'detected',
        stall_count: 1,
        duration_ms: 30_000,
        warning_after_ms: 30_000,
        timeout_ms: 300_000,
        output_started: true,
      },
      {
        event_version: 1,
        type: 'provider_stall',
        phase: 'recovered',
        stall_count: 1,
        duration_ms: 31_250,
        warning_after_ms: 30_000,
        timeout_ms: 300_000,
        output_started: true,
      },
    ]);
    expect(stderr.write).not.toHaveBeenCalled();
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

  it('keeps an explicit maxTurns value as a hard headless limit', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    let installedTurnLimitHandler = false;

    agentState.chatStream.mockImplementationOnce(
      async function* (_message, _context, options) {
        installedTurnLimitHandler = options?.onTurnLimitReached !== undefined;
        yield { kind: 'turn_start', turn: 2, maxTurns: 2 };
        return installedTurnLimitHandler
          ? {
              success: true,
              finalMessage: 'turn-limit callback converted exhaustion to success',
              metadata: { turnsCount: 2, toolCallsCount: 0, duration: 10 },
            }
          : {
              success: false,
              error: {
                type: 'max_turns_exceeded' as const,
                message: 'explicit turn limit reached',
              },
              metadata: { turnsCount: 2, toolCallsCount: 0, duration: 10 },
            };
      }
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect this repo',
        maxTurns: 2,
      },
      { stdout, stderr }
    );

    expect(installedTurnLimitHandler).toBe(false);
    expect(exitCode).toBe(1);
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

  it('keeps explicit maxTurns=-1 on the unlimited auto-continue path', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    let continued = false;

    agentState.chatStream.mockImplementationOnce(
      async function* (_message, _context, options) {
        const decision = await options?.onTurnLimitReached?.({ turnsCount: 100 });
        continued = decision?.continue === true;
        yield { kind: 'turn_start', turn: 100, maxTurns: 100 };
        return {
          success: continued,
          finalMessage: continued ? 'continued' : undefined,
          error: continued
            ? undefined
            : {
                type: 'max_turns_exceeded' as const,
                message: 'safety limit reached',
              },
          metadata: { turnsCount: 100, toolCallsCount: 0, duration: 10 },
        };
      }
    );

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const exitCode = await runHeadless(
      {
        headless: true,
        message: 'inspect this repo',
        maxTurns: -1,
      },
      { stdout, stderr }
    );

    expect(continued).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('keeps a positive config maxTurns as a hard headless limit', async () => {
    const stdout = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>(() => true) };
    runtimeState.create.mockResolvedValueOnce({
      dispose: runtimeState.dispose,
      getConfig: () => ({ maxTurns: 3 }),
    });
    let installedTurnLimitHandler = false;

    agentState.chatStream.mockImplementationOnce(
      async function* (_message, _context, options) {
        installedTurnLimitHandler = options?.onTurnLimitReached !== undefined;
        yield { kind: 'turn_start', turn: 3, maxTurns: 3 };
        return installedTurnLimitHandler
          ? {
              success: true,
              finalMessage: 'continued past configured limit',
              metadata: { turnsCount: 3, toolCallsCount: 0, duration: 10 },
            }
          : {
              success: false,
              error: {
                type: 'max_turns_exceeded' as const,
                message: 'configured turn limit reached',
              },
              metadata: { turnsCount: 3, toolCallsCount: 0, duration: 10 },
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

    expect(installedTurnLimitHandler).toBe(false);
    expect(exitCode).toBe(1);
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

  it('backpressures LoopEvents and waits for terminal output drain', async () => {
    class BackpressuredWritable extends EventEmitter {
      readonly chunks: string[] = [];
      private blocked = true;

      write(chunk: string): boolean {
        this.chunks.push(chunk);
        if (!this.blocked) return true;
        this.blocked = false;
        return false;
      }
    }

    const stdout = new BackpressuredWritable();
    const stderr = new BackpressuredWritable();
    let generatedSecondEvent = false;
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'content_delta', delta: 'first' };
      generatedSecondEvent = true;
      yield { kind: 'content_delta', delta: 'second' };
      return {
        success: true,
        finalMessage: 'firstsecond',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const { runHeadless } = await import('../../../src/commands/headless.js');
    const run = runHeadless(
      { headless: true, message: 'stream slowly' },
      { stdout, stderr }
    );
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(stdout.chunks).toEqual(['first']));
    expect(generatedSecondEvent).toBe(false);
    expect(settled).toBe(false);

    stdout.emit('drain');
    await vi.waitFor(() => expect(generatedSecondEvent).toBe(true));
    await vi.waitFor(() =>
      expect(stderr.chunks).toContain('[phase:completed] Headless run completed\n')
    );
    expect(settled).toBe(false);

    stderr.emit('drain');
    await expect(run).resolves.toBe(0);
    expect(stdout.chunks.join('')).toBe('firstsecond');
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
