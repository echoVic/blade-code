/**
 * /tasks Slash Command 单元测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock UI
const mockSendMessage = vi.fn();
const mockUI = {
  sendMessage: mockSendMessage,
};

// Mock getUI helper
vi.mock('../../../../src/slash-commands/types.js', async () => {
  const actual = await vi.importActual('../../../../src/slash-commands/types.js');
  return {
    ...actual,
    getUI: () => mockUI,
  };
});

// Mock BackgroundShellManager
const mockShellManager = {
  listForSession: vi.fn(),
  kill: vi.fn(),
};

vi.mock('../../../../src/tools/builtin/shell/BackgroundShellManager.js', () => ({
  BackgroundShellManager: {
    getInstance: () => mockShellManager,
  },
}));

// Mock BackgroundAgentManager
const mockAgentManager = {
  listForSession: vi.fn(),
  killAgent: vi.fn(),
  cleanupExpiredSessionsForParent: vi.fn(),
};

vi.mock('../../../../src/agent/subagents/BackgroundAgentManager.js', () => ({
  BackgroundAgentManager: {
    getInstance: () => mockAgentManager,
  },
}));

import tasksCommand from '../../../../src/slash-commands/tasks.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

describe('/tasks Command', () => {
  const mockContext: SlashCommandContext = {
    cwd: '/test/project',
    sessionId: 'session-owner',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockShellManager.listForSession.mockReturnValue([]);
    mockAgentManager.listForSession.mockReturnValue([]);
  });

  describe('command metadata', () => {
    it('应有正确的名称和描述', () => {
      expect(tasksCommand.name).toBe('tasks');
      expect(tasksCommand.description).toContain('后台任务');
    });
  });

  describe('list tasks (default)', () => {
    it('只请求当前 session 的后台任务', async () => {
      await tasksCommand.handler([], mockContext);

      expect(mockShellManager.listForSession).toHaveBeenCalledWith('session-owner');
      expect(mockAgentManager.listForSession).toHaveBeenCalledWith('session-owner');
    });

    it('无任务时应显示空列表', async () => {
      const result = await tasksCommand.handler([], mockContext);

      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalled();
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('后台任务列表');
      expect(message).toContain('暂无后台任务');
    });

    it('应列出后台 shells', async () => {
      mockShellManager.listForSession.mockReturnValue([
        {
          id: 'bash_abc123',
          command: 'npm test',
          status: 'running',
          startTime: Date.now() - 5000,
          pid: 12345,
        },
      ]);

      const result = await tasksCommand.handler([], mockContext);

      expect(result.success).toBe(true);
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('Shells');
      expect(message).toContain('bash_abc123');
      expect(message).toContain('npm test');
      expect(message).toContain('running');
    });

    it('应列出后台 agents', async () => {
      mockAgentManager.listForSession.mockReturnValue([
        {
          id: 'agent_xyz789',
          subagentType: 'Explore',
          description: 'Find API endpoints',
          status: 'completed',
          createdAt: Date.now() - 10000,
          completedAt: Date.now() - 5000,
        },
        {
          id: 'agent_abc456',
          subagentType: 'Plan',
          description: 'Plan authentication',
          status: 'running',
          createdAt: Date.now() - 3000,
        },
      ]);
      const result = await tasksCommand.handler([], mockContext);

      expect(result.success).toBe(true);
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('Agents');
      expect(message).toContain('agent_xyz789');
      expect(message).toContain('Explore');
      expect(message).toContain('agent_abc456');
      expect(message).toContain('Plan');
      expect(message).toContain('2 agents (1 运行中)');
    });

    it('应显示统计信息', async () => {
      mockShellManager.listForSession.mockReturnValue([
        {
          id: 'bash_1',
          command: 'sleep 100',
          status: 'running',
          startTime: Date.now(),
        },
        {
          id: 'bash_2',
          command: 'echo done',
          status: 'exited',
          startTime: Date.now() - 1000,
          endTime: Date.now(),
        },
      ]);

      mockAgentManager.listForSession.mockReturnValue([
        {
          id: 'agent_1',
          status: 'completed',
          createdAt: Date.now(),
          subagentType: 'Explore',
          description: 'Test',
        },
      ]);
      await tasksCommand.handler([], mockContext);

      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('2 shells (1 运行中)');
      expect(message).toContain('1 agents (0 运行中)');
    });
  });

  describe('kill subcommand', () => {
    it('kill 子命令已移除', async () => {
      const result = await tasksCommand.handler(['kill', 'bash_abc123'], mockContext);
      expect(result.success).toBe(true);

      // 退化为默认列表行为
      expect(mockShellManager.kill).not.toHaveBeenCalled();
      expect(mockAgentManager.killAgent).not.toHaveBeenCalled();
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('后台任务列表');
    });
  });

  describe('clean subcommand', () => {
    it('应清理已完成的 agent 会话', async () => {
      mockAgentManager.cleanupExpiredSessionsForParent.mockReturnValue(5);

      const result = await tasksCommand.handler(['clean'], mockContext);

      expect(result.success).toBe(true);
      expect(mockAgentManager.cleanupExpiredSessionsForParent).toHaveBeenCalledWith(
        'session-owner',
        0
      );
      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('已清理 5 个');
    });
  });

  describe('status icons', () => {
    it('running 应显示 [RUNNING]', async () => {
      mockAgentManager.listForSession.mockReturnValue([
        {
          id: 'agent_running',
          subagentType: 'Explore',
          description: 'Running task',
          status: 'running',
          createdAt: Date.now(),
        },
      ]);

      await tasksCommand.handler([], mockContext);

      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('[RUNNING]');
    });

    it('completed 应显示 [OK]', async () => {
      mockAgentManager.listForSession.mockReturnValue([
        {
          id: 'agent_done',
          subagentType: 'Explore',
          description: 'Done task',
          status: 'completed',
          createdAt: Date.now() - 1000,
          completedAt: Date.now(),
        },
      ]);

      await tasksCommand.handler([], mockContext);

      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('[OK]');
    });

    it('failed 应显示 [FAIL]', async () => {
      mockAgentManager.listForSession.mockReturnValue([
        {
          id: 'agent_failed',
          subagentType: 'Explore',
          description: 'Failed task',
          status: 'failed',
          createdAt: Date.now() - 1000,
          completedAt: Date.now(),
        },
      ]);

      await tasksCommand.handler([], mockContext);

      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('[FAIL]');
    });

    it('cancelled 应显示 [STOPPED]', async () => {
      mockAgentManager.listForSession.mockReturnValue([
        {
          id: 'agent_cancelled',
          subagentType: 'Explore',
          description: 'Cancelled task',
          status: 'cancelled',
          createdAt: Date.now() - 1000,
        },
      ]);

      await tasksCommand.handler([], mockContext);

      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('[STOPPED]');
    });
  });

  describe('help text', () => {
    it('应显示可用命令', async () => {
      await tasksCommand.handler([], mockContext);

      const message = mockSendMessage.mock.calls[0][0];
      expect(message).toContain('/tasks');
      expect(message).toContain('/tasks clean');
    });
  });
});
