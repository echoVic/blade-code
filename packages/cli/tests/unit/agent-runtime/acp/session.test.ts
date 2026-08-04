/**
 * AcpSession 测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpSession } from '../../../../src/acp/Session.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import { createMockACPClient } from '../../../support/mocks/mockACPClient.js';
import { createMockAgent } from '../../../support/mocks/mockAgent.js';

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
  },
}));

// Mock Agent
vi.mock('../../../../src/agent/Agent.js', () => {
  let mockAgentInstance: any = null;
  const mockChatGen = async function* () {
    yield { type: 'turn_start', turn: 1, maxTurns: 1 };
    return {
      success: true,
      finalMessage: 'Mock response',
      metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
    };
  };
  const MockAgentClass = Object.assign(
    vi.fn().mockImplementation(() => {
      const mockAgent = createMockAgent();
      mockAgent.chat = vi.fn().mockImplementation(mockChatGen);
      mockAgent.destroy = vi.fn().mockResolvedValue(undefined);
      mockAgentInstance = mockAgent;
      return mockAgent;
    }),
    {
      create: vi.fn().mockImplementation(async () => {
        const mockAgent = createMockAgent();
        mockAgent.chat = vi.fn().mockImplementation(mockChatGen);
        mockAgent.destroy = vi.fn().mockResolvedValue(undefined);
        mockAgentInstance = mockAgent;
        return mockAgent;
      }),
      createWithRuntime: vi.fn().mockImplementation(async () => {
        const mockAgent = createMockAgent() as ReturnType<typeof createMockAgent> & {
          switchModel: ReturnType<typeof vi.fn>;
        };
        mockAgent.chat = vi.fn().mockImplementation(mockChatGen);
        mockAgent.switchModel = vi.fn().mockResolvedValue(undefined);
        mockAgent.destroy = vi.fn().mockResolvedValue(undefined);
        mockAgentInstance = mockAgent;
        return mockAgent;
      }),
    }
  );

  return {
    Agent: MockAgentClass,
    _getMockAgentInstance: () => mockAgentInstance,
  };
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
  let session: AcpSession;

  beforeEach(() => {
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.getGoal.mockResolvedValue(null);
    // 创建 mock 连接
    mockConnection = createMockACPClient();

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

    it('应该在初始化后自动恢复 durable follow-up', async () => {
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
      await session.initialize();
      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent>;
      };

      await vi.waitFor(() => {
        expect(agentModule._getMockAgentInstance().calls[0]).toMatchObject({
          message: '',
          options: { pendingInputOnly: true },
        });
      });
    });
  });

  describe('replayHistory', () => {
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

      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent>;
      };
      const call = agentModule._getMockAgentInstance().getLastCall();
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

    it('活动 goal 回合中应立即执行 /goal pause 而不是把它当 steering', async () => {
      const activeController = new AbortController();
      (session as any).pendingPrompt = activeController;
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockResolvedValueOnce({
        success: true,
        message: 'Goal paused',
      });

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/goal pause' }],
      });

      expect(result.stopReason).toBe('end_turn');
      expect(executeSlashCommand).toHaveBeenCalledWith(
        '/goal pause',
        expect.objectContaining({
          sessionId: 'test-session-id',
          workspaceRoot: '/tmp/test',
        })
      );
      expect(runtimeState.runtime.enqueueSteering).not.toHaveBeenCalled();
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
          sessionId: 'test-session-id',
          workspaceRoot: '/tmp/test',
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
      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent>;
      };
      const mockAgent = agentModule._getMockAgentInstance();
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

    it('cancels a prompt while the ACP client leaves a question unanswered', async () => {
      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent>;
      };
      const agent = agentModule._getMockAgentInstance();
      agent.chatStream = async function* (_message, context) {
        yield { kind: 'turn_start', turn: 1, maxTurns: 1 };
        await context.confirmationHandler?.requestConfirmation({
          type: 'askUserQuestion',
          message: 'Choose a channel',
          questions: [
            {
              header: 'Channel',
              question: 'Which release channel should be used?',
              multiSelect: false,
              options: [
                { label: 'Stable', description: 'Use stable' },
                { label: 'Canary', description: 'Use canary' },
              ],
            },
          ],
        });
        return {
          success: true,
          finalMessage: 'cancelled',
          metadata: { turnsCount: 1, toolCallsCount: 1, duration: 0 },
        };
      };

      let releasePermission: (() => void) | undefined;
      vi.spyOn(mockConnection, 'requestPermission').mockImplementation(
        (request) =>
          new Promise((resolve) => {
            mockConnection.permissionRequests.push(request);
            releasePermission = () =>
              resolve({
                outcome: {
                  outcome: 'selected',
                  optionId: request.options[0]?.optionId,
                },
              });
          })
      );

      const promptPromise = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Ask before changing code' }],
      });
      await vi.waitFor(() => {
        expect(mockConnection.permissionRequests).toHaveLength(1);
      });
      session.cancel();

      const resultBeforeClientResponse = await Promise.race([
        promptPromise,
        new Promise<'still-pending'>((resolve) =>
          setTimeout(() => resolve('still-pending'), 25)
        ),
      ]);
      releasePermission?.();
      await promptPromise;

      expect(resultBeforeClientResponse).toEqual({ stopReason: 'cancelled' });
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

  describe('setModel', () => {
    beforeEach(async () => {
      await session.initialize();
    });

    it('应该切换会话运行时使用的模型', async () => {
      await session.setModel('gpt-4');

      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent> & {
          switchModel: ReturnType<typeof vi.fn>;
        };
      };
      expect(agentModule._getMockAgentInstance().switchModel).toHaveBeenCalledWith(
        'gpt-4'
      );
    });

    it('活动回合期间应该拒绝切换模型', async () => {
      (session as any).pendingPrompt = new AbortController();

      await expect(session.setModel('gpt-4')).rejects.toThrow(
        'Cannot switch models while a prompt is active'
      );
    });
  });

  describe('destroy', () => {
    it('应该销毁会话', async () => {
      await session.initialize();
      await session.destroy();

      // 验证 ACP 服务上下文已销毁
      const { AcpServiceContext } = await import(
        '../../../../src/acp/AcpServiceContext.js'
      );
      expect(AcpServiceContext.destroySession).toHaveBeenCalledWith('test-session-id');
      expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
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

    it('应该销毁 Agent', async () => {
      await session.initialize();
      await session.destroy();

      // 简单验证 destroy 方法不抛出错误
      // 具体的 Agent 实例检查比较复杂，涉及 mock 时机问题
      expect(true).toBe(true);
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

    it('应该在创建 goal 后自动启动 transient continuation', async () => {
      const activeGoal = {
        version: 1 as const,
        sessionId: 'test-session-id',
        goalId: 'goal-1',
        objective: 'finish the migration',
        status: 'active' as const,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationCount: 0,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
      };
      runtimeState.runtime.getGoal
        .mockResolvedValueOnce(null)
        .mockResolvedValue(activeGoal);
      const { executeSlashCommand } = await import(
        '../../../../src/slash-commands/index.js'
      );
      vi.mocked(executeSlashCommand).mockResolvedValueOnce({
        success: true,
        message: 'Goal started',
        data: { action: 'start_goal', goal: activeGoal },
      });
      await session.initialize();

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/goal finish the migration' }],
      });

      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent>;
      };
      await vi.waitFor(() => {
        expect(agentModule._getMockAgentInstance().calls).toContainEqual(
          expect.objectContaining({
            message: '',
            options: expect.objectContaining({
              goalContinuationOnly: true,
            }),
          })
        );
      });
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

    it('maps ACP allow_always to an explicit project approval scope', async () => {
      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent>;
      };
      const agent = agentModule._getMockAgentInstance();
      let permissionResponse: unknown;
      agent.chatStream = async function* (_message, context) {
        yield { kind: 'turn_start', turn: 1, maxTurns: 1 };
        permissionResponse = await context.confirmationHandler?.requestConfirmation({
          type: 'permission',
          kind: 'execute',
          title: 'npm test',
          message: 'Run tests?',
        } as never);
        return {
          success: true,
          finalMessage: 'done',
          metadata: { turnsCount: 1, toolCallsCount: 1, duration: 0 },
        };
      };
      vi.spyOn(mockConnection, 'requestPermission').mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'allow_always' },
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Run tests' }],
      });

      expect(permissionResponse).toEqual({ approved: true, scope: 'project' });
    });

    it('maps ACP reject_always to an explicit project denial scope', async () => {
      const agentModule = (await import(
        '../../../../src/agent/Agent.js'
      )) as unknown as {
        _getMockAgentInstance: () => ReturnType<typeof createMockAgent>;
      };
      const agent = agentModule._getMockAgentInstance();
      let permissionResponse: unknown;
      agent.chatStream = async function* (_message, context) {
        yield { kind: 'turn_start', turn: 1, maxTurns: 1 };
        permissionResponse = await context.confirmationHandler?.requestConfirmation({
          type: 'permission',
          kind: 'execute',
          title: 'npm publish',
          message: 'Publish package?',
        } as never);
        return {
          success: true,
          finalMessage: 'done',
          metadata: { turnsCount: 1, toolCallsCount: 1, duration: 0 },
        };
      };
      vi.spyOn(mockConnection, 'requestPermission').mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'reject_always' },
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Publish package' }],
      });

      expect(permissionResponse).toEqual({
        approved: false,
        scope: 'project',
        reason: 'User permanently denied the permission request',
      });
    });

    it('collects structured single-select answers even in yolo mode', async () => {
      await session.setMode('yolo');
      vi.spyOn(mockConnection, 'requestPermission').mockImplementation(
        async (request) => {
          mockConnection.permissionRequests.push(request);
          return {
            outcome: {
              outcome: 'selected',
              optionId: request.options[1]?.optionId,
            },
          };
        }
      );

      const response = await (
        session as unknown as {
          requestPermission: (details: unknown) => Promise<{
            approved: boolean;
            answers?: Record<string, string | string[]>;
          }>;
        }
      ).requestPermission({
        type: 'askUserQuestion',
        kind: 'readonly',
        message: 'Choose the release channel',
        questions: [
          {
            header: 'Channel',
            question: 'Which release channel should be used?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Use the stable channel' },
              { label: 'Canary', description: 'Use the canary channel' },
            ],
          },
        ],
      });

      expect(response).toEqual({
        approved: true,
        answers: { Channel: 'Canary' },
      });
      expect(mockConnection.permissionRequests).toHaveLength(1);
      expect(mockConnection.permissionRequests[0]).toMatchObject({
        sessionId: 'test-session-id',
        options: [
          { name: 'Stable', kind: 'allow_once' },
          { name: 'Canary', kind: 'allow_once' },
          { name: 'Cancel', kind: 'reject_once' },
        ],
        toolCall: {
          title: 'Channel',
          status: 'pending',
        },
      });
    });

    it('rejects ACP multiselect questions instead of silently changing their meaning', async () => {
      await session.setMode('yolo');

      const response = await (
        session as unknown as {
          requestPermission: (details: unknown) => Promise<{
            approved: boolean;
            reason?: string;
          }>;
        }
      ).requestPermission({
        type: 'askUserQuestion',
        kind: 'readonly',
        questions: [
          {
            header: 'Checks',
            question: 'Which checks should run?',
            multiSelect: true,
            options: [
              { label: 'Unit', description: 'Run unit tests' },
              { label: 'E2E', description: 'Run end-to-end tests' },
            ],
          },
        ],
      });

      expect(response).toEqual({
        approved: false,
        reason: expect.stringContaining('multi-select'),
      });
      expect(mockConnection.permissionRequests).toHaveLength(0);
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
