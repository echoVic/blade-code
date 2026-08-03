/**
 * 会话管理服务
 * 负责加载和恢复历史会话
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { JSONLStore, parseSessionJSONL } from '../context/storage/JSONLStore.js';
import {
  detectGitBranch,
  getBladeStorageRoot,
  getSessionFilePath,
  unescapeProjectPath,
} from '../context/storage/pathUtils.js';
import type { SessionEvent } from '../context/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { JsonValue, SessionMessage } from '../store/types.js';
import { getVersion } from '../utils/packageInfo.js';
import type { ContentPart, Message } from './ChatServiceInterface.js';

const logger = createLogger(LogCategory.SERVICE);

/**
 * 会话元数据
 */
export interface SessionMetadata {
  sessionId: string;
  projectPath: string;
  gitBranch?: string;
  parentId?: string;
  relationType?: 'subagent' | 'fork';
  status?: 'running' | 'completed' | 'failed';
  agentType?: string;
  model?: string;
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
  filePath: string; // JSONL 文件路径
}

export interface ForkSessionOptions {
  newSessionId?: string;
  sourceProjectPath?: string;
  targetProjectPath: string;
}

export interface ForkedSession {
  sessionId: string;
  parentSessionId: string;
  projectPath: string;
  messages: Message[];
}

/**
 * 会话管理服务
 */
export class SessionService {
  /**
   * 将加载到的会话消息转换为 UI 安全的 SessionMessage。
   * 过滤掉 tool / system 等内部消息，仅从 ContentPart[] 中提取文本，
   * 避免把 </functions>、工具调用 JSON、summary 等内部内容泄露给用户或污染历史。
   */
  static toUISafeMessages(messages: Message[]): SessionMessage[] {
    const now = Date.now();
    const total = messages.length;
    const result: SessionMessage[] = [];

    messages.forEach((msg, index) => {
      if (msg.role !== 'user' && msg.role !== 'assistant') return;

      let content: string;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = (msg.content as ContentPart[])
          .map((part) => (part.type === 'text' ? part.text : '[Image]'))
          .join('');
      } else {
        content = '';
      }

      const normalizedContent = content.trim();
      if (!normalizedContent) return;

      const previous = result[result.length - 1];
      if (
        previous &&
        previous.role === msg.role &&
        previous.content === normalizedContent
      ) {
        return;
      }

      result.push({
        id: `restored-${now}-${index}`,
        role: msg.role,
        content: normalizedContent,
        timestamp: now - (total - index) * 1000,
        metadata:
          msg.metadata && typeof msg.metadata === 'object'
            ? (msg.metadata as Record<string, unknown>)
            : undefined,
      });
    });

