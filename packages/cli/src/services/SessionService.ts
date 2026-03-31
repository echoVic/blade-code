/**
 * 会话管理服务
 * 负责加载和恢复历史会话
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
  getBladeStorageRoot,
  getSessionFilePath,
  unescapeProjectPath,
} from '../context/storage/pathUtils.js';
import type { SessionEvent } from '../context/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { JsonValue } from '../store/types.js';
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
  relationType?: 'subagent';
  status?: 'running' | 'completed' | 'failed';
  agentType?: string;
  model?: string;
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
  filePath: string; // JSONL 文件路径
}

/**
 * 会话管理服务
 */
export class SessionService {
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
    const lines = content
      .trim()
      .split('\n')
      .filter((line) => line.trim());

    if (lines.length === 0) {
      throw new Error('空的 JSONL 文件');
    }

    const entries = lines.map((line) => JSON.parse(line) as SessionEvent);
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
    const lines = content
      .trim()
      .split('\n')
      .filter((line) => line.trim());

    const entries: SessionEvent[] = lines.map(
      (line) => JSON.parse(line) as SessionEvent
    );

    return this.convertJSONLToMessages(entries);
  }

  /**
   * 将 JSONL 条目转换为 OpenAI Message 格式
   */
  static convertJSONLToMessages(entries: SessionEvent[]): Message[] {
    const messages: Message[] = [];
    const messageMap = new Map<string, Message>();
    const partMap = new Map<string, ContentPart[]>();
    for (const entry of entries) {
      if (entry.type === 'message_created') {
        const message: Message = {
          role: entry.data.role,
          content: '',
        };
        messageMap.set(entry.data.messageId, message);
        partMap.set(entry.data.messageId, []);
        messages.push(message);
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
            tool_call_id: payload.toolCallId,
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
}

function toMessageContent(parts: ContentPart[]): Message['content'] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return [...parts];
}
