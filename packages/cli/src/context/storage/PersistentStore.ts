import { nanoid } from 'nanoid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { JsonValue, MessageRole } from '../../store/types.js';
import type {
  ConversationContext,
  MessageInfo,
  PartInfo,
  SessionContext,
  SessionEvent,
  SessionInfo,
} from '../types.js';
import { JSONLStore } from './JSONLStore.js';
import {
  detectGitBranch,
  getProjectStoragePath,
  getSessionFilePath,
  listProjectDirectories,
} from './pathUtils.js';

/**
 * 持久化存储实现 - JSONL 格式
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

  private createEvent<T extends SessionEvent['type']>(
    type: T,
    sessionId: string,
    data: Extract<SessionEvent, { type: T }>['data']
  ): SessionEvent {
    return {
      id: nanoid(),
      sessionId,
      timestamp: new Date().toISOString(),
      type,
      cwd: this.projectPath,
      gitBranch: detectGitBranch(this.projectPath),
      version: this.version,
      data,
    } as SessionEvent;
  }

  private async ensureSessionCreated(
    sessionId: string,
    subagentInfo?: { parentSessionId: string; subagentType: string; isSidechain: boolean }
  ): Promise<void> {
    const filePath = getSessionFilePath(this.projectPath, sessionId);
    const store = new JSONLStore(filePath);
    const stats = await store.getStats();
    if (stats.lineCount > 0) return;
    const now = new Date().toISOString();
    const sessionInfo: SessionInfo = {
      sessionId,
      rootId: subagentInfo?.parentSessionId ?? sessionId,
      parentId: subagentInfo?.parentSessionId,
      relationType: subagentInfo ? 'subagent' : undefined,
      title: undefined,
      status: 'running',
      agentType: subagentInfo?.subagentType,
      model: undefined,
      permission: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const entry = this.createEvent('session_created', sessionId, sessionInfo);
    await store.append(entry);
  }

  private buildCompactionMetadata(metadata: {
    trigger: 'auto' | 'manual';
    preTokens: number;
    postTokens?: number;
    filesIncluded?: string[];
  }): JsonValue {
    const result: Record<string, JsonValue> = {
      trigger: metadata.trigger,
      preTokens: metadata.preTokens,
    };
    if (metadata.postTokens !== undefined) result.postTokens = metadata.postTokens;
    if (metadata.filesIncluded) result.filesIncluded = metadata.filesIncluded;
    return result;
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });
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
    messageRole: MessageRole,
    content: string,
    parentUuid: string | null = null,
    metadata?: {
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
    },
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    }
  ): Promise<string> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = nanoid();
      const messageInfo: MessageInfo = {
        messageId,
        role: messageRole,
        parentMessageId: parentUuid ?? undefined,
        createdAt: now,
        model: metadata?.model,
        usage: metadata?.usage,
      };
      const messageEntry = this.createEvent('message_created', sessionId, messageInfo);
      const partInfo: PartInfo = {
        partId: nanoid(),
        messageId,
        partType: 'text',
        payload: { text: content },
        createdAt: now,
      };
      const partEntry = this.createEvent('part_created', sessionId, partInfo);
      await store.appendBatch([messageEntry, partEntry]);
      return messageId;
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
    toolInput: JsonValue,
    parentUuid: string | null = null,
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    }
  ): Promise<string> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = parentUuid ?? nanoid();
      const entries: SessionEvent[] = [];
      if (!parentUuid) {
        const messageInfo: MessageInfo = {
          messageId,
          role: 'assistant',
          parentMessageId: undefined,
          createdAt: now,
        };
        entries.push(this.createEvent('message_created', sessionId, messageInfo));
      }
      const toolCallId = nanoid();
      const partInfo: PartInfo = {
        partId: toolCallId,
        messageId,
        partType: 'tool_call',
        payload: { toolCallId, toolName, input: toolInput },
        createdAt: now,
      };
      entries.push(this.createEvent('part_created', sessionId, partInfo));
      if (toolName === 'Task' && toolInput && typeof toolInput === 'object') {
        const subtaskInput = toolInput as Record<string, unknown>;
        const childSessionId =
          typeof subtaskInput.subagent_session_id === 'string'
            ? subtaskInput.subagent_session_id
            : undefined;
        const agentType =
          typeof subtaskInput.subagent_type === 'string'
            ? subtaskInput.subagent_type
            : undefined;
        if (childSessionId && agentType) {
          const subtaskPart: PartInfo = {
            partId: nanoid(),
            messageId,
            partType: 'subtask_ref',
            payload: {
              childSessionId,
              agentType,
              status: 'running',
              summary:
                typeof subtaskInput.description === 'string'
                  ? subtaskInput.description
                  : '',
              startedAt: now,
            },
            createdAt: now,
          };
          entries.push(this.createEvent('part_created', sessionId, subtaskPart));
        }
      }
      await store.appendBatch(entries);
      return toolCallId;
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
    toolName: string,
    toolOutput: JsonValue,
    parentUuid: string | null = null,
    error?: string,
    subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
    subagentRef?: {
      subagentSessionId: string;
      subagentType: string;
      subagentStatus: 'running' | 'completed' | 'failed' | 'cancelled';
      subagentSummary?: string;
    }
  ): Promise<string> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      await this.ensureSessionCreated(sessionId, subagentInfo);
      const now = new Date().toISOString();
      const messageId = parentUuid ?? nanoid();
      const entries: SessionEvent[] = [];
      if (!parentUuid) {
        const messageInfo: MessageInfo = {
          messageId,
          role: 'assistant',
          parentMessageId: undefined,
          createdAt: now,
        };
        entries.push(this.createEvent('message_created', sessionId, messageInfo));
      }
      const toolResultPart: PartInfo = {
        partId: toolId,
        messageId,
        partType: 'tool_result',
        payload: { toolCallId: toolId, toolName, output: toolOutput, error: error ?? null },
        createdAt: now,
      };
      entries.push(this.createEvent('part_created', sessionId, toolResultPart));
      if (subagentRef) {
        const finishedAt =
          subagentRef.subagentStatus === 'running' ? null : now;
        const subtaskPart: PartInfo = {
          partId: nanoid(),
          messageId,
          partType: 'subtask_ref',
          payload: {
            childSessionId: subagentRef.subagentSessionId,
            agentType: subagentRef.subagentType,
            status: subagentRef.subagentStatus,
            summary: subagentRef.subagentSummary ?? '',
            startedAt: now,
            finishedAt,
          },
          createdAt: now,
        };
        entries.push(this.createEvent('part_created', sessionId, subtaskPart));
      }
      await store.appendBatch(entries);
      return toolId;
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
      await this.ensureSessionCreated(sessionId);
      const now = new Date().toISOString();
      const messageId = nanoid();
      const messageInfo: MessageInfo = {
        messageId,
        role: 'system',
        parentMessageId: parentUuid ?? undefined,
        createdAt: now,
      };
      const compactMetadata = this.buildCompactionMetadata(metadata);
      const partInfo: PartInfo = {
        partId: nanoid(),
        messageId,
        partType: 'summary',
        payload: { text: summary, metadata: compactMetadata },
        createdAt: now,
      };
      const entries = [
        this.createEvent('message_created', sessionId, messageInfo),
        this.createEvent('part_created', sessionId, partInfo),
      ];
      await store.appendBatch(entries);
      return messageId;
    } catch (error) {
      console.error(`[PersistentStore] 保存压缩失败 (session: ${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * 保存会话初始化事件到 JSONL
   * 仅创建 session_created 事件，不写入空消息
   */
  async initSession(sessionId: string): Promise<void> {
    await this.ensureSessionCreated(sessionId);
  }

  /**
   * 加载会话的原始 JSONL 事件流
   */
  async loadEvents(sessionId: string): Promise<SessionEvent[] | null> {
    try {
      const filePath = getSessionFilePath(this.projectPath, sessionId);
      const store = new JSONLStore(filePath);
      const entries = await store.readAll();
      return entries.length > 0 ? entries : null;
    } catch {
      return null;
    }
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
      const firstEntry = entries.find((entry) => entry.type === 'session_created');

      return {
        sessionId,
        userId: undefined,
        preferences: {},
        configuration: {},
        startTime: new Date(firstEntry?.timestamp ?? entries[0].timestamp).getTime(),
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
      const messageMap = new Map<string, { id: string; role: MessageRole; content: string; timestamp: number }>();
      for (const entry of entries) {
        if (entry.type === 'message_created') {
          messageMap.set(entry.data.messageId, {
            id: entry.data.messageId,
            role: entry.data.role,
            content: '',
            timestamp: new Date(entry.timestamp).getTime(),
          });
        }
        if (entry.type === 'part_created' && entry.data.partType === 'text') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const payload = entry.data.payload as { text?: string };
            message.content = payload.text ?? '';
          }
        }
      }
      const messages = Array.from(messageMap.values());
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
      const messageCount = entries.filter(
        (entry) => entry.type === 'message_created' && ['user', 'assistant'].includes(entry.data.role)
      ).length;

      return {
        sessionId,
        lastActivity: new Date(lastEntry.timestamp).getTime(),
        messageCount,
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
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });

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
