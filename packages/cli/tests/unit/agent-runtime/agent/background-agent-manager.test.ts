/**
 * BackgroundAgentManager 单元测试
 *
 * 测试后台 agent 管理器的核心功能
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../src/config/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

const runtimeState = vi.hoisted(() => ({
  runtime: {
    sessionId: 'session_test-uuid-1234',
    dispose: vi.fn().mockResolvedValue(undefined),
  },
}));

const worktreeState = vi.hoisted(() => ({
  prepare: vi.fn(
    async (input: {
      isolation?: 'none' | 'worktree';
      sourceWorkspaceRoot: string;
      agentId: string;
    }) => ({
      isolation: input.isolation ?? 'none',
      workspaceRoot:
        input.isolation === 'worktree'
          ? '/tmp/agent-worktree'
          : input.sourceWorkspaceRoot,
      worktree:
        input.isolation === 'worktree'
          ? {
              sessionId: input.agentId,
              name: `agent/${input.agentId}`,
              branch: 'blade-worktree-agent',
              baseCommit: 'abc',
              originalBranch: 'main',
              repositoryRoot: '/repo',
              originalWorkspaceRoot: input.sourceWorkspaceRoot,
              worktreeRoot: '/tmp/agent-worktree',
              workspaceRoot: '/tmp/agent-worktree',
              sourceHadChanges: false,
            }
          : undefined,
    })
  ),
  finalize: vi.fn(async () => ({
    preserved: true,
    removed: false,
    worktreePath: '/tmp/agent-worktree',
    worktreeBranch: 'blade-worktree-agent',
    worktree: {
      sessionId: 'session_test-uuid-1234',
      name: 'agent/session_test-uuid-1234',
      branch: 'blade-worktree-agent',
      baseCommit: 'abc',
      originalBranch: 'main',
      repositoryRoot: '/repo',
      originalWorkspaceRoot: '/repo',
      worktreeRoot: '/tmp/agent-worktree',
      workspaceRoot: '/tmp/agent-worktree',
      sourceHadChanges: false,
    },
  })),
}));

// Mock 所有依赖
vi.mock('../../../../src/agent/subagents/AgentSessionStore.js');
vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    create: vi.fn(),
    createWithRuntime: vi.fn(),
  },
}));
vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
  },
}));
vi.mock('../../../../src/agent/subagents/SubagentWorktreeLifecycle.js', () => ({
  subagentWorktreeLifecycle: {
    prepare: worktreeState.prepare,
    finalize: worktreeState.finalize,
  },
}));
vi.mock('../../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { AGENT: 'agent' },
}));
vi.mock('nanoid', () => ({
  nanoid: () => 'session_test-uuid-1234',
}));

import { Agent } from '../../../../src/agent/Agent.js';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import { AgentSessionStore } from '../../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../../src/agent/subagents/BackgroundAgentManager.js';

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
      deleteSession: vi.fn().mockReturnValue(true),
    };
    vi.mocked(AgentSessionStore.getInstance).mockReturnValue(mockSessionStore as any);

    const mockAgent = {
      chatStream: vi.fn(async function* () {
        if (Date.now() < 0) {
          yield { kind: 'stream_end' as const };
        }
        return {
          success: true,
          finalMessage: 'Task completed',
          metadata: {
            turnsCount: 1,
            tokensUsed: 100,
            toolCallsCount: 5,
            duration: 10,
          },
        };
      }),
    };
    vi.mocked(Agent.createWithRuntime).mockResolvedValue(mockAgent as any);

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
    it('应为后台 agent 创建独立 runtime', async () => {
      manager.startBackgroundAgent({
        config: {
          name: 'Explore',
          description: 'Explore agent',
          systemPrompt: 'You are an explorer',
        },
        description: 'Test task',
        prompt: 'Do something',
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(SessionRuntime.create).toHaveBeenCalledWith({
        sessionId: 'session_test-uuid-1234',
        modelId: undefined,
      });
      expect(Agent.createWithRuntime).toHaveBeenCalledWith(
        runtimeState.runtime,
        expect.objectContaining({
          sessionId: 'session_test-uuid-1234',
          appendSystemPrompt: 'You are an explorer',
        })
      );
    });

    it('应执行自定义 agent 的工具、回合和权限限制', async () => {
      const agentId = manager.startBackgroundAgent({
        config: {
          name: 'restricted-reviewer',
          description: 'Review with invocation limits',
          tools: ['Read', 'Bash'],
          disallowedTools: ['Bash', 'Write'],
          maxTurns: 3,
          permissionMode: PermissionMode.PLAN,
        },
        description: 'Review changes',
        prompt: 'Review the current change',
        permissionMode: PermissionMode.YOLO,
      });

      await manager.waitForCompletion(agentId, 0);

      expect(Agent.createWithRuntime).toHaveBeenCalledWith(
        runtimeState.runtime,
        expect.objectContaining({
          toolWhitelist: ['Read', 'Bash'],
          toolBlacklist: ['EnterWorktree', 'ExitWorktree', 'Bash', 'Write'],
          maxTurns: 3,
          permissionMode: PermissionMode.PLAN,
        })
      );
      const createdAgent = await vi.mocked(Agent.createWithRuntime).mock.results[0]
        .value;
      expect(createdAgent.chatStream).toHaveBeenCalledWith(
        'Review the current change',
        expect.objectContaining({ permissionMode: PermissionMode.PLAN }),
        expect.anything()
      );
    });

    it('应在预创建 worktree 中运行并持久化 lease', async () => {
      const agentId = manager.startBackgroundAgent({
        config: {
          name: 'writer',
          description: 'Writer agent',
          systemPrompt: 'Focus on implementation and verification.',
        },
        description: 'Implement change',
        prompt: 'Implement the requested code change',
        workspaceRoot: '/repo',
        isolation: 'worktree',
      });

      await manager.waitForCompletion(agentId, 0);

      expect(worktreeState.prepare).toHaveBeenCalledWith({
        agentId,
        sourceWorkspaceRoot: '/repo',
        isolation: 'worktree',
        restoredWorktree: undefined,
      });
      expect(Agent.createWithRuntime).toHaveBeenCalledWith(
        runtimeState.runtime,
        expect.objectContaining({
          toolBlacklist: expect.arrayContaining(['EnterWorktree', 'ExitWorktree']),
          appendSystemPrompt: 'Focus on implementation and verification.',
        })
      );
      const createdAgent = await vi.mocked(Agent.createWithRuntime).mock.results[0]
        .value;
      expect(createdAgent.chatStream).toHaveBeenCalledWith(
        'Implement the requested code change',
        expect.objectContaining({
          workspaceRoot: '/tmp/agent-worktree',
          worktreeActive: true,
        }),
        expect.anything()
      );
      expect(worktreeState.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId,
          success: true,
        })
      );
      expect(AgentSessionStore.getInstance().updateSession).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({
          worktree: expect.objectContaining({
            worktreeRoot: '/tmp/agent-worktree',
          }),
        })
      );
    });

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

      expect(agentId).toBe('session_test-uuid-1234');

      const mockStore = AgentSessionStore.getInstance();
      expect(mockStore.saveSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'session_test-uuid-1234',
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

      expect(manager.isRunning('session_test-uuid-1234')).toBe(true);
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

    it('不向其他 parent session 暴露 agent', () => {
      const mockStore = AgentSessionStore.getInstance();
      vi.mocked(mockStore.loadSession).mockReturnValue({
        id: 'agent_private',
        parentSessionId: 'parent-owner',
        status: 'completed',
      } as any);

      expect(manager.getAgent('agent_private', 'parent-owner')).toBeDefined();
      expect(manager.getAgent('agent_private', 'parent-other')).toBeUndefined();
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

    it('其他 parent session 不能恢复 agent', () => {
      const mockStore = AgentSessionStore.getInstance();
      vi.mocked(mockStore.loadSession).mockReturnValue({
        id: 'agent_private',
        parentSessionId: 'parent-owner',
        status: 'completed',
        description: 'Private task',
        messages: [],
      } as any);

      const result = manager.resumeAgent(
        'agent_private',
        'Continue',
        { name: 'Explore', description: 'Test' },
        'parent-other'
      );

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

    it('只列出指定 parent session 的 agent', () => {
      const mockStore = AgentSessionStore.getInstance();
      vi.mocked(mockStore.listSessions).mockReturnValue([
        { id: 'agent_a', parentSessionId: 'parent-a' },
        { id: 'agent_b', parentSessionId: 'parent-b' },
      ] as any);

      expect(manager.listForSession('parent-a')).toEqual([
        expect.objectContaining({ id: 'agent_a' }),
      ]);
    });

    it('只清理指定 parent session 中已结束的 agent', () => {
      const mockStore = AgentSessionStore.getInstance();
      vi.mocked(mockStore.listSessions).mockReturnValue([
        {
          id: 'agent_completed_a',
          parentSessionId: 'parent-a',
          status: 'completed',
          lastActiveAt: 0,
        },
        {
          id: 'agent_running_a',
          parentSessionId: 'parent-a',
          status: 'running',
          lastActiveAt: 0,
        },
        {
          id: 'agent_completed_b',
          parentSessionId: 'parent-b',
          status: 'completed',
          lastActiveAt: 0,
        },
      ] as any);

      expect(manager.cleanupExpiredSessionsForParent('parent-a', 0)).toBe(1);
      expect(mockStore.deleteSession).toHaveBeenCalledTimes(1);
      expect(mockStore.deleteSession).toHaveBeenCalledWith('agent_completed_a');
    });
  });
});
