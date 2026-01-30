/**
 * BladeAgent 测试
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { createMockACPClient } from '../../mocks/mockACPClient.js';
import { AcpSession } from '../../../src/acp/Session.js';

// Mock AcpSession
vi.mock('../../../src/acp/Session.js', () => ({
  AcpSession: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn(),
    setMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendAvailableCommandsDelayed: vi.fn(),
  })),
}));

// Mock Agent
const MockAgentClass = vi.fn().mockImplementation(() => ({
  chat: vi.fn().mockResolvedValue('Mock response'),
  destroy: vi.fn().mockResolvedValue(undefined),
}));

MockAgentClass.create = vi.fn().mockResolvedValue({
  chat: vi.fn().mockResolvedValue('Mock response'),
  destroy: vi.fn().mockResolvedValue(undefined),
});

vi.mock('../../../src/agent/Agent.js', () => ({
  Agent: MockAgentClass,
}));

// Mock getConfig
vi.mock('../../../src/store/vanilla.js', () => ({
  getConfig: vi.fn(() => ({
    models: [
      { id: 'gpt-4', name: 'GPT-4' },
      { id: 'gpt-3.5', name: 'GPT-3.5' },
    ],
    currentModelId: 'gpt-4',
  })),
}));

// Mock Logger
vi.mock('../../../src/logging/Logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  LogCategory: {
    AGENT: 'AGENT',
  },
}));

describe('BladeAgent', () => {
  let mockConnection: ReturnType<typeof createMockACPClient>;
  let agent: BladeAgent;

  beforeEach(() => {
    // 创建 mock 连接
    mockConnection = createMockACPClient();

    // 创建 BladeAgent 实例
    agent = new BladeAgent(mockConnection as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('应该正确初始化连接', async () => {
      const params = {
        clientCapabilities: {
          promptCapabilities: {
            image: true,
            audio: false,
            embeddedContext: true,
          },
        },
      };

      const response = await agent.initialize(params);

      expect(response).toBeDefined();
      expect(response.protocolVersion).toBeDefined();
      expect(response.agentCapabilities).toBeDefined();
      expect(response.agentCapabilities.promptCapabilities).toEqual({
        image: true,
        audio: false,
        embeddedContext: true,
      });
      expect(response.agentCapabilities.mcpCapabilities).toEqual({
        http: true,
        sse: true,
      });
      expect(response.agentCapabilities.loadSession).toBe(false);
    });

    it('应该保存客户端能力', async () => {
      const params = {
        clientCapabilities: {
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
        },
      };

      await agent.initialize(params);

      // 通过检查后续行为来验证客户端能力已保存
      const response = await agent.initialize(params);
      expect(response.agentCapabilities).toBeDefined();
    });
  });

  describe('authenticate', () => {
    it('应该直接返回（不需要认证）', async () => {
      const params = {
        credentials: {},
      };

      const response = await agent.authenticate(params);

      expect(response).toBeUndefined();
    });
  });

  describe('newSession', () => {
    it('应该创建新会话', async () => {
      const params = {
        cwd: '/tmp/test',
      };

      const response = await agent.newSession(params);

      expect(response).toBeDefined();
      expect(response.sessionId).toBeDefined();
      expect(response.modes).toBeDefined();
      expect(response.modes.availableModes).toEqual([
        {
          id: 'default',
          name: 'Default',
          description: 'Ask for confirmation before all file edits and commands',
        },
        {
          id: 'auto-edit',
          name: 'Auto Edit',
          description: 'Auto-approve file edits, ask for shell commands',
        },
        {
          id: 'yolo',
          name: 'Full Auto',
          description: 'Auto-approve everything without confirmation',
        },
        {
          id: 'plan',
          name: 'Plan Only',
          description: 'Read-only mode, no file changes or commands',
        },
      ]);
      expect(response.modes.currentModeId).toBe('default');
      expect(response.models).toBeDefined();
      expect(response.models?.availableModels).toHaveLength(2);
      expect(response.models?.currentModelId).toBe('gpt-4');
    });

    it('应该使用默认 cwd（当未提供时）', async () => {
      const params = {
        cwd: undefined as any,
      };

      const response = await agent.newSession(params);

      expect(response.sessionId).toBeDefined();
      // 验证会话已创建并调用 initialize
      expect(AcpSession).toHaveBeenCalled();
    });

    it('应该返回可用模型列表', async () => {
      const params = {
        cwd: '/tmp/test',
      };

      const response = await agent.newSession(params);

      expect(response.models).toBeDefined();
      expect(response.models?.availableModels).toEqual([
        {
          modelId: 'gpt-4',
          name: 'GPT-4',
          description: 'Provider: undefined',
        },
        {
          modelId: 'gpt-3.5',
          name: 'GPT-3.5',
          description: 'Provider: undefined',
        },
      ]);
      expect(response.models?.currentModelId).toBe('gpt-4');
    });
  });

  describe('prompt', () => {
    it('应该处理提示请求', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({ cwd: '/tmp/test' });
      const sessionId = newSessionResponse.sessionId;

      const promptParams = {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Hello, World!',
          },
        ],
      };

      const response = await agent.prompt(promptParams);

      expect(response).toBeDefined();
      expect(response.stopReason).toBe('end_turn');
    });

    it('应该拒绝未知会话的提示请求', async () => {
      const promptParams = {
        sessionId: 'nonexistent-session',
        prompt: [
          {
            type: 'text',
            text: 'Hello, World!',
          },
        ],
      };

      await expect(agent.prompt(promptParams)).rejects.toThrow('Session not found');
    });
  });

  describe('cancel', () => {
    it('应该取消指定会话的操作', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({ cwd: '/tmp/test' });
      const sessionId = newSessionResponse.sessionId;

      const cancelParams = {
        sessionId,
      };

      await agent.cancel(cancelParams);

      // 验证会话的 cancel 方法被调用
      const sessionCalls = (AcpSession as any).mock.calls;
      const sessionInstance = sessionCalls[sessionCalls.length - 1]?.[0];
      expect(sessionInstance?.cancel).toHaveBeenCalled();
    });

    it('应该处理取消不存在的会话', async () => {
      const cancelParams = {
        sessionId: 'nonexistent-session',
      };

      // 不应该抛出错误
      await expect(agent.cancel(cancelParams)).resolves.toBeUndefined();
    });
  });

  describe('setSessionMode', () => {
    it('应该设置会话模式', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({ cwd: '/tmp/test' });
      const sessionId = newSessionResponse.sessionId;

      const params = {
        sessionId,
        modeId: 'yolo',
      };

      const response = await agent.setSessionMode(params);

      expect(response).toEqual({});

      // 验证会话的 setMode 方法被调用
      const sessionCalls = (AcpSession as any).mock.calls;
      const sessionInstance = sessionCalls[sessionCalls.length - 1]?.[0];
      expect(sessionInstance?.setMode).toHaveBeenCalledWith('yolo');
    });

    it('应该处理设置不存在会话的模式', async () => {
      const params = {
        sessionId: 'nonexistent-session',
        modeId: 'yolo',
      };

      const response = await agent.setSessionMode(params);

      expect(response).toEqual({});
    });
  });

  describe('unstable_setSessionModel', () => {
    it('应该设置会话模型', async () => {
      // 先创建会话
      const newSessionResponse = await agent.newSession({ cwd: '/tmp/test' });
      const sessionId = newSessionResponse.sessionId;

      const params = {
        sessionId,
        modelId: 'gpt-3.5',
      };

      const response = await agent.unstable_setSessionModel?.(params);

      expect(response).toEqual({});

      // 验证会话的 setModel 方法被调用
      const sessionCalls = (AcpSession as any).mock.calls;
      const sessionInstance = sessionCalls[sessionCalls.length - 1]?.[0];
      expect(sessionInstance?.setModel).toHaveBeenCalledWith('gpt-3.5');
    });
  });

  describe('destroy', () => {
    it('应该销毁所有会话', async () => {
      // 创建多个会话
      await agent.newSession({ cwd: '/tmp/test1' });
      await agent.newSession({ cwd: '/tmp/test2' });

      await agent.destroy();

      // 验证所有会话的 destroy 方法被调用
      const sessionCalls = (AcpSession as any).mock.calls;
      expect(sessionCalls.length).toBe(2);

      for (const call of sessionCalls) {
        const sessionInstance = call?.[0];
        expect(sessionInstance?.destroy).toHaveBeenCalled();
      }
    });

    it('应该清理会话映射', async () => {
      // 创建会话
      const response = await agent.newSession({ cwd: '/tmp/test' });
      const sessionId = response.sessionId;

      // 验证会话存在
      const promptParams = {
        sessionId,
        prompt: [{ type: 'text', text: 'test' }],
      };
      await agent.prompt(promptParams);

      // 销毁
      await agent.destroy();

      // 验证会话已被清理（后续提示应该失败）
      await expect(agent.prompt(promptParams)).rejects.toThrow('Session not found');
    });
  });

  describe('会话管理', () => {
    it('应该正确管理多个会话', async () => {
      // 创建第一个会话
      const response1 = await agent.newSession({ cwd: '/tmp/test1' });
      const sessionId1 = response1.sessionId;

      // 创建第二个会话
      const response2 = await agent.newSession({ cwd: '/tmp/test2' });
      const sessionId2 = response2.sessionId;

      // 验证两个会话都有不同的 ID
      expect(sessionId1).toBeDefined();
      expect(sessionId2).toBeDefined();
      expect(sessionId1).not.toBe(sessionId2);

      // 验证两个会话都可以接收提示
      await agent.prompt({
        sessionId: sessionId1,
        prompt: [{ type: 'text', text: 'test1' }],
      });

      await agent.prompt({
        sessionId: sessionId2,
        prompt: [{ type: 'text', text: 'test2' }],
      });
    });

    it('应该独立取消不同会话', async () => {
      // 创建两个会话
      const response1 = await agent.newSession({ cwd: '/tmp/test1' });
      const response2 = await agent.newSession({ cwd: '/tmp/test2' });
      const sessionId1 = response1.sessionId;
      const sessionId2 = response2.sessionId;

      // 取消第一个会话
      await agent.cancel({ sessionId: sessionId1 });

      // 验证第二个会话仍然可用
      await agent.prompt({
        sessionId: sessionId2,
        prompt: [{ type: 'text', text: 'test' }],
      });

      // 验证第一个会话已被取消
      const sessionCalls = (AcpSession as any).mock.calls;
      const sessionInstance1 = sessionCalls[0]?.[0];
      expect(sessionInstance1?.cancel).toHaveBeenCalled();
    });
  });

  describe('可用命令', () => {
    it('应该在创建会话后发送可用命令', async () => {
      await agent.newSession({ cwd: '/tmp/test' });

      // 等待延迟执行（500ms）
      await new Promise((resolve) => setTimeout(resolve, 600));

      // 验证会话的 sendAvailableCommandsDelayed 方法被调用
      const sessionCalls = (AcpSession as any).mock.calls;
      const sessionInstance = sessionCalls[sessionCalls.length - 1]?.[0];
      expect(sessionInstance?.sendAvailableCommandsDelayed).toHaveBeenCalled();
    });
  });
});
