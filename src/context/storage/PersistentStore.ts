import * as fs from 'fs/promises';
import * as path from 'path';
import { ContextData, ConversationContext, SessionContext } from '../types.js';

/**
 * 持久化存储实现 - 用于跨会话的数据持久化
 */
export class PersistentStore {
  private readonly storagePath: string;
  private readonly maxSessions: number;

  constructor(storagePath: string = './blade-context', maxSessions: number = 100) {
    this.storagePath = storagePath;
    this.maxSessions = maxSessions;
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.storagePath, { recursive: true });
      await fs.mkdir(path.join(this.storagePath, 'sessions'), { recursive: true });
      await fs.mkdir(path.join(this.storagePath, 'conversations'), { recursive: true });
    } catch (error) {
      console.warn('警告：无法创建持久化存储目录:', error);
    }
  }

  /**
   * 保存会话上下文
   */
  async saveSession(sessionId: string, sessionContext: SessionContext): Promise<void> {
    try {
      const sessionPath = path.join(this.storagePath, 'sessions', `${sessionId}.json`);
      const data = {
        ...sessionContext,
        lastSaved: Date.now(),
      };
      await fs.writeFile(sessionPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.warn(`警告：无法保存会话 ${sessionId}:`, error);
    }
  }

  /**
   * 加载会话上下文
   */
  async loadSession(sessionId: string): Promise<SessionContext | null> {
    try {
      const sessionPath = path.join(this.storagePath, 'sessions', `${sessionId}.json`);
      const data = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(data) as SessionContext;
    } catch (_error) {
      return null;
    }
  }

  /**
   * 保存对话上下文
   */
  async saveConversation(
    sessionId: string,
    conversation: ConversationContext
  ): Promise<void> {
    try {
      const conversationPath = path.join(
        this.storagePath,
        'conversations',
        `${sessionId}.json`
      );
      const data = {
        ...conversation,
        lastSaved: Date.now(),
      };
      await fs.writeFile(conversationPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.warn(`警告：无法保存对话 ${sessionId}:`, error);
    }
  }

  /**
   * 加载对话上下文
   */
  async loadConversation(sessionId: string): Promise<ConversationContext | null> {
    try {
      const conversationPath = path.join(
        this.storagePath,
        'conversations',
        `${sessionId}.json`
      );
      const data = await fs.readFile(conversationPath, 'utf-8');
      return JSON.parse(data) as ConversationContext;
    } catch (_error) {
      return null;
    }
  }

  /**
   * 保存完整上下文数据
   */
  async saveContext(sessionId: string, contextData: ContextData): Promise<void> {
    await Promise.all([
      this.saveSession(sessionId, contextData.layers.session),
      this.saveConversation(sessionId, contextData.layers.conversation),
    ]);
  }

  /**
   * 获取所有会话列表
   */
  async listSessions(): Promise<string[]> {
    try {
      const sessionsDir = path.join(this.storagePath, 'sessions');
      const files = await fs.readdir(sessionsDir);
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace('.json', ''))
        .sort();
    } catch (_error) {
      return [];
    }
  }

  /**
   * 获取会话摘要信息
   */
  async getSessionSummary(sessionId: string): Promise<{
    sessionId: string;
    lastActivity: number;
    messageCount: number;
    topics: string[];
  } | null> {
    try {
      const [session, conversation] = await Promise.all([
        this.loadSession(sessionId),
        this.loadConversation(sessionId),
      ]);

      if (!session || !conversation) {
        return null;
      }

      return {
        sessionId,
        lastActivity: conversation.lastActivity,
        messageCount: conversation.messages.length,
        topics: conversation.topics || [],
      };
    } catch (_error) {
      return null;
    }
  }

  /**
   * 删除会话数据
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const sessionPath = path.join(this.storagePath, 'sessions', `${sessionId}.json`);
      const conversationPath = path.join(
        this.storagePath,
        'conversations',
        `${sessionId}.json`
      );

      await Promise.all([
        fs.unlink(sessionPath).catch(() => {}),
        fs.unlink(conversationPath).catch(() => {}),
      ]);
    } catch (error) {
      console.warn(`警告：无法删除会话 ${sessionId}:`, error);
    }
  }

  /**
   * 清理旧会话（保持最近的N个会话）
   */
  async cleanupOldSessions(): Promise<void> {
    try {
      const sessions = await this.listSessions();
      if (sessions.length <= this.maxSessions) {
        return;
      }

      // 获取所有会话的摘要信息并按时间排序
      const sessionSummaries = await Promise.all(
        sessions.map((sessionId) => this.getSessionSummary(sessionId))
      );

      const validSummaries = sessionSummaries
        .filter((summary): summary is NonNullable<typeof summary> => summary !== null)
        .sort((a, b) => b.lastActivity - a.lastActivity);

      // 删除最旧的会话
      const sessionsToDelete = validSummaries
        .slice(this.maxSessions)
        .map((summary) => summary.sessionId);

      await Promise.all(
        sessionsToDelete.map((sessionId) => this.deleteSession(sessionId))
      );

      if (sessionsToDelete.length > 0) {
        console.log(`清理了 ${sessionsToDelete.length} 个旧会话`);
      }
    } catch (error) {
      console.warn('警告：清理旧会话时出错:', error);
    }
  }

  /**
   * 获取存储统计信息
   */
  async getStorageStats(): Promise<{
    totalSessions: number;
    totalSize: number; // 字节
    oldestSession: string | null;
    newestSession: string | null;
  }> {
    try {
      const sessions = await this.listSessions();

      if (sessions.length === 0) {
        return {
          totalSessions: 0,
          totalSize: 0,
          oldestSession: null,
          newestSession: null,
        };
      }

      // 计算总大小
      let totalSize = 0;
      for (const sessionId of sessions) {
        try {
          const sessionPath = path.join(
            this.storagePath,
            'sessions',
            `${sessionId}.json`
          );
          const conversationPath = path.join(
            this.storagePath,
            'conversations',
            `${sessionId}.json`
          );

          const [sessionStat, conversationStat] = await Promise.all([
            fs.stat(sessionPath).catch(() => ({ size: 0 })),
            fs.stat(conversationPath).catch(() => ({ size: 0 })),
          ]);

          totalSize += sessionStat.size + conversationStat.size;
        } catch (_error) {
          // 忽略单个文件的错误
        }
      }

      // 获取最新和最旧的会话
      const sessionSummaries = await Promise.all(
        sessions.map((sessionId) => this.getSessionSummary(sessionId))
      );

      const validSummaries = sessionSummaries
        .filter((summary): summary is NonNullable<typeof summary> => summary !== null)
        .sort((a, b) => a.lastActivity - b.lastActivity);

      return {
        totalSessions: sessions.length,
        totalSize,
        oldestSession: validSummaries[0]?.sessionId || null,
        newestSession: validSummaries[validSummaries.length - 1]?.sessionId || null,
      };
    } catch (error) {
      console.warn('警告：获取存储统计信息时出错:', error);
      return {
        totalSessions: 0,
        totalSize: 0,
        oldestSession: null,
        newestSession: null,
      };
    }
  }

  /**
   * 检查存储目录是否可用
   */
  async checkStorageHealth(): Promise<{
    isAvailable: boolean;
    canRead: boolean;
    canWrite: boolean;
    error?: string;
  }> {
    try {
      // 检查目录是否存在和可访问
      await fs.access(this.storagePath);

      // 测试写入权限
      const testFile = path.join(this.storagePath, '.test');
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);

      return {
        isAvailable: true,
        canRead: true,
        canWrite: true,
      };
    } catch (error) {
      return {
        isAvailable: false,
        canRead: false,
        canWrite: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
