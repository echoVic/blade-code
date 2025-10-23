import { nanoid } from 'nanoid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  BladeJSONLEntry,
  ContextData,
  ConversationContext,
  SessionContext,
} from '../types.js';
import {
  detectGitBranch,
  getProjectStoragePath,
  getSessionFilePath,
  listProjectDirectories,
} from '../utils/pathEscape.js';
import { JSONLStore } from './JSONLStore.js';

/**
 * 持久化存储实现 - JSONL 格式，类似 Claude Code
 * 存储路径: ~/.blade/projects/{escaped-path}/{sessionId}.jsonl
 */
export class PersistentStore {
  private readonly projectPath: string;
  private readonly maxSessions: number;
  private readonly version: string;

  constructor(
    projectPath: string = process.cwd(),
    maxSessions: number = 100,
    version: string = '0.0.10'
  ) {
    this.projectPath = projectPath;
    this.maxSessions = maxSessions;
    this.version = version;
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);
      await fs.mkdir(storagePath, { recursive: true });
      console.log(`[PersistentStore] 初始化存储目录: ${storagePath}`);
    } catch (error) {
      console.warn('[PersistentStore] 无法创建持久化存储目录:', error);
    }
  }

  /**
   * 保存消息到 JSONL 文件（追加模式）
   */
  async saveMessage(
    sessionId: string,
    messageRole: 'user' | 'assistant' | 'system',
    content: string,
    parentUuid: string | null = null,
    metadata?: {
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
    }
  ): Promise<string> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const entry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid,
        sessionId,
        timestamp: new Date().toISOString(),
        type:
          messageRole === 'user'
            ? 'user'
            : messageRole === 'assistant'
              ? 'assistant'
              : 'system',
        cwd: this.projectPath,
        gitBranch: detectGitBranch(this.projectPath),
        version: this.version,
        message: {
          role: messageRole,
          content,
          ...(metadata || {}),
        },
      };

      await store.append(entry);
      return entry.uuid;
    } catch (error) {
      console.error(`[PersistentStore] 保存消息失败 (session: ${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * 保存工具调用到 JSONL 文件
   */
  async saveToolUse(
    sessionId: string,
    toolName: string,
    toolInput: any,
    parentUuid: string | null = null
  ): Promise<string> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const entry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_use',
        cwd: this.projectPath,
        gitBranch: detectGitBranch(this.projectPath),
        version: this.version,
        message: {
          role: 'assistant',
          content: '',
        },
        tool: {
          id: nanoid(),
          name: toolName,
          input: toolInput,
        },
      };

      await store.append(entry);
      return entry.uuid;
    } catch (error) {
      console.error(
        `[PersistentStore] 保存工具调用失败 (session: ${sessionId}):`,
        error
      );
      throw error;
    }
  }

  /**
   * 保存工具结果到 JSONL 文件
   */
  async saveToolResult(
    sessionId: string,
    toolId: string,
    toolOutput: any,
    parentUuid: string | null = null,
    error?: string
  ): Promise<string> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const entry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: this.projectPath,
        gitBranch: detectGitBranch(this.projectPath),
        version: this.version,
        message: {
          role: 'assistant',
          content: '',
        },
        toolResult: {
          id: toolId,
          output: toolOutput,
          error,
        },
      };

      await store.append(entry);
      return entry.uuid;
    } catch (error) {
      console.error(
        `[PersistentStore] 保存工具结果失败 (session: ${sessionId}):`,
        error
      );
      throw error;
    }
  }

  /**
   * 保存压缩边界和总结消息到 JSONL
   * 用于上下文压缩功能
   *
   * @param sessionId 会话 ID
   * @param summary 压缩总结内容
   * @param metadata 压缩元数据（触发方式、token 数量、包含的文件等）
   * @param parentUuid 最后一条保留消息的 UUID（用于建立消息链）
   * @returns 总结消息的 UUID
   */
  async saveCompaction(
    sessionId: string,
    summary: string,
    metadata: {
      trigger: 'auto' | 'manual';
      preTokens: number;
      postTokens?: number;
      filesIncluded?: string[];
    },
    parentUuid: string | null = null
  ): Promise<string> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      // 1. 保存压缩边界标记（compact_boundary）
      const boundaryEntry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'compact_boundary',
        cwd: this.projectPath,
        gitBranch: detectGitBranch(this.projectPath),
        version: this.version,
        message: {
          role: 'system',
          content: '=== 上下文压缩边界 ===',
        },
        compactMetadata: metadata,
      };

      await store.append(boundaryEntry);
      console.log('[PersistentStore] 保存压缩边界标记');

      // 2. 保存压缩总结消息（isCompactSummary: true）
      const summaryEntry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid: boundaryEntry.uuid, // 链接到边界消息
        logicalParentUuid: parentUuid ?? undefined, // 逻辑上链接到最后一条保留消息
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
        isCompactSummary: true,
        cwd: this.projectPath,
        gitBranch: detectGitBranch(this.projectPath),
        version: this.version,
        message: {
          role: 'user',
          content: summary,
        },
        compactMetadata: metadata,
      };

      await store.append(summaryEntry);
      console.log('[PersistentStore] 保存压缩总结消息');

      return summaryEntry.uuid;
    } catch (error) {
      console.error(`[PersistentStore] 保存压缩失败 (session: ${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * 保存完整上下文数据（向后兼容方法）
   * 将 ContextData 转为 JSONL 格式保存
   */
  async saveContext(sessionId: string, contextData: ContextData): Promise<void> {
    try {
      const { conversation } = contextData.layers;

      // 将每条消息转为 JSONL 条目并批量保存
      for (const msg of conversation.messages) {
        await this.saveMessage(
          sessionId,
          msg.role as 'user' | 'assistant' | 'system',
          msg.content,
          null
        );
      }
    } catch (error) {
      console.warn(`[PersistentStore] 保存上下文失败 (session: ${sessionId}):`, error);
    }
  }

  /**
   * 保存会话上下文（向后兼容方法 - 已废弃）
   */
  async saveSession(sessionId: string, sessionContext: SessionContext): Promise<void> {
    // JSONL 格式中会话元数据已包含在每条消息中，此方法为空实现
    console.warn('[PersistentStore] saveSession 方法已废弃，请使用 saveMessage');
  }

  /**
   * 保存对话上下文（向后兼容方法 - 已废弃）
   */
  async saveConversation(
    sessionId: string,
    conversation: ConversationContext
  ): Promise<void> {
    // JSONL 格式中对话已包含在消息流中，此方法为空实现
    console.warn('[PersistentStore] saveConversation 方法已废弃，请使用 saveMessage');
  }

  /**
   * 加载会话上下文（从 JSONL 重建）
   */
  async loadSession(sessionId: string): Promise<SessionContext | null> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const entries = await store.readAll();
      if (entries.length === 0) return null;

      // 从第一条消息提取会话信息
      const firstEntry = entries[0];

      return {
        sessionId,
        userId: undefined,
        preferences: {},
        configuration: {},
        startTime: new Date(firstEntry.timestamp).getTime(),
      };
    } catch {
      return null;
    }
  }

  /**
   * 加载对话上下文（从 JSONL 重建）
   */
  async loadConversation(sessionId: string): Promise<ConversationContext | null> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const entries = await store.readAll();
      if (entries.length === 0) return null;

      // 提取所有消息
      const messages = entries
        .filter((entry) => ['user', 'assistant', 'system'].includes(entry.type))
        .map((entry) => ({
          id: entry.uuid,
          role: entry.message.role,
          content: entry.message.content as string,
          timestamp: new Date(entry.timestamp).getTime(),
        }));

      // 获取最后活动时间
      const lastEntry = entries[entries.length - 1];
      const lastActivity = new Date(lastEntry.timestamp).getTime();

      return {
        messages,
        topics: [],
        lastActivity,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取所有会话列表
   */
  async listSessions(): Promise<string[]> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);
      const files = await fs.readdir(storagePath);
      return files
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => file.replace('.jsonl', ''))
        .sort();
    } catch {
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
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);

      const stats = await store.getStats();
      if (!stats.exists) return null;

      const entries = await store.readAll();
      if (entries.length === 0) return null;

      const lastEntry = entries[entries.length - 1];

      return {
        sessionId,
        lastActivity: new Date(lastEntry.timestamp).getTime(),
        messageCount: entries.filter((e) => ['user', 'assistant'].includes(e.type))
          .length,
        topics: [],
      };
    } catch {
      return null;
    }
  }

  /**
   * 删除会话数据
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      await store.delete();
    } catch (error) {
      console.warn(`[PersistentStore] 删除会话失败 (session: ${sessionId}):`, error);
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

      console.log(`[PersistentStore] 已清理 ${sessionsToDelete.length} 个旧会话`);
    } catch (error) {
      console.error('[PersistentStore] 清理旧会话失败:', error);
    }
  }

  /**
   * 获取存储统计信息
   */
  async getStorageStats(): Promise<{
    totalSessions: number;
    totalSize: number;
    projectPath: string;
  }> {
    try {
      const sessions = await this.listSessions();
      let totalSize = 0;

      for (const sessionId of sessions) {
        const filePath = getSessionFilePath(this.projectPath, sessionId);
        const store = new JSONLStore(filePath);
        const stats = await store.getStats();
        totalSize += stats.size;
      }

      return {
        totalSessions: sessions.length,
        totalSize,
        projectPath: this.projectPath,
      };
    } catch {
      return {
        totalSessions: 0,
        totalSize: 0,
        projectPath: this.projectPath,
      };
    }
  }

  /**
   * 检查存储健康状态
   */
  async checkStorageHealth(): Promise<{
    isAvailable: boolean;
    canWrite: boolean;
    error?: string;
  }> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);

      // 尝试创建目录
      await fs.mkdir(storagePath, { recursive: true });

      // 尝试写入测试文件
      const testFile = path.join(storagePath, '.health-check');
      await fs.writeFile(testFile, 'test', 'utf-8');
      await fs.unlink(testFile);

      return {
        isAvailable: true,
        canWrite: true,
      };
    } catch (error) {
      return {
        isAvailable: false,
        canWrite: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 获取所有项目列表
   */
  static async listAllProjects(): Promise<string[]> {
    return listProjectDirectories();
  }
}
