/**
 * 上下文管理器 - PersistentStore 的薄门面
 *
 * 历史上此类包含内存模型、压缩、过滤、搜索等功能，
 * 但这些功能已迁移到独立模块（CompactionService、ReactiveCompaction 等），
 * 仅保留 JSONL 持久化委托方法。
 */

import type { SubagentInfoForContext } from '../agent/types.js';
import type { ContentPart } from '../services/ChatServiceInterface.js';
import type { JsonValue } from '../store/types.js';
import { getCwd } from '../utils/cwd.js';
import type { CompactionPersistenceMetadata } from './compactionCheckpoint.js';
import type { RecordTokenBudgetHandoffResult } from './storage/PersistentStore.js';
import { PersistentStore } from './storage/PersistentStore.js';
import type {
  ContextManagerOptions,
  MessagePersistenceMetadata,
  SubagentRunRef,
} from './types.js';

/**
 * 上下文管理器 - 统一管理所有上下文相关操作
 */
export class ContextManager {
  private readonly persistent: PersistentStore;

  /**
   * 获取持久化存储实例（供外部直接调用 JSONL 操作）
   */
  get persistentStore(): PersistentStore {
    return this.persistent;
  }

  constructor(options: Partial<ContextManagerOptions> = {}) {
    this.persistent = new PersistentStore(
      options.projectPath ?? getCwd(),
      undefined,
      options.stateStorage
    );
  }

  /**
   * 初始化持久化存储目录
   */
  async initialize(): Promise<void> {
    await this.persistent.initialize();
  }

  /**
   * 保存消息到 JSONL (直接访问 PersistentStore,不依赖 currentSessionId)
   */
  async saveMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string | ContentPart[],
    parentUuid: string | null = null,
    metadata?: MessagePersistenceMetadata,
    subagentInfo?: SubagentInfoForContext,
    reasoningContent?: string
  ): Promise<string> {
    return this.persistent.saveMessage(
      sessionId,
      role,
      content,
      parentUuid,
      metadata,
      subagentInfo,
      reasoningContent
    );
  }

  /**
   * 保存工具调用到 JSONL (直接访问 PersistentStore)
   */
  async saveToolUse(
    sessionId: string,
    toolName: string,
    toolInput: JsonValue,
    parentUuid: string | null = null,
    subagentInfo?: SubagentInfoForContext,
    providerToolCallId?: string
  ): Promise<string> {
    return this.persistent.saveToolUse(
      sessionId,
      toolName,
      toolInput,
      parentUuid,
      subagentInfo,
      providerToolCallId
    );
  }

  /**
   * 保存工具结果到 JSONL (直接访问 PersistentStore)
   */
  async saveToolResult(
    sessionId: string,
    toolId: string,
    toolName: string,
    toolOutput: JsonValue,
    parentUuid: string | null = null,
    error?: string,
    subagentInfo?: SubagentInfoForContext,
    subagentRef?: SubagentRunRef,
    toolMetadata?: JsonValue
  ): Promise<string> {
    return this.persistent.saveToolResult(
      sessionId,
      toolId,
      toolName,
      toolOutput,
      parentUuid,
      error,
      subagentInfo,
      subagentRef,
      toolMetadata
    );
  }

  /**
   * 保存压缩边界和总结到 JSONL (直接访问 PersistentStore)
   */
  async saveCompaction(
    sessionId: string,
    summary: string,
    metadata: CompactionPersistenceMetadata,
    parentUuid: string | null = null
  ): Promise<string> {
    return this.persistent.saveCompaction(sessionId, summary, metadata, parentUuid);
  }

  async recordTokenBudgetHandoff(
    sessionId: string,
    payload: Parameters<PersistentStore['recordTokenBudgetHandoff']>[1]
  ): Promise<RecordTokenBudgetHandoffResult> {
    return this.persistent.recordTokenBudgetHandoff(sessionId, payload);
  }
}
