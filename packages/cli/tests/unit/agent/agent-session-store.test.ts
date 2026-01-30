/**
 * AgentSessionStore 单元测试
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
}));

// Mock os.homedir
vi.mock('node:os', () => ({
  default: {
    homedir: () => '/home/test',
  },
  homedir: () => '/home/test',
}));

// Mock logger
vi.mock('../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { AGENT: 'agent' },
}));

import {
  type AgentSession,
  AgentSessionStore,
} from '../../../src/agent/subagents/AgentSessionStore.js';

describe('AgentSessionStore', () => {
  let store: AgentSessionStore;

  beforeEach(() => {
    vi.resetAllMocks();
    // Reset singleton
    (AgentSessionStore as any).instance = null;

    // Default mock: directory exists
    (fs.existsSync as any).mockReturnValue(true);

    store = AgentSessionStore.getInstance();
  });

  afterEach(() => {
    (AgentSessionStore as any).instance = null;
  });

  describe('getInstance', () => {
    it('应返回单例实例', () => {
      const instance1 = AgentSessionStore.getInstance();
      const instance2 = AgentSessionStore.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('目录不存在时应创建目录', () => {
      (AgentSessionStore as any).instance = null;
      (fs.existsSync as any).mockReturnValue(false);

      AgentSessionStore.getInstance();

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.blade/agents/sessions'),
        expect.objectContaining({ recursive: true })
      );
    });
  });

  describe('saveSession', () => {
    it('应保存会话到文件', () => {
      const session: AgentSession = {
        id: 'agent_test123',
        subagentType: 'Explore',
        description: 'Test task',
        prompt: 'Do something',
        messages: [],
        status: 'running',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };

      store.saveSession(session);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('agent_test123.json'),
        expect.any(String),
        'utf-8'
      );

      // 验证 JSON 内容
      const writtenData = (fs.writeFileSync as any).mock.calls[0][1];
      const parsed = JSON.parse(writtenData);
      expect(parsed.id).toBe('agent_test123');
      expect(parsed.subagentType).toBe('Explore');
    });

    it('应安全处理特殊字符的 ID', () => {
      const session: AgentSession = {
        id: 'agent_../../../etc/passwd',
        subagentType: 'Explore',
        description: 'Malicious',
        prompt: 'Evil',
        messages: [],
        status: 'running',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };

      store.saveSession(session);

      // 验证路径被安全处理（特殊字符被替换）
      const filePath = (fs.writeFileSync as any).mock.calls[0][0];
      // 路径遍历字符 '..' 应该被替换为 '__'
      expect(filePath).not.toMatch(/\.\.\//);
      // 文件名中的 / 被替换为 _
      expect(filePath).toMatch(/agent_.*\.json$/);
    });
  });

  describe('loadSession', () => {
    it('应从文件加载会话', () => {
      const sessionData: AgentSession = {
        id: 'agent_abc',
        subagentType: 'Plan',
        description: 'Plan task',
        prompt: 'Create plan',
        messages: [],
        status: 'completed',
        createdAt: 1000,
        lastActiveAt: 2000,
        completedAt: 2000,
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(sessionData));

      const loaded = store.loadSession('agent_abc');

      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe('agent_abc');
      expect(loaded?.status).toBe('completed');
    });

    it('会话不存在时应返回 undefined', () => {
      (fs.existsSync as any).mockReturnValue(false);

      const loaded = store.loadSession('agent_nonexistent');

      expect(loaded).toBeUndefined();
    });

    it('应使用缓存避免重复读取', () => {
      const sessionData: AgentSession = {
        id: 'agent_cached',
        subagentType: 'Explore',
        description: 'Cached',
        prompt: 'Test',
        messages: [],
        status: 'running',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(sessionData));

      // 第一次加载
      store.loadSession('agent_cached');
      // 第二次加载
      store.loadSession('agent_cached');

      // 只应读取一次文件
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateSession', () => {
    it('应更新会话状态', () => {
      const sessionData: AgentSession = {
        id: 'agent_update',
        subagentType: 'Explore',
        description: 'Update test',
        prompt: 'Test',
        messages: [],
        status: 'running',
        createdAt: 1000,
        lastActiveAt: 1000,
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(sessionData));

      const updated = store.updateSession('agent_update', {
        status: 'completed',
        completedAt: 2000,
      });

      expect(updated).toBeDefined();
      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).toBe(2000);
      expect(updated?.lastActiveAt).toBeGreaterThan(1000);
    });

    it('会话不存在时应返回 undefined', () => {
      (fs.existsSync as any).mockReturnValue(false);

      const updated = store.updateSession('agent_nonexistent', { status: 'failed' });

      expect(updated).toBeUndefined();
    });
  });

  describe('markCompleted', () => {
    it('应标记会话为已完成', () => {
      const sessionData: AgentSession = {
        id: 'agent_complete',
        subagentType: 'Explore',
        description: 'Complete test',
        prompt: 'Test',
        messages: [],
        status: 'running',
        createdAt: 1000,
        lastActiveAt: 1000,
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(sessionData));

      const completed = store.markCompleted(
        'agent_complete',
        { success: true, message: 'Done!' },
        { duration: 1000, toolCalls: 5 }
      );

      expect(completed?.status).toBe('completed');
      expect(completed?.result?.success).toBe(true);
      expect(completed?.result?.message).toBe('Done!');
      expect(completed?.stats?.duration).toBe(1000);
      expect(completed?.stats?.toolCalls).toBe(5);
    });

    it('失败时应标记为 failed', () => {
      const sessionData: AgentSession = {
        id: 'agent_fail',
        subagentType: 'Explore',
        description: 'Fail test',
        prompt: 'Test',
        messages: [],
        status: 'running',
        createdAt: 1000,
        lastActiveAt: 1000,
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify(sessionData));

      const failed = store.markCompleted('agent_fail', {
        success: false,
        message: '',
        error: 'Something went wrong',
      });

      expect(failed?.status).toBe('failed');
      expect(failed?.result?.error).toBe('Something went wrong');
    });
  });

  describe('deleteSession', () => {
    it('应删除会话文件', () => {
      (fs.existsSync as any).mockReturnValue(true);

      const result = store.deleteSession('agent_delete');

      expect(result).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  describe('listSessions', () => {
    it('应列出所有会话', () => {
      const session1: AgentSession = {
        id: 'agent_1',
        subagentType: 'Explore',
        description: 'Task 1',
        prompt: 'Test 1',
        messages: [],
        status: 'completed',
        createdAt: 1000,
        lastActiveAt: 2000,
      };

      const session2: AgentSession = {
        id: 'agent_2',
        subagentType: 'Plan',
        description: 'Task 2',
        prompt: 'Test 2',
        messages: [],
        status: 'running',
        createdAt: 2000,
        lastActiveAt: 3000,
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readdirSync as any).mockReturnValue([
        'agent_1.json',
        'agent_2.json',
        'readme.txt',
      ]);
      (fs.readFileSync as any).mockImplementation((filePath: string) => {
        if (filePath.includes('agent_1')) return JSON.stringify(session1);
        if (filePath.includes('agent_2')) return JSON.stringify(session2);
        return '';
      });

      const sessions = store.listSessions();

      expect(sessions).toHaveLength(2);
      // 应按 lastActiveAt 倒序
      expect(sessions[0].id).toBe('agent_2');
      expect(sessions[1].id).toBe('agent_1');
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('应清理过期的已完成会话', () => {
      const oldSession: AgentSession = {
        id: 'agent_old',
        subagentType: 'Explore',
        description: 'Old task',
        prompt: 'Test',
        messages: [],
        status: 'completed',
        createdAt: 0,
        lastActiveAt: 0, // 很旧
      };

      const newSession: AgentSession = {
        id: 'agent_new',
        subagentType: 'Explore',
        description: 'New task',
        prompt: 'Test',
        messages: [],
        status: 'completed',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };

      const runningSession: AgentSession = {
        id: 'agent_running',
        subagentType: 'Explore',
        description: 'Running task',
        prompt: 'Test',
        messages: [],
        status: 'running',
        createdAt: 0,
        lastActiveAt: 0, // 旧但运行中
      };

      (fs.existsSync as any).mockReturnValue(true);
      (fs.readdirSync as any).mockReturnValue([
        'agent_old.json',
        'agent_new.json',
        'agent_running.json',
      ]);
      (fs.readFileSync as any).mockImplementation((filePath: string) => {
        if (filePath.includes('agent_old')) return JSON.stringify(oldSession);
        if (filePath.includes('agent_new')) return JSON.stringify(newSession);
        if (filePath.includes('agent_running')) return JSON.stringify(runningSession);
        return '';
      });

      const cleaned = store.cleanupExpiredSessions(1000); // 1 秒过期

      // 只应清理 old session（completed 且过期）
      // running 的不清理，new 的未过期
      expect(cleaned).toBe(1);
    });
  });
});