    return result;
  }

  /**
   * 列出所有可用会话
   * 扫描 ~/.blade/projects/ 目录下的所有 JSONL 文件
   */
  static async listSessions(): Promise<SessionMetadata[]> {
    const sessions: SessionMetadata[] = [];
    const projectsDir = path.join(getBladeStorageRoot(), 'projects');

    try {
      // 读取所有项目目录
      const projectDirs = await readdir(projectsDir, { withFileTypes: true });

      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;

        const projectDirPath = path.join(projectsDir, dir.name);
        const projectPath = unescapeProjectPath(dir.name);

        // 读取项目目录下的所有 JSONL 文件
        const files = await readdir(projectDirPath);
        const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

        for (const file of jsonlFiles) {
          const filePath = path.join(projectDirPath, file);
          const sessionId = file.replace('.jsonl', '');

          try {
            const metadata = await this.extractMetadata(
              filePath,
              sessionId,
              projectPath
            );
            sessions.push(metadata);
          } catch (error) {
            logger.warn(`[SessionService] 跳过损坏的会话文件: ${filePath}`, error);
          }
        }
      }

      // 按最后消息时间降序排序
      sessions.sort(
        (a, b) =>
          new Date(b.lastMessageTime).getTime() - new Date(a.lastMessageTime).getTime()
      );

      return sessions;
    } catch (error) {
      logger.error('[SessionService] 列出会话失败:', error);
      return [];
    }
  }

  /**
   * 从 JSONL 文件提取元数据（只读取必要信息）
   */
  private static async extractMetadata(
    filePath: string,
    sessionId: string,
    projectPath: string
  ): Promise<SessionMetadata> {
    const content = await readFile(filePath, 'utf-8');
    const entries = parseSessionJSONL(content, filePath);

    if (entries.length === 0) {
      throw new Error('空的 JSONL 文件');
    }
    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];
    const sessionCreated = entries.find((entry) => entry.type === 'session_created');

    const messageCount = entries.filter(
      (entry) =>
        entry.type === 'message_created' &&
        ['user', 'assistant'].includes(entry.data.role)
    ).length;
    const hasErrors = entries.some(
      (entry) =>
        entry.type === 'part_created' &&
        entry.data.partType === 'tool_result' &&
        typeof (entry.data.payload as { error?: unknown }).error === 'string'
    );

    return {
      sessionId,
      projectPath,
      gitBranch: sessionCreated?.gitBranch ?? firstEntry.gitBranch,
      parentId: sessionCreated?.data.parentId,
      relationType: sessionCreated?.data.relationType,
      status: sessionCreated?.data.status,
      agentType: sessionCreated?.data.agentType,
      model: sessionCreated?.data.model,
      messageCount,
      firstMessageTime: firstEntry.timestamp,
      lastMessageTime: lastEntry.timestamp,
      hasErrors,
      filePath,
    };
  }

  /**
   * 加载指定会话的消息历史
   * @param sessionId 会话 ID
   * @param projectPath 项目路径（可选，如果不提供则搜索所有项目）
   */
  static async loadSession(
    sessionId: string,
    projectPath?: string
  ): Promise<Message[]> {
    try {
      // 如果提供了项目路径，直接查找
      if (projectPath) {
        const filePath = this.getSessionFilePath(projectPath, sessionId);
        return await this.loadSessionFromFile(filePath);
      }

      // 否则搜索所有项目
      const sessions = await this.listSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);

      if (!session) {
        throw new Error(`未找到会话: ${sessionId}`);
      }

      return await this.loadSessionFromFile(session.filePath);
    } catch (error) {
      logger.error(`[SessionService] 加载会话失败 (${sessionId}):`, error);
      throw error;
    }
  }

  /**
   * Fork committed history into a new transcript without mutating the source.
   * Exclusive creation makes an explicit target ID collision fail closed.
   */
  static async forkSession(
    sourceSessionId: string,
    options: ForkSessionOptions
  ): Promise<ForkedSession> {
    const targetSessionId = options.newSessionId ?? `fork-${Date.now()}-${nanoid(8)}`;
    this.assertValidForkSessionId(targetSessionId);

    const sourceFilePath = options.sourceProjectPath
      ? getSessionFilePath(options.sourceProjectPath, sourceSessionId)
      : (await this.listSessions()).find(
          (session) => session.sessionId === sourceSessionId
        )?.filePath;
    if (!sourceFilePath) {
      throw new Error(`未找到会话: ${sourceSessionId}`);
    }

    const sourceContent = await readFile(sourceFilePath, 'utf-8');
    const sourceEntries = parseSessionJSONL(sourceContent, sourceFilePath);
    const sourceCreated = sourceEntries.find(
      (entry): entry is Extract<SessionEvent, { type: 'session_created' }> =>
        entry.type === 'session_created'
    );
    if (!sourceCreated) {
      throw new Error(
        `Cannot fork session without session_created: ${sourceSessionId}`
      );
    }

    const now = new Date().toISOString();
    const rootId = sourceCreated.data.rootId || sourceSessionId;
    const gitBranch = detectGitBranch(options.targetProjectPath);
    const version = getVersion();
    const childCreated: Extract<SessionEvent, { type: 'session_created' }> = {
      id: nanoid(),
      sessionId: targetSessionId,
      timestamp: now,
      type: 'session_created',
      cwd: options.targetProjectPath,
      gitBranch,
      version,
      data: {
        ...sourceCreated.data,
        sessionId: targetSessionId,
        rootId,
        parentId: sourceSessionId,
        relationType: 'fork',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      },
    };
    const copiedEntries = sourceEntries
      .filter((entry) => entry.type !== 'session_created')
      .map((entry): SessionEvent => {
        const base = {
          ...entry,
          id: nanoid(),
          sessionId: targetSessionId,
          cwd: options.targetProjectPath,
          gitBranch,
          version,
        };
        if (entry.type === 'session_updated') {
          return {
            ...base,
            type: 'session_updated',
            data: {
              ...entry.data,
              sessionId: targetSessionId,
              rootId,
              parentId: sourceSessionId,
              relationType: 'fork',
            },
          };
        }
        return base as SessionEvent;
      });
    const forkBoundary: Extract<SessionEvent, { type: 'session_updated' }> = {
      id: nanoid(),
      sessionId: targetSessionId,
      timestamp: now,
      type: 'session_updated',
      cwd: options.targetProjectPath,
      gitBranch,
      version,
      data: {
        sessionId: targetSessionId,
        rootId,
        parentId: sourceSessionId,
        relationType: 'fork',
        status: 'running',
        updatedAt: now,
      },
    };
    const childEntries: SessionEvent[] = [childCreated, ...copiedEntries, forkBoundary];
    const targetFilePath = getSessionFilePath(
      options.targetProjectPath,
      targetSessionId
    );

    try {
      await new JSONLStore(targetFilePath).createExclusive(childEntries);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        throw new Error(`Fork session already exists: ${targetSessionId}`, {
          cause: error,
        });
      }
      throw error;
    }

    return {
      sessionId: targetSessionId,
      parentSessionId: sourceSessionId,
      projectPath: options.targetProjectPath,
      messages: this.convertJSONLToMessages(childEntries),
    };
  }

  static async deleteSession(sessionId: string): Promise<number> {
    const sessions = await this.listSessions();
    const matches = sessions.filter((s) => s.sessionId === sessionId);
    if (matches.length === 0) return 0;
    await Promise.all(matches.map((s) => rm(s.filePath, { force: true })));
    return matches.length;
  }

  /**
   * 从 JSONL 文件加载并转换消息
   */
  private static async loadSessionFromFile(filePath: string): Promise<Message[]> {
    const content = await readFile(filePath, 'utf-8');
    const entries = parseSessionJSONL(content, filePath);
    return this.convertJSONLToMessages(entries);
  }

  /**
   * 将 JSONL 条目转换为 OpenAI Message 格式
   */
  static convertJSONLToMessages(entries: SessionEvent[]): Message[] {
    const messages: Message[] = [];
    const messageMap = new Map<string, Message>();
    const partMap = new Map<string, ContentPart[]>();
    const recoveredToolAssistants = new Map<string, Message>();
    const toolCallIdByPartId = new Map<string, string>();
    for (const entry of entries) {
      if (entry.type === 'message_created') {
        const recoveredAssistant =
          entry.data.role === 'assistant' && entry.data.parentMessageId
            ? recoveredToolAssistants.get(entry.data.parentMessageId)
            : undefined;
        const message: Message = recoveredAssistant ?? {
          role: entry.data.role,
          content: '',
        };
        messageMap.set(entry.data.messageId, message);
        partMap.set(entry.data.messageId, []);
        if (!recoveredAssistant) {
          messages.push(message);
        }
      }
      if (entry.type === 'part_created') {
        if (entry.data.partType === 'text') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const payload = entry.data.payload as { text?: string };
            const parts = partMap.get(entry.data.messageId);
            if (parts) {
              parts.push({ type: 'text', text: payload.text ?? '' });
              message.content = toMessageContent(parts);
            } else {
              message.content = payload.text ?? '';
            }
          }
        }
        if (entry.data.partType === 'image') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const payload = entry.data.payload as { dataUrl?: string };
            const parts = partMap.get(entry.data.messageId);
            if (parts && payload.dataUrl) {
              parts.push({ type: 'image_url', image_url: { url: payload.dataUrl } });
              message.content = toMessageContent(parts);
            }
          }
        }
        if (entry.data.partType === 'tool_call') {
          let message = messageMap.get(entry.data.messageId);
          if (message?.role !== 'assistant') {
            message = recoveredToolAssistants.get(entry.data.messageId);
            if (!message) {
              message = { role: 'assistant', content: '', tool_calls: [] };
              recoveredToolAssistants.set(entry.data.messageId, message);
              messages.push(message);
            }
          }
          if (message.role === 'assistant') {
            const payload = entry.data.payload as {
              toolCallId?: string;
              toolName?: string;
              input?: JsonValue;
            };
            const toolCallId = payload.toolCallId ?? entry.data.partId;
            toolCallIdByPartId.set(entry.data.partId, toolCallId);
            message.tool_calls ??= [];
            message.tool_calls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: payload.toolName ?? 'unknown',
                arguments: JSON.stringify(payload.input ?? {}),
              },
            });
          }
        }
        if (entry.data.partType === 'tool_result') {
          const payload = entry.data.payload as {
            toolCallId?: string;
            toolName?: string;
            output?: unknown;
            error?: unknown;
          };
          const content =
            typeof payload.error === 'string'
              ? `Error: ${payload.error}`
              : typeof payload.output === 'string'
                ? payload.output
                : JSON.stringify(payload.output ?? '');
          const metadata = payload as unknown as JsonValue;
          messages.push({
            role: 'tool',
            content,
            tool_call_id:
              toolCallIdByPartId.get(entry.data.messageId) ?? payload.toolCallId,
            name: payload.toolName,
            metadata,
          });
        }
        if (entry.data.partType === 'summary') {
          const payload = entry.data.payload as { text?: string };
          const metadata = entry.data.payload as unknown as JsonValue;
          messages.push({
            role: 'system',
            content: payload.text ?? '',
            metadata,
          });
        }
        if (entry.data.partType === 'subtask_ref') {
          const message = messageMap.get(entry.data.messageId);
          if (message) {
            const metadata = entry.data.payload as unknown as JsonValue;
            const base = (message.metadata ?? {}) as Record<string, JsonValue>;
            message.metadata = { ...base, subtaskRef: metadata } as JsonValue;
          }
        }
      }
    }

    return messages;
  }

  /**
   * 获取会话文件路径
   */
  private static getSessionFilePath(projectPath: string, sessionId: string): string {
    return getSessionFilePath(projectPath, sessionId);
  }

  private static assertValidForkSessionId(sessionId: string): void {
    if (
      sessionId === '.' ||
      sessionId === '..' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sessionId)
    ) {
      throw new Error(`Invalid fork session ID: ${sessionId}`);
    }
  }
}

function toMessageContent(parts: ContentPart[]): Message['content'] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}
