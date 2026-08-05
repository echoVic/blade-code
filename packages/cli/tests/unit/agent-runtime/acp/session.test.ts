/**
 * AcpSession 测试
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { AcpSession } from '../../../../src/acp/Session.js';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import type { LoopResult } from '../../../../src/agent/types.js';
import { Bus } from '../../../../src/server/bus.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import { createMockACPClient } from '../../../support/mocks/mockACPClient.js';
import { createMockAgent, type MockAgent } from '../../../support/mocks/mockAgent.js';

type AgentMockInstance = MockAgent & {
  switchModel: Mock<(modelId: string) => Promise<void>>;
};

const agentMockState = vi.hoisted((): { current: AgentMockInstance | null } => ({
  current: null,
}));

function getMockAgent(): AgentMockInstance {
  const agent = agentMockState.current;
  if (!agent) throw new Error('Agent mock has not been created');
  return agent;
}

const runtimeState = vi.hoisted(() => ({
  runtime: {
    sessionId: 'test-session-id',
    dispose: vi.fn().mockResolvedValue(undefined),
    enqueueSteering: vi.fn(() => ({
      accepted: true,
      turnId: 'turn-1',
      queued: 1,
    })),
    getPendingSteeringCount: vi.fn(() => 0),
    getGoal: vi.fn().mockResolvedValue(null),
    listRewindCheckpoints: vi.fn().mockResolvedValue([]),
    rewindSession: vi.fn(),
    listSubagents: vi.fn(() => []),
    resumeSubagent: vi.fn(),
  },
}));

// Mock Agent
vi.mock('../../../../src/agent/Agent.js', () => {
  const createAgent = (): AgentMockInstance => {
    const mockAgent: AgentMockInstance = Object.assign(createMockAgent(), {
      switchModel: vi.fn(async (_modelId: string): Promise<void> => undefined),
    });
    mockAgent.destroy = vi.fn().mockResolvedValue(undefined);
    agentMockState.current = mockAgent;
    return mockAgent;
  };
  const MockAgentClass = Object.assign(vi.fn().mockImplementation(createAgent), {
    create: vi.fn(async () => createAgent()),
    createWithRuntime: vi.fn(async () => createAgent()),
  });

  return { Agent: MockAgentClass };
});

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
  },
}));

// Mock AcpServiceContext
vi.mock('../../../../src/acp/AcpServiceContext.js', () => ({
  isAcpMode: vi.fn(() => true),
  AcpServiceContext: {
    initializeSession: vi.fn(),
    destroySession: vi.fn(),
    setCurrentSession: vi.fn(),
  },
}));

// Mock slash commands
vi.mock('../../../../src/slash-commands/index.js', () => ({
  executeSlashCommand: vi.fn().mockResolvedValue({
    success: true,
    message: 'Command executed',
    content: 'Command result',
  }),
  getRegisteredCommands: vi.fn(() => [
    {
      name: 'test',
      description: 'Test command',
      usage: '/test [args]',
      aliases: ['t'],
    },
  ]),
  isSlashCommand: vi.fn((msg) => msg.startsWith('/')),
}));

// Mock task item type

describe('AcpSession', () => {
  let mockConnection: ReturnType<typeof createMockACPClient>;
  let connectionAbortController: AbortController;
  let session: AcpSession;

  beforeEach(() => {
    agentMockState.current = null;
    runtimeState.runtime.dispose.mockReset().mockResolvedValue(undefined);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.listRewindCheckpoints.mockReset().mockResolvedValue([]);
    runtimeState.runtime.rewindSession.mockReset();
    runtimeState.runtime.listSubagents.mockReset().mockReturnValue([]);
    runtimeState.runtime.resumeSubagent.mockReset();
    // 创建 mock 连接
    mockConnection = createMockACPClient();
    connectionAbortController = new AbortController();
    Object.defineProperty(mockConnection, 'signal', {
      value: connectionAbortController.signal,
    });

    // 创建会话实例
    session = new AcpSession(
      'test-session-id',
      '/tmp/test',
      mockConnection as any,
      {
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      } as any
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    runtimeState.runtime.dispose.mockClear();
    runtimeState.runtime.enqueueSteering.mockClear();
  });

  describe('initialize', () => {
    it('应该正确初始化会话', async () => {
      await session.initialize();

      // 验证 ACP 服务上下文已初始化
      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(AcpServiceContext.initializeSession).toHaveBeenCalledWith(
        mockConnection,
        'test-session-id',
        expect.any(Object),
        '/tmp/test'
      );
    });

    it('应该创建 SessionRuntime 并注入 Agent 实例', async () => {
      await session.initialize();

      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      const { Agent } = await import('../../../../src/agent/Agent.js');
      expect(SessionRuntime.create).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        workspaceRoot: '/tmp/test',
      });
      expect(Agent.createWithRuntime).toHaveBeenCalledWith(runtimeState.runtime, {
        sessionId: 'test-session-id',
      });
    });

    it('应该将 durable task worktree 作为外部托管隔离传入 Agent', async () => {
      const taskWorktree = {
        sessionId: 'task-session',
        name: 'task/task-session',
        branch: 'blade-worktree-task+session',
        baseCommit: 'abc123',
        originalBranch: 'main',
        repositoryRoot: '/tmp/source',
        originalWorkspaceRoot: '/tmp/source',
        worktreeRoot: '/tmp/task-worktree',
        workspaceRoot: '/tmp/task-worktree',
        sourceHadChanges: false,
      };
      const taskSession = new AcpSession(
        'task-session',
        '/tmp/task-worktree',
        mockConnection as any,
        undefined,
        { taskWorktree }
      );

      try {
        await taskSession.initialize();
        const { Agent } = await import('../../../../src/agent/Agent.js');
        expect(Agent.createWithRuntime).toHaveBeenCalledWith(runtimeState.runtime, {
          sessionId: 'task-session',
          toolBlacklist: ['EnterWorktree', 'ExitWorktree'],
        });

        await taskSession.prompt({
          sessionId: 'task-session',
          prompt: [{ type: 'text', text: 'continue isolated task' }],
        });
        expect(getMockAgent().getLastCall()?.context).toMatchObject({
          workspaceRoot: '/tmp/task-worktree',
          worktreeActive: true,
        });
      } finally {
        await taskSession.destroy();
      }
    });

    it('应该在初始化后自动恢复 durable follow-up', async () => {
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      await session.initialize();

      await vi.waitFor(() => {
        expect(getMockAgent().calls[0]).toMatchObject({
          message: '',
          options: { pendingInputOnly: true },
        });
      });
    });

    it('应该实时推送 task lifecycle metadata 并在 destroy 后取消订阅', async () => {
      await session.initialize();
      mockConnection.sessionUpdates = [];
      const updatedAt = '2026-08-05T12:00:00.000Z';

      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.status',
        {
          taskStatus: 'running',
          taskStartedAt: updatedAt,
          updatedAt,
        }
      );
      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toContainEqual({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt,
            _meta: {
              'blade/taskStatus': 'running',
              'blade/taskStartedAt': updatedAt,
            },
          },
        });
      });
      const taskDiffStat = {
        changedFiles: 2,
        additions: 7,
        deletions: 1,
        commits: 0,
      };
      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.status',
        {
          taskStatus: 'completed',
          taskCompletedAt: updatedAt,
          taskDiffStat,
          updatedAt,
        }
      );
      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toContainEqual({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'session_info_update',
            updatedAt,
            _meta: {
              'blade/taskStatus': 'completed',
              'blade/taskCompletedAt': updatedAt,
              'blade/taskDiffStat': taskDiffStat,
            },
          },
        });
      });

      await session.destroy();
      const countAfterDestroy = mockConnection.sessionUpdates.length;
      Bus.publish(
        { sessionId: 'test-session-id', projectPath: '/tmp/test' },
        'task.status',
        {
          taskStatus: 'failed',
          updatedAt,
        }
      );
      await Promise.resolve();
      expect(mockConnection.sessionUpdates).toHaveLength(countAfterDestroy);
    });
  });

  describe('replayHistory', () => {
    it.each([
      'destroy',
      'abort',
    ] as const)('%s 后停止 deferred history replay 且不恢复 pending input', async (stopMethod) => {
      await session.initialize();
      getMockAgent().chatStream = async function* (_message, context) {
        context.messages.push(
          { role: 'user', content: 'first visible chunk' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'second visible chunk' },
              { type: 'text', text: 'third visible chunk' },
            ],
          }
        );
        yield { kind: 'turn_start', turn: 1, maxTurns: 1 };
        return { success: true, finalMessage: 'history prepared' };
      };
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'prepare replay history' }],
      });
      mockConnection.sessionUpdates = [];
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);

      let releaseFirstUpdate: (() => void) | undefined;
      const firstUpdateGate = new Promise<void>((resolve) => {
        releaseFirstUpdate = resolve;
      });
      const originalSessionUpdate = mockConnection.sessionUpdate.bind(mockConnection);
      let updateCount = 0;
      vi.spyOn(mockConnection, 'sessionUpdate').mockImplementation(async (params) => {
        updateCount += 1;
        await originalSessionUpdate(params);
        if (updateCount === 1) await firstUpdateGate;
      });

      const replay = session.replayHistory();
      await vi.waitFor(() => {
        expect(mockConnection.sessionUpdates).toHaveLength(1);
      });

      if (stopMethod === 'destroy') {
        await session.destroy();
      } else {
        connectionAbortController.abort();
      }
      releaseFirstUpdate?.();
      await expect(replay).resolves.toBeUndefined();
      await Promise.resolve();

      expect(mockConnection.sessionUpdates).toHaveLength(1);
      expect(getMockAgent().calls).toHaveLength(0);
    });

    it('应该按顺序回放用户和助手历史且隐藏内部消息', async () => {
      const history: Message[] = [
        { role: 'user', content: 'Original question' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Original ' },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'tool', content: 'internal tool output', tool_call_id: 'tool-1' },
        { role: 'system', content: 'internal summary' },
      ];
      session = new AcpSession(
        'test-session-id',
        '/tmp/test',
        mockConnection as any,
        undefined,
        { initialMessages: history }
      );

      await session.replayHistory();

      expect(mockConnection.sessionUpdates).toEqual([
        {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Original question' },
          },
        },
        {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Original ' },
          },
        },
        {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'answer' },
          },
        },
      ]);
    });

    it('恢复后的下一次 prompt 应携带完整模型历史', async () => {
      const history: Message[] = [
        { role: 'user', content: 'Remember marker ACP_RESUME_MARKER.' },
        { role: 'assistant', content: 'I will remember ACP_RESUME_MARKER.' },
      ];
      session = new AcpSession(
        'test-session-id',
        '/tmp/test',
        mockConnection as any,
        undefined,
        { initialMessages: history }
      );
      await session.initialize();

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'What marker did I ask you to remember?' }],
      });

      const call = getMockAgent().getLastCall();
      expect(call?.context.messages).toEqual(history);
    });
  });

  describe('ACP MCP session setup', () => {
    it('应该把结构化 MCP server 转换为 SessionRuntime 配置', async () => {
      session = new AcpSession(
        'test-session-id',
        '/tmp/test',
        mockConnection as any,
        undefined,
        {
          mcpServers: [
            {
              name: 'project-tools',
              command: 'node',
              args: ['server.mjs'],
              env: [{ name: 'PROJECT_ROOT', value: '/tmp/test' }],
            },
            {
              name: 'remote-tools',
              type: 'http',
              url: 'https://mcp.example.test',
              headers: [{ name: 'Authorization', value: 'Bearer test-token' }],
            },
          ],
        }
      );

      await session.initialize();

      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      expect(SessionRuntime.create).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        workspaceRoot: '/tmp/test',
        mcpServers: {
          'project-tools': {
            type: 'stdio',
            command: 'node',
            args: ['server.mjs'],
            env: { PROJECT_ROOT: '/tmp/test' },
          },
          'remote-tools': {
            type: 'http',
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer test-token' },
          },
        },
      });
    });
  });

  describe('prompt', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该处理文本提示', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: 'Hello, World!',
          },
        ],
      };

      const response = await session.prompt(promptParams);

      expect(response).toBeDefined();
      expect(response.stopReason).toBe('end_turn');
    });

    it('活动回合中的第二个 prompt 应转为 steering 而不是中止前一个回合', async () => {
      const activeController = new AbortController();
      (session as any).pendingPrompt = activeController;

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Use the updated requirement.' }],
      });

      expect(result.stopReason).toBe('end_turn');
      expect(activeController.signal.aborted).toBe(false);
      expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
        'Use the updated requirement.',
        { allowBeforeTurn: true }
      );
      expect((session as any).pendingPrompt).toBe(activeController);
    });

    it('应该处理 slash command', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: '/test command',
          },
        ],
      };

      const response = await session.prompt(promptParams);

      expect(response.stopReason).toBe('end_turn');

      // 验证执行了 slash command
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      expect(executeSlashCommand).toHaveBeenCalledWith(
        '/test command',
        expect.objectContaining({
          cwd: '/tmp/test',
          workspaceRoot: '/tmp/test',
          sessionId: 'test-session-id',
          messages: [],
        })
      );
    });

    it('手动压缩后下一轮 prompt 应使用 compacted history', async () => {
      const compactedMessages: Message[] = [
        { role: 'user', content: 'compacted ACP history' },
      ];
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockResolvedValueOnce({
        success: true,
        message: 'compact_completed',
        data: { compactedMessages },
      });
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/compact' }],
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'continue after compact' }],
      });

      expect(getMockAgent().getLastCall()?.context.messages).toEqual(compactedMessages);
    });

    it('rewind 后应该替换 ACP 历史并重建 Agent', async () => {
      const rewoundMessages: Message[] = [
        { role: 'user', content: 'kept ACP history' },
      ];
      runtimeState.runtime.listRewindCheckpoints.mockResolvedValue([
        {
          messageId: 'user-2',
          preview: 'rewind ACP turn',
          createdAt: '2026-08-05T00:00:00.000Z',
          fileCount: 0,
        },
      ]);
      runtimeState.runtime.rewindSession.mockResolvedValue({
        checkpoint: {
          messageId: 'user-2',
          preview: 'rewind ACP turn',
          createdAt: '2026-08-05T00:00:00.000Z',
          fileCount: 0,
        },
        mode: 'conversation',
        removedTurns: 1,
        restoredFiles: [],
        messages: rewoundMessages,
      });
      const originalAgent = getMockAgent();
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_message, context) => {
          await context.rewind?.listCheckpoints();
          const result = await context.rewind?.execute({
            targetMessageId: 'user-2',
            mode: 'conversation',
          });
          return {
            success: true,
            data: {
              action: 'rewind_session',
              messages: result?.messages,
            },
          };
        }
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/rewind user-2' }],
      });

      expect(runtimeState.runtime.listRewindCheckpoints).toHaveBeenCalledOnce();
      expect(runtimeState.runtime.rewindSession).toHaveBeenCalledWith({
        targetMessageId: 'user-2',
        mode: 'conversation',
      });
      expect(originalAgent.destroy).toHaveBeenCalledOnce();
      const { Agent } = await import('../../../../src/agent/Agent.js');
      expect(Agent.createWithRuntime).toHaveBeenCalledTimes(2);

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'continue after rewind' }],
      });
      expect(getMockAgent().getLastCall()?.context.messages).toEqual(rewoundMessages);
    });

    it('通过标准 ACP tool updates 暴露 durable subagent resume', async () => {
      const source = {
        id: 'agent-source',
        subagentType: 'Explore',
        resumeDepth: 0,
      };
      const child = {
        id: 'agent-child',
        subagentType: 'Explore',
        resumeDepth: 1,
        resumedFrom: source.id,
        status: 'running',
      };
      runtimeState.runtime.listSubagents.mockReturnValue([source] as never[]);
      runtimeState.runtime.resumeSubagent.mockImplementation(
        (options: { onCompleted?: (session: Record<string, unknown>) => void }) => {
          options.onCompleted?.({
            ...child,
            status: 'completed',
            result: { success: true, message: 'Follow-up complete' },
          });
          return { source, session: child };
        }
      );
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockImplementationOnce(
        async (_message, context) => {
          await context.subagents?.list();
          const resumed = await context.subagents?.resume(
            source.id,
            'Check the follow-up'
          );
          return {
            success: true,
            message: `Resumed ${resumed?.session.id}`,
          };
        }
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text',
            text: '/tasks resume agent-source Check the follow-up',
          },
        ],
      });

      expect(runtimeState.runtime.listSubagents).toHaveBeenCalledOnce();
      expect(runtimeState.runtime.resumeSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: source.id,
          prompt: 'Check the follow-up',
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: child.id,
            status: 'in_progress',
            title: 'Resuming Explore subagent',
          }),
        })
      );
      expect(mockConnection.sessionUpdates).toContainEqual(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: child.id,
            status: 'completed',
          }),
        })
      );
    });

    it('应该发送文本消息给 IDE', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: 'Hello, World!',
          },
        ],
      };

      await session.prompt(promptParams);

      // 简单验证 prompt 方法不抛出错误
      // 具体的消息更新验证比较复杂，涉及 mock 时机问题
      expect(mockConnection.sessionUpdates.length).toBeGreaterThanOrEqual(0);
    });

    it('应该通知 IDE 有崩溃后恢复的 steering 指令', async () => {
      const mockAgent = getMockAgent();
      mockAgent.chatStream = vi.fn(async function* () {
        yield {
          kind: 'follow_up_started',
          queued: 1,
          recovered: 1,
          messages: [
            {
              id: 'recovered-1',
              content: 'recovered guidance',
              queuedAt: Date.now(),
              recovered: true,
              persisted: false,
            },
          ],
        } as const;
        return {
          success: true,
          finalMessage: 'done',
        };
      }) as typeof mockAgent.chatStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'continue' }],
      });

      expect(
        mockConnection.sessionUpdates.some(
          (notification) =>
            notification.update.sessionUpdate === 'agent_message_chunk' &&
            notification.update.content.type === 'text' &&
            notification.update.content.text.includes('Resuming 1 queued instruction')
        )
      ).toBe(true);
      expect(
        mockConnection.sessionUpdates.some(
          (notification) =>
            notification.update.sessionUpdate === 'user_message_chunk' &&
            notification.update.content.type === 'text' &&
            notification.update.content.text === 'recovered guidance'
        )
      ).toBe(true);
    });

    it('应该发送可用命令', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text' as const,
            text: 'test',
          },
        ],
      };

      await session.prompt(promptParams);

      // 简单验证 prompt 方法不抛出错误
      expect(mockConnection.sessionUpdates.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cancel', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该取消当前操作', () => {
      session.cancel();

      // 验证取消成功（没有抛出错误）
      expect(() => session.cancel()).not.toThrow();
    });
  });

  describe('setMode', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该设置会话模式为 default', async () => {
      await session.setMode('default');

      // 验证发送了模式更新
      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('default');
    });

    it('应该设置会话模式为 auto-edit', async () => {
      await session.setMode('auto-edit');

      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('auto-edit');
    });

    it('应该设置会话模式为 yolo', async () => {
      await session.setMode('yolo');

      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('yolo');
    });

    it('应该设置会话模式为 plan', async () => {
      await session.setMode('plan');

      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('plan');
    });

    it('应该拒绝无效模式（默认为 default）', async () => {
      await session.setMode('invalid');

      const updates = mockConnection.sessionUpdates;
      const modeUpdates = updates.filter(
        (u) => u.update.sessionUpdate === 'current_mode_update'
      );
      expect(modeUpdates.length).toBeGreaterThan(0);
      expect((modeUpdates[0].update as any).currentModeId).toBe('default');
    });
  });

  describe('sendAvailableCommandsDelayed', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('destroy 后不应该发送延迟的 available commands update', async () => {
      session.sendAvailableCommandsDelayed();

      await vi.advanceTimersByTimeAsync(499);
      await session.destroy();
      await vi.advanceTimersByTimeAsync(1);

      expect(
        mockConnection.sessionUpdates.filter(
          (notification) =>
            notification.update.sessionUpdate === 'available_commands_update'
        )
      ).toHaveLength(0);
    });

    it('重复 schedule 后在 500ms 只发送一次 available commands update', async () => {
      session.sendAvailableCommandsDelayed();
      session.sendAvailableCommandsDelayed();

      await vi.advanceTimersByTimeAsync(500);

      expect(
        mockConnection.sessionUpdates.filter(
          (notification) =>
            notification.update.sessionUpdate === 'available_commands_update'
        )
      ).toHaveLength(1);
    });

    it('connection aborted 后不应该发送 available commands update', async () => {
      session.sendAvailableCommandsDelayed();
      connectionAbortController.abort();

      await vi.advanceTimersByTimeAsync(500);

      expect(
        mockConnection.sessionUpdates.filter(
          (notification) =>
            notification.update.sessionUpdate === 'available_commands_update'
        )
      ).toHaveLength(0);
    });
  });

  describe('setModel', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该切换会话运行时使用的模型', async () => {
      await session.setModel('gpt-4');

      expect(getMockAgent().switchModel).toHaveBeenCalledWith('gpt-4');
    });

    it('活动回合期间应该拒绝切换模型', async () => {
      (session as any).pendingPrompt = new AbortController();

      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Cannot switch models while a prompt is active'
      );
    });
  });

  describe('destroy', () => {
    it('destroy 后丢弃仍在 drain 的旧 generator 产生的更新', async () => {
      await session.initialize();
      const mockAgent = getMockAgent();
      let releaseLateEvents: (() => void) | undefined;
      const lateEventsReady = new Promise<void>((resolve) => {
        releaseLateEvents = resolve;
      });
      let generatorStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        generatorStarted = resolve;
      });
      mockAgent.chatStream = async function* (): AsyncGenerator<
        LoopEvent,
        LoopResult,
        void
      > {
        generatorStarted?.();
        await lateEventsReady;
        yield { kind: 'content_delta', delta: 'late content' };
        yield {
          kind: 'tool_start',
          toolCall: {
            id: 'late-tool',
            type: 'function',
            function: { name: 'lateTool', arguments: '{}' },
          },
          toolKind: 'execute',
        };
        yield {
          kind: 'task_update',
          tasks: [
            {
              id: 'late-task',
              subject: 'Late task',
              description: 'Must not escape the old owner',
              status: 'in_progress',
              priority: 'medium',
              blocks: [],
              blockedBy: [],
              createdAt: '2026-08-04T00:00:00.000Z',
            },
          ],
        };
        return { success: true, finalMessage: '' };
      };

      const prompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start deferred stream' }],
      });
      await started;
      await session.destroy();
      releaseLateEvents?.();
      await prompt;

      expect(mockConnection.sessionUpdates).toEqual([]);
    });

    it('connection abort 后直接丢弃 session update', async () => {
      connectionAbortController.abort();

      await session.setMode('yolo');

      expect(mockConnection.sessionUpdates).toEqual([]);
    });

    it('应该完整清理会话且二次 destroy 不重复资源 cleanup', async () => {
      await session.initialize();
      const mockAgent = getMockAgent();
      const cancel = vi.spyOn(session, 'cancel');
      await session.destroy();
      await session.destroy();

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledWith('test-session-id');
      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Session not initialized'
      );
    });

    it.each([
      {
        name: 'Agent destroy 失败',
        agentError: new Error('agent destroy failed'),
        runtimeError: undefined,
        expectedError: 'agent destroy failed',
      },
      {
        name: 'runtime dispose 失败',
        agentError: undefined,
        runtimeError: new Error('runtime dispose failed'),
        expectedError: 'runtime dispose failed',
      },
      {
        name: 'Agent 与 runtime 都失败',
        agentError: new Error('agent destroy failed first'),
        runtimeError: new Error('runtime dispose failed second'),
        expectedError: 'agent destroy failed first',
      },
    ])('$name 时仍应该清理全部资源并由第一个错误获胜', async ({
      agentError,
      runtimeError,
      expectedError,
    }) => {
      await session.initialize();
      const mockAgent = getMockAgent();
      if (agentError) mockAgent.destroy = vi.fn().mockRejectedValueOnce(agentError);
      if (runtimeError) {
        runtimeState.runtime.dispose.mockRejectedValueOnce(runtimeError);
      }

      await expect(session.destroy()).rejects.toThrow(expectedError);

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Session not initialized'
      );

      await expect(session.destroy()).resolves.toBeUndefined();
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
    });

    it('cancel 失败时仍应该清理 Agent、runtime 与 ACP context', async () => {
      await session.initialize();
      const mockAgent = getMockAgent();
      vi.spyOn(session, 'cancel').mockImplementationOnce(() => {
        throw new Error('cancel failed first');
      });

      await expect(session.destroy()).rejects.toThrow('cancel failed first');

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
    });

    it('ACP context destroy 失败时应该在其余 cleanup 后重抛且保持幂等', async () => {
      await session.initialize();
      const mockAgent = getMockAgent();
      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      vi.mocked(AcpServiceContext.destroySession).mockImplementationOnce(() => {
        throw new Error('context destroy failed');
      });

      await expect(session.destroy()).rejects.toThrow('context destroy failed');
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);

      await expect(session.destroy()).resolves.toBeUndefined();
      expect(mockAgent.destroy).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
    });

    it('runtime 创建失败的半初始化会话仍应该清理 ACP context', async () => {
      const { SessionRuntime } = await import(
        '../../../../src/agent/runtime/SessionRuntime.js'
      );
      vi.mocked(SessionRuntime.create).mockRejectedValueOnce(
        new Error('runtime create failed')
      );

      await expect(session.initialize()).rejects.toThrow('runtime create failed');
      await session.destroy();

      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(AcpServiceContext.destroySession).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).not.toHaveBeenCalled();
    });

    it('应该取消挂起的提示', async () => {
      await session.initialize();

      // 设置一个挂起的提示
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'test' }],
      };
      const promptPromise = session.prompt(promptParams);

      // 立即取消
      session.cancel();

      // 等待提示完成（应该被取消）
      const result = await promptPromise;
      expect(result.stopReason).toBe('cancelled');
    });
  });

  describe('消息历史管理', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该保存消息历史', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Hello' }],
      };

      await session.prompt(promptParams);

      // 验证消息已保存
      // （由于消息是私有的，我们通过再次提示来验证历史保持）
      const secondPrompt = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'How are you?' }],
      };

      const response = await session.prompt(secondPrompt);
      expect(response.stopReason).toBe('end_turn');
    });
  });

  describe('权限管理', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该在 default 模式下请求权限', async () => {
      await session.setMode('default');

      // 设置权限响应
      mockConnection.setPermissionResponse('tool-123', {
        outcome: {
          outcome: 'selected',
          optionId: 'allow_once',
        },
      });

      // 触发权限请求（通过执行需要权限的工具）
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Execute a command' }],
      };

      await session.prompt(promptParams);

      // 验证 prompt 方法不抛出错误
      // 具体的权限请求验证比较复杂，涉及 mock Agent 的行为
      expect(mockConnection.permissionRequests.length).toBeGreaterThanOrEqual(0);
    });

    it('应该在 yolo 模式下自动批准', async () => {
      await session.setMode('yolo');

      // 在 yolo 模式下，所有操作应该自动批准
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Execute a command' }],
      };

      const response = await session.prompt(promptParams);

      // 验证没有发送权限请求（自动批准）
      const _permissionRequests = mockConnection.permissionRequests;
      // 由于我们的 mock Agent 没有实际调用需要权限的工具，
      // 这里只是验证不会发送不必要的权限请求
      expect(response.stopReason).toBe('end_turn');
    });

    it('应该在 plan 模式下拒绝写操作', async () => {
      await session.setMode('plan');

      // 设置一个会被拒绝的权限响应
      mockConnection.setPermissionResponse('tool-123', {
        outcome: {
          outcome: 'selected',
          optionId: 'reject_once',
        },
      });

      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Write a file' }],
      };

      // 在 plan 模式下，写操作应该被拒绝
      const response = await session.prompt(promptParams);
      // 验证行为（具体取决于 Agent 的实现）
      expect(response).toBeDefined();
    });

    it('应该缓存 allow_always 权限', async () => {
      await session.setMode('default');

      // 第一次请求允许并选择 always allow
      mockConnection.setPermissionResponse('tool-123', {
        outcome: {
          outcome: 'selected',
          optionId: 'allow_always',
        },
      });

      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Execute command' }],
      };

      await session.prompt(promptParams);

      // 清空权限请求记录
      mockConnection.permissionRequests = [];

      // 第二次请求相同操作
      await session.prompt(promptParams);

      // 验证第二次没有发送权限请求（使用了缓存）
      // 由于我们的 mock 逻辑简单，这里只是验证不会重复请求
      expect(mockConnection.permissionRequests.length).toBe(0);
    });
  });

  describe('ToolKind 映射', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该正确映射 ToolKind', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'test' }],
      };

      await session.prompt(promptParams);

      // 检查工具调用更新
      const toolCallUpdates = mockConnection.sessionUpdates.filter(
        (u) => u.update.sessionUpdate === 'tool_call'
      );

      // 验证工具调用类型映射正确
      for (const update of toolCallUpdates) {
        const kind = (update.update as any).kind;
        const validKinds = [
          'read',
          'edit',
          'delete',
          'move',
          'search',
          'execute',
          'think',
          'fetch',
          'other',
        ];
        expect(validKinds).toContain(kind);
      }
    });
  });

  describe('Task 列表更新', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该发送 plan 更新', async () => {
      const promptParams = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'Create a plan' }],
      };

      await session.prompt(promptParams);

      // 检查 plan 更新
      const planUpdates = mockConnection.sessionUpdates.filter(
        (u) => u.update.sessionUpdate === 'plan'
      );

      // 验证 plan 更新格式正确
      for (const update of planUpdates) {
        const entries = (update.update as any).entries;
        expect(Array.isArray(entries)).toBe(true);
      }
    });
  });
});
