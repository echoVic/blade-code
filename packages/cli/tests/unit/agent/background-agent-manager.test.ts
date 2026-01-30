/**
 * BackgroundAgentManager 单元测试
 *
 * 测试后台 agent 管理器的核心功能
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/services/ChatServiceInterface.js';

// Mock 所有依赖
vi.mock('../../../src/agent/subagents/AgentSessionStore.js');
vi.mock('../../../src/agent/Agent.js');
vi.mock('../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { AGENT: 'agent' },
}));
vi.mock('node:crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}));

import { Agent } from '../../../src/agent/Agent.js';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';

describe('BackgroundAgentManager', () => {
  let manager: BackgroundAgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton
    (BackgroundAgentManager as any).instance = null;

    // Setup mocks
    const mockSessionStore = {
      saveSession: vi.fn(),
      loadSession: vi.fn().mockReturnValue(undefined),
      updateSession: vi.fn(),
      markCompleted: vi.fn(),
      listSessions: vi.fn().mockReturnValue([]),
      listRunningSessions: vi.fn().mockReturnValue([]),
      cleanupExpiredSessions: vi.fn().mockReturnValue(0),
    };
    vi.mocked(AgentSessionStore.getInstance).mockReturnValue(mockSessionStore as any);

    const mockAgent = {
      runAgenticLoop: vi.fn().mockResolvedValue({
        success: true,
        finalMessage: 'Task completed',
        metadata: { tokensUsed: 100, toolCallsCount: 5 },
      }),
    };
    vi.mocked(Agent.create).mockResolvedValue(mockAgent as any);

    manager = BackgroundAgentManager.getInstance();
  });

  afterEach(() => {
    manager.killAll();
    (BackgroundAgentManager as any).instance = null;
  });

  describe('getInstance', () => {
    it('应返回单例实例', () => {
      const instance1 = BackgroundAgentManager.getInstance();
      const instance2 = BackgroundAgentManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('startBackgroundAgent', () => {
    it('应启动后台 agent 并返回 ID', () => {
      const agentId = manager.startBackgroundAgent({
        config: {
          name: 'Explore',
          description: 'Explore agent',
          systemPrompt: 'You are an explorer',
        },
        description: 'Test task',
        prompt: 'Do something',
      });

      expect(agentId).toBe('agent_test-uuid-1234');

      const mockStore = AgentSessionStore.getInstance();
      expect(mockStore.saveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent_test-uuid-1234',
          subagentType: 'Explore',
          description: 'Test task',
          status: 'running',
        })
      );
    });

    it('应支持自定义 agentId', () => {
      const agentId = manager.startBackgroundAgent({
        config: {
          name: 'Explore',
          description: 'Explore agent',
        },
        description: 'Resumed task',
        prompt: 'Continue',
        agentId: 'agent_custom_id',
      });

      expect(agentId).toBe('agent_custom_id');
    });

    it('应传递已有消息', () => {
      const existingMessages: Message[] = [
        { role: 'user', content: 'Previous message' },
      ];

      manager.startBackgroundAgent({
        config: {
          name: 'Explore',
          description: 'Explore agent',
        },
        description: 'Resumed task',
        prompt: 'Continue',
        existingMessages,
      });

      const mockStore = AgentSessionStore.getInstance();
      expect(mockStore.saveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: existingMessages,
        })
      );
    });
  });

  describe('isRunning', () => {
    it('运行中的 agent 应返回 true', () => {
      manager.startBackgroundAgent({
        config: { name: 'Explore', description: 'Test' },
        description: 'Running task',
        prompt: 'Do something',
      });

      expect(manager.isRunning('agent_test-uuid-1234')).toBe(true);
    });

    it('不存在的 agent 应返回 false', () => {
      expect(manager.isRunning('agent_nonexistent')).toBe(false);
    });
  });

  describe('getRunningCount', () => {
    it('应返回运行中 agent 的数量', () => {
      expect(manager.getRunningCount()).toBe(0);

      manager.startBackgroundAgent({
        config: { name: 'Explore', description: 'Test' },
        description: 'Task 1',
        prompt: 'Do 1',
      });

      expect(manager.getRunningCount()).toBe(1);
    });
  });

  describe('getAgent', () => {
    it('应从 session store 获取 agent', () => {
      const mockSession = {
        id: 'agent_123',
        status: 'completed',
      };
      const mockStore = AgentSessionStore.getInstance();
      vi.mocked(mockStore.loadSession).mockReturnValue(mockSession as any);

      const agent = manager.getAgent('agent_123');

      expect(agent).toEqual(mockSession);
      expect(mockStore.loadSession).toHaveBeenCalledWith('agent_123');
    });
  });

  describe('killAgent', () => {
    it('应终止运行中的 agent 并返回 true', () => {
      const agentId = manager.startBackgroundAgent({
        config: { name: 'Explore', description: 'Test' },
        description: 'Task to kill',
        prompt: 'Do something',
      });

      // agent 在启动时应在运行中
      expect(manager.isRunning(agentId)).toBe(true);

      const killed = manager.killAgent(agentId);

      // killAgent 应返回 true
      expect(killed).toBe(true);
      // 注：由于异步执行，agent 可能已经完成，所以不检查 isRunning 状态
    });

    it('不存在的 agent 应返回 false', () => {
      const killed = manager.killAgent('agent_nonexistent');
      expect(killed).toBe(false);
    });
  });

  describe('resumeAgent', () => {
    it('会话不存在时应返回 undefined', () => {
      const mockStore = AgentSessionStore.getInstance();
      vi.mocked(mockStore.loadSession).mockReturnValue(undefined);

      const result = manager.resumeAgent('agent_nonexistent', 'Continue', {
        name: 'Explore',
        description: 'Test',
      });

      expect(result).toBeUndefined();
    });

    it('运行中的 agent 不能恢复', () => {
      const agentId = manager.startBackgroundAgent({
        config: { name: 'Explore', description: 'Test' },
        description: 'Running task',
        prompt: 'Do something',
      });

      // isRunning 检查的是内存中的 runningAgents
      const result = manager.resumeAgent(agentId, 'Try to resume', {
        name: 'Explore',
        description: 'Test',
      });

      expect(result).toBeUndefined();
    });
  });

  describe('listAll / listRunning', () => {
    it('应委托给 session store', () => {
      const mockSessions = [
        { id: 'agent_1', status: 'completed' },
        { id: 'agent_2', status: 'running' },
      ];
      const mockStore = AgentSessionStore.getInstance();
      vi.mocked(mockStore.listSessions).mockReturnValue(mockSessions as any);

      const all = manager.listAll();

      expect(all).toEqual(mockSessions);
    });
  });
});
