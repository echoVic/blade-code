/**
 * StreamingToolExecutor — 流式工具执行器
 *
 * 在 LLM 流式输出过程中即开始执行工具，节省 RTT。
 *
 * 设计：
 * - isConcurrencySafe 的工具（Read, Glob, Grep 等）→ 立即启动
 * - 非并发安全的工具（Edit, Write 等）→ 排队等流结束后顺序执行
 * - discard() 用于流式降级到非流式时清理
 */

import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ToolResult } from '../../tools/types/index.js';
import { ToolErrorType } from '../../tools/types/index.js';
import type { ExecutionContext } from '../../tools/types/ExecutionTypes.js';
import type { ContextManager } from '../../context/ContextManager.js';
import type { JsonValue } from '../../store/types.js';
import type { ToolExecResult } from './types.js';

const logger = createLogger(LogCategory.AGENT);

/** 仅处理 function 类型的 tool call */
type FunctionToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

interface QueuedTool {
  toolCall: FunctionToolCall;
  params: Record<string, unknown>;
}

export class StreamingToolExecutor {
  private pending = new Map<string, Promise<ToolExecResult>>();
  private completed = new Map<string, ToolExecResult>();
  private queued: QueuedTool[] = [];
  private discarded = false;
  private order: string[] = [];
  private dispatched = new Set<string>();

  constructor(
    private pipeline: ExecutionPipeline,
    private execContext: ExecutionContext,
    private registry: ToolRegistry,
    private contextMgr?: ContextManager | null,
    private sessionId?: string,
    private lastMessageUuid?: string | null,
    private subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    }
  ) {}

  /**
   * 流式中调用：并发安全的工具立即执行，否则排队
   */
  addTool(toolCall: FunctionToolCall, params: Record<string, unknown>): void {
    if (this.discarded) return;

    if (this.dispatched.has(toolCall.id)) {
      logger.debug(
        `[StreamingToolExecutor] 跳过已分发工具: ${toolCall.function.name} (${toolCall.id})`
      );
      return;
    }
    this.dispatched.add(toolCall.id);

    this.order.push(toolCall.id);
    const toolDef = this.registry.get(toolCall.function.name);
    const isSafe = toolDef?.isConcurrencySafe ?? true;

    if (isSafe) {
      logger.debug(
        `[StreamingToolExecutor] 立即执行并发安全工具: ${toolCall.function.name}`
      );
      const promise = this.executeOne(toolCall, params);
      this.pending.set(toolCall.id, promise);
    } else {
      logger.debug(
        `[StreamingToolExecutor] 排队非并发安全工具: ${toolCall.function.name}`
      );
      this.queued.push({ toolCall, params });
    }
  }

  /**
   * 流结束后调用：按添加顺序 yield 所有结果
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecResult> {
    if (this.discarded) return;

    for (const id of this.order) {
      // 已完成的
      if (this.completed.has(id)) {
        yield this.completed.get(id)!;
        this.completed.delete(id);
        continue;
      }

      // 还在执行中的
      if (this.pending.has(id)) {
        const result = await this.pending.get(id)!;
        this.pending.delete(id);
        yield result;
        continue;
      }

      // 排队中的（顺序执行）
      const queuedIdx = this.queued.findIndex(
        (q) => q.toolCall.id === id
      );
      if (queuedIdx !== -1) {
        const { toolCall, params } = this.queued[queuedIdx];
        this.queued.splice(queuedIdx, 1);
        const result = await this.executeOne(toolCall, params);
        yield result;
      }
    }
  }

  /**
   * 非阻塞获取已完成的结果
   */
  getCompletedResults(): ToolExecResult[] {
    const results = Array.from(this.completed.values());
    this.completed.clear();
    return results;
  }

  /**
   * 丢弃所有挂起/排队的工作（流失败时调用）
   */
  discard(): void {
    this.discarded = true;
    this.queued = [];
    logger.debug('[StreamingToolExecutor] 已丢弃所有挂起工作');
  }

  /**
   * 是否有工具被添加
   */
  hasTools(): boolean {
    return this.order.length > 0;
  }

  private async executeOne(
    toolCall: FunctionToolCall,
    params: Record<string, unknown>
  ): Promise<ToolExecResult> {
    try {
      let toolUseUuid: string | null = null;
      try {
        if (this.contextMgr && this.sessionId) {
          toolUseUuid = await this.contextMgr.saveToolUse(
            this.sessionId,
            toolCall.function.name,
            params as JsonValue,
            this.lastMessageUuid ?? null,
            this.subagentInfo
          );
        }
      } catch (err) {
        logger.warn('[StreamingToolExecutor] 保存工具调用失败:', err);
      }

      const result = await this.pipeline.execute(
        toolCall.function.name,
        params,
        this.execContext
      );

      const execResult: ToolExecResult = {
        toolCall,
        result,
        toolUseUuid,
      };

      // 从 pending 移到 completed
      if (this.pending.has(toolCall.id)) {
        this.pending.delete(toolCall.id);
        this.completed.set(toolCall.id, execResult);
      }

      return execResult;
    } catch (error) {
      logger.error(
        `[StreamingToolExecutor] 工具执行失败: ${toolCall.function.name}`,
        error
      );
      const errorResult: ToolResult = {
        success: false,
        llmContent: '',
        displayContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message:
            error instanceof Error ? error.message : 'Unknown error',
        },
        metadata: undefined,
      };
      const execResult: ToolExecResult = {
        toolCall,
        result: errorResult,
        toolUseUuid: null,
        error: error instanceof Error ? error : new Error('Unknown error'),
      };

      if (this.pending.has(toolCall.id)) {
        this.pending.delete(toolCall.id);
        this.completed.set(toolCall.id, execResult);
      }

      return execResult;
    }
  }
}