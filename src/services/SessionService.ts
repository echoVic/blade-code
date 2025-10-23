/**
 * 会话管理服务
 * 负责加载和恢复历史会话
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { BladeJSONLEntry } from '../context/types.js';
import {
  getBladeStorageRoot,
  unescapeProjectPath,
} from '../context/utils/pathEscape.js';
import type { Message } from './ChatServiceInterface.js';

/**
 * 会话元数据
 */
export interface SessionMetadata {
  sessionId: string;
  projectPath: string;
  gitBranch?: string;
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
            console.warn(`[SessionService] 跳过损坏的会话文件: ${filePath}`, error);
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
      console.error('[SessionService] 列出会话失败:', error);
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

    // 解析第一行和最后一行
    const firstEntry = JSON.parse(lines[0]) as BladeJSONLEntry;
    const lastEntry = JSON.parse(lines[lines.length - 1]) as BladeJSONLEntry;

    // 检查是否有错误消息
    const hasErrors = lines.some((line) => {
      try {
        const entry = JSON.parse(line) as BladeJSONLEntry;
        return entry.type === 'tool_result' && entry.toolResult?.error;
      } catch {
        return false;
      }
    });

    return {
      sessionId,
      projectPath,
      gitBranch: firstEntry.gitBranch,
      messageCount: lines.length,
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
      console.error(`[SessionService] 加载会话失败 (${sessionId}):`, error);
      throw error;
    }
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

    const entries: BladeJSONLEntry[] = lines.map(
      (line) => JSON.parse(line) as BladeJSONLEntry
    );

    return this.convertJSONLToMessages(entries);
  }

  /**
   * 将 JSONL 条目转换为 OpenAI Message 格式
   *
   * 转换规则:
   * - user/assistant/system 消息直接转换
   * - tool_use 跳过（工具调用包含在 assistant 的 tool_calls 中）
   * - tool_result 转换为 tool 角色消息
   * - compact_boundary 作为分界点：清空之前的消息，只保留总结
   * - isCompactSummary 消息作为压缩总结保留
   */
  static convertJSONLToMessages(entries: BladeJSONLEntry[]): Message[] {
    const messages: Message[] = [];
    let lastCompactBoundaryIndex = -1;

    // 第一步：找到最后一个压缩边界
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].subtype === 'compact_boundary') {
        lastCompactBoundaryIndex = i;
        console.log(`[SessionService] 检测到压缩边界 at index ${i}`);
        break;
      }
    }

    // 第二步：转换消息
    // 如果有压缩边界，从边界开始转换；否则转换全部
    const startIndex = lastCompactBoundaryIndex >= 0 ? lastCompactBoundaryIndex : 0;

    for (let i = startIndex; i < entries.length; i++) {
      const entry = entries[i];

      // 跳过 compact_boundary 本身（它只是标记，不是实际消息）
      if (entry.subtype === 'compact_boundary') {
        console.log('[SessionService] 跳过 compact_boundary 消息');
        continue;
      }

      switch (entry.type) {
        case 'user':
        case 'assistant':
        case 'system': {
          // 直接转换用户/助手/系统消息
          const message: Message = {
            role: entry.message.role,
            content:
              typeof entry.message.content === 'string'
                ? entry.message.content
                : JSON.stringify(entry.message.content),
          };

          // 如果是压缩总结，记录日志（metadata 在 JSONL 中已保存）
          if (entry.isCompactSummary) {
            console.log('[SessionService] 加载压缩总结消息');
          }

          messages.push(message);
          break;
        }

        case 'tool_result':
          // 转换工具结果为 tool 消息
          if (entry.toolResult) {
            const content = entry.toolResult.error
              ? `Error: ${entry.toolResult.error}`
              : typeof entry.toolResult.output === 'string'
                ? entry.toolResult.output
                : JSON.stringify(entry.toolResult.output);

            messages.push({
              role: 'tool',
              content,
              tool_call_id: entry.toolResult.id,
              name: entry.tool?.name, // 从对应的 tool_use 获取工具名称
            });
          }
          break;

        case 'tool_use':
          // 跳过 tool_use，因为工具调用应该包含在 assistant 消息的 tool_calls 中
          // 注意：我们的实现将 tool_use 作为独立条目保存，与 Claude Code 不同
          // 这里简化处理，恢复会话时跳过工具调用详情
          break;

        default:
          // 跳过其他类型（如 file-history-snapshot）
          break;
      }
    }

    if (lastCompactBoundaryIndex >= 0) {
      console.log(
        `[SessionService] 会话已压缩，跳过前 ${lastCompactBoundaryIndex} 条历史，加载 ${messages.length} 条消息`
      );
    }

    return messages;
  }

  /**
   * 获取会话文件路径
   */
  private static getSessionFilePath(projectPath: string, sessionId: string): string {
    const { getSessionFilePath } = require('../context/utils/pathEscape.js');
    return getSessionFilePath(projectPath, sessionId);
  }
}
