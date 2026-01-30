/**
 * Agent 会话持久化存储
 *
 * 用于支持 Task 工具的 resume 功能：
 * - 保存 agent 执行上下文到文件
 * - 支持跨会话恢复 agent
 * - 自动清理过期会话
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { Message } from '../../services/ChatServiceInterface.js';

const logger = createLogger(LogCategory.AGENT);

/**
 * Agent 会话状态
 */
export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Agent 会话数据
 */
export interface AgentSession {
  /** 会话 ID (agent_{uuid}) */
  id: string;

  /** Subagent 类型 */
  subagentType: string;

  /** 任务描述 */
  description: string;

  /** 原始 prompt */
  prompt: string;

  /** 会话消息历史 */
  messages: Message[];

  /** 会话状态 */
  status: AgentSessionStatus;

  /** 最终结果（如果已完成） */
  result?: {
    success: boolean;
    message: string;
    error?: string;
  };

  /** 执行统计 */
  stats?: {
    tokens?: number;
    toolCalls?: number;
    duration?: number;
  };

  /** 创建时间 */
  createdAt: number;

  /** 最后活跃时间 */
  lastActiveAt: number;

  /** 完成时间（如果已完成） */
  completedAt?: number;

  /** 父会话 ID（可选） */
  parentSessionId?: string;
}

/**
 * Agent 会话存储管理器
 *
 * 存储位置: ~/.blade/agents/sessions/{agent_id}.json
 */
export class AgentSessionStore {
  private static instance: AgentSessionStore | null = null;
  private sessionsDir: string;

  // 内存缓存（避免频繁读取文件）
  private cache = new Map<string, AgentSession>();

  private constructor() {
    this.sessionsDir = path.join(os.homedir(), '.blade', 'agents', 'sessions');
    this.ensureDirectory();
  }

  static getInstance(): AgentSessionStore {
    if (!AgentSessionStore.instance) {
      AgentSessionStore.instance = new AgentSessionStore();
    }
    return AgentSessionStore.instance;
  }

  /**
   * 确保存储目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o755 });
    }
  }

  /**
   * 获取会话文件路径
   */
  private getSessionPath(agentId: string): string {
    // 安全处理 ID，避免路径遍历
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  /**
   * 保存会话
   */
  saveSession(session: AgentSession): void {
    try {
      const filePath = this.getSessionPath(session.id);
      const data = JSON.stringify(session, null, 2);
      fs.writeFileSync(filePath, data, 'utf-8');

      // 更新缓存
      this.cache.set(session.id, session);

      logger.debug(`Session saved: ${session.id}`);
    } catch (error) {
      logger.warn(`Failed to save session ${session.id}:`, error);
    }
  }

  /**
   * 加载会话
   */
  loadSession(agentId: string): AgentSession | undefined {
    // 先检查缓存
    if (this.cache.has(agentId)) {
      return this.cache.get(agentId);
    }

    try {
      const filePath = this.getSessionPath(agentId);
      if (!fs.existsSync(filePath)) {
        return undefined;
      }

      const data = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(data) as AgentSession;

      // 更新缓存
      this.cache.set(agentId, session);

      return session;
    } catch (error) {
      logger.warn(`Failed to load session ${agentId}:`, error);
      return undefined;
    }
  }

  /**
   * 更新会话状态
   */
  updateSession(
    agentId: string,
    updates: Partial<AgentSession>
  ): AgentSession | undefined {
    const session = this.loadSession(agentId);
    if (!session) {
      return undefined;
    }

    const updatedSession: AgentSession = {
      ...session,
      ...updates,
      lastActiveAt: Date.now(),
    };

    this.saveSession(updatedSession);
    return updatedSession;
  }

  /**
   * 追加消息到会话
   */
  appendMessages(agentId: string, messages: Message[]): AgentSession | undefined {
    const session = this.loadSession(agentId);
    if (!session) {
      return undefined;
    }

    return this.updateSession(agentId, {
      messages: [...session.messages, ...messages],
    });
  }

  /**
   * 标记会话完成
   */
  markCompleted(
    agentId: string,
    result: { success: boolean; message: string; error?: string },
    stats?: AgentSession['stats']
  ): AgentSession | undefined {
    return this.updateSession(agentId, {
      status: result.success ? 'completed' : 'failed',
      result,
      stats,
      completedAt: Date.now(),
    });
  }

  /**
   * 删除会话
   */
  deleteSession(agentId: string): boolean {
    try {
      const filePath = this.getSessionPath(agentId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.cache.delete(agentId);
      return true;
    } catch (error) {
      logger.warn(`Failed to delete session ${agentId}:`, error);
      return false;
    }
  }

  /**
   * 列出所有会话
   */
  listSessions(): AgentSession[] {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessions: AgentSession[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const agentId = file.replace('.json', '');
        const session = this.loadSession(agentId);
        if (session) {
          sessions.push(session);
        }
      }

      // 按最后活跃时间倒序
      return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch (error) {
      logger.warn('Failed to list sessions:', error);
      return [];
    }
  }

  /**
   * 列出运行中的会话
   */
  listRunningSessions(): AgentSession[] {
    return this.listSessions().filter((s) => s.status === 'running');
  }

  /**
   * 清理过期会话
   * @param maxAgeMs 最大保留时间（毫秒），默认 7 天
   */
  cleanupExpiredSessions(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    const sessions = this.listSessions();
    let cleaned = 0;

    for (const session of sessions) {
      // 只清理已完成的会话
      if (session.status === 'running') continue;

      const age = now - session.lastActiveAt;
      if (age > maxAgeMs) {
        if (this.deleteSession(session.id)) {
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired agent sessions`);
    }

    return cleaned;
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}
