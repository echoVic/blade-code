import { nanoid } from 'nanoid';
import * as fs from 'node:fs/promises';
import type { JsonValue, MessageRole } from '../../store/types.js';
import type { BladeJSONLEntry } from '../types.js';
import { JSONLStore } from './JSONLStore.js';
import { detectGitBranch, getProjectStoragePath, getSubagentFilePath } from './pathUtils.js';

export interface SubagentInfo {
  agentId: string;
  subagentType: string;
  parentSessionId: string;
}

export class SubagentPersistentStore {
  private readonly projectPath: string;
  private readonly version: string;

  constructor(projectPath: string = process.cwd(), version: string = '0.0.10') {
    this.projectPath = projectPath;
    this.version = version;
  }

  async initialize(): Promise<void> {
    try {
      const storagePath = getProjectStoragePath(this.projectPath);
      await fs.mkdir(storagePath, { recursive: true, mode: 0o755 });
    } catch (error) {
      console.warn('[SubagentPersistentStore] 无法创建存储目录:', error);
    }
  }

  async saveMessage(
    subagentInfo: SubagentInfo,
    messageRole: MessageRole,
    content: string,
    parentUuid: string | null = null,
    metadata?: {
      model?: string;
      usage?: { input_tokens: number; output_tokens: number };
    }
  ): Promise<string> {
    try {
      const filePath = getSubagentFilePath(this.projectPath, subagentInfo.agentId);
      const store = new JSONLStore(filePath);

      const entry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid,
        sessionId: subagentInfo.agentId,
        parentSessionId: subagentInfo.parentSessionId,
        isSidechain: true,
        timestamp: new Date().toISOString(),
        type:
          messageRole === 'user'
            ? 'user'
            : messageRole === 'assistant'
              ? 'assistant'
              : messageRole === 'tool'
                ? 'tool_result'
                : 'system',
        cwd: this.projectPath,
        gitBranch: detectGitBranch(this.projectPath),
        version: this.version,
        message: {
          role: messageRole,
          content,
          ...(metadata || {}),
        },
        subagentType: subagentInfo.subagentType,
      };

      await store.append(entry);
      return entry.uuid;
    } catch (error) {
      console.error(
        `[SubagentPersistentStore] 保存消息失败 (agent: ${subagentInfo.agentId}):`,
        error
      );
      throw error;
    }
  }

  async saveToolUse(
    subagentInfo: SubagentInfo,
    toolName: string,
    toolInput: JsonValue,
    parentUuid: string | null = null
  ): Promise<string> {
    try {
      const filePath = getSubagentFilePath(this.projectPath, subagentInfo.agentId);
      const store = new JSONLStore(filePath);

      const entry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid,
        sessionId: subagentInfo.agentId,
        parentSessionId: subagentInfo.parentSessionId,
        isSidechain: true,
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
        subagentType: subagentInfo.subagentType,
      };

      await store.append(entry);
      return entry.uuid;
    } catch (error) {
      console.error(
        `[SubagentPersistentStore] 保存工具调用失败 (agent: ${subagentInfo.agentId}):`,
        error
      );
      throw error;
    }
  }

  async saveToolResult(
    subagentInfo: SubagentInfo,
    toolId: string,
    toolName: string,
    toolOutput: JsonValue,
    parentUuid: string | null = null,
    error?: string
  ): Promise<string> {
    try {
      const filePath = getSubagentFilePath(this.projectPath, subagentInfo.agentId);
      const store = new JSONLStore(filePath);

      const entry: BladeJSONLEntry = {
        uuid: nanoid(),
        parentUuid,
        sessionId: subagentInfo.agentId,
        parentSessionId: subagentInfo.parentSessionId,
        isSidechain: true,
        timestamp: new Date().toISOString(),
        type: 'tool_result',
        cwd: this.projectPath,
        gitBranch: detectGitBranch(this.projectPath),
        version: this.version,
        message: {
          role: 'assistant',
          content: '',
        },
        tool: {
          id: toolId,
          name: toolName,
          input: {},
        },
        toolResult: {
          id: toolId,
          output: toolOutput,
          error,
        },
        subagentType: subagentInfo.subagentType,
      };

      await store.append(entry);
      return entry.uuid;
    } catch (error) {
      console.error(
        `[SubagentPersistentStore] 保存工具结果失败 (agent: ${subagentInfo.agentId}):`,
        error
      );
      throw error;
    }
  }

  async readAll(agentId: string): Promise<BladeJSONLEntry[]> {
    try {
      const filePath = getSubagentFilePath(this.projectPath, agentId);
      const store = new JSONLStore(filePath);
      return await store.readAll();
    } catch (error) {
      console.error(
        `[SubagentPersistentStore] 读取子代理会话失败 (agent: ${agentId}):`,
        error
      );
      return [];
    }
  }

  async exists(agentId: string): Promise<boolean> {
    try {
      const filePath = getSubagentFilePath(this.projectPath, agentId);
      const store = new JSONLStore(filePath);
      return await store.exists();
    } catch {
      return false;
    }
  }

  async delete(agentId: string): Promise<void> {
    try {
      const filePath = getSubagentFilePath(this.projectPath, agentId);
      const store = new JSONLStore(filePath);
      await store.delete();
    } catch (error) {
      console.warn(
        `[SubagentPersistentStore] 删除子代理会话失败 (agent: ${agentId}):`,
        error
      );
    }
  }

  async getStats(agentId: string): Promise<{
    exists: boolean;
    size: number;
    lineCount: number;
  }> {
    try {
      const filePath = getSubagentFilePath(this.projectPath, agentId);
      const store = new JSONLStore(filePath);
      return await store.getStats();
    } catch {
      return { exists: false, size: 0, lineCount: 0 };
    }
  }
}
