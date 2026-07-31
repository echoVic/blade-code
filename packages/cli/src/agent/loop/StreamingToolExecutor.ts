/**
 * StreamingToolExecutor — 流式工具执行器
 *
 * 在 LLM 流式输出过程中即开始执行工具，节省 RTT。
 *
 * 设计：
 * - STREAMING_PRELAUNCH_ALLOWLIST 中的工具 -> 立即启动（流式预启动）
 * - 不在 allowlist 中的工具 -> 排队等流结束后顺序执行
 * - discard() 用于流式降级到非流式时清理，递增 epoch 阻止旧世代结果
 *
 * 注意：流式预启动 allowlist 与 isConcurrencySafe 是独立概念：
 * - allowlist 决定是否允许在流式阶段提前执行
 * - isConcurrencySafe 仅在 ExecutionPipeline 中决定是否需要文件锁
 */

import type { ContextManager } from '../../context/ContextManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type { JsonValue } from '../../store/types.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ExecutionContext } from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import { ToolErrorType } from '../../tools/types/index.js';
import { combineAbortSignals } from '../../utils/abort.js';
import type { ToolExecResult } from './types.js';

const logger = createLogger(LogCategory.AGENT);

/**
 * 允许在流式阶段提前执行的工具白名单。
 * 仅纯读、无副作用的工具才应出现在此列表中。
 * 此列表与 isConcurrencySafe（文件锁语义）完全独立。
 */
export const STREAMING_PRELAUNCH_ALLOWLIST: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'MemoryRead',
  'GetSpecContext',
  'ValidateSpec',
  'TaskOutput',
]);

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
  private order: string[] = [];
  private dispatched = new Set<string>();
  private abortController = new AbortController();

  /** 世代计数器：每次 discard() 递增，用于防止旧世代工具结果泄漏 */
  private epoch = 0;
  /** 每个工具执行的独立 AbortController，discard() 时逐一 abort */
  private activeAborts = new Map<string, AbortController>();

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
   * 流式中调用：在 allowlist 中的工具立即执行，否则排队
   */
  addTool(toolCall: FunctionToolCall, params: Record<string, unknown>): void {
    if (this.dispatched.has(toolCall.id)) {
      logger.debug(
        `[StreamingToolExecutor] 跳过已分发工具: ${toolCall.function.name} (${toolCall.id})`
      );
      return;
    }
    this.dispatched.add(toolCall.id);

    this.order.push(toolCall.id);
    const canPrelaunch = STREAMING_PRELAUNCH_ALLOWLIST.has(toolCall.function.name);

    if (canPrelaunch) {
      logger.debug(
        `[StreamingToolExecutor] 立即执行预启动工具: ${toolCall.function.name}`
      );
      const promise = this.executeOne(toolCall, params);
      this.pending.set(toolCall.id, promise);
    } else {
      logger.debug(
        `[StreamingToolExecutor] 排队非预启动工具: ${toolCall.function.name}`
      );
      this.queued.push({ toolCall, params });
    }
  }

  /**
   * 流结束后调用：按添加顺序 yield 所有结果
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecResult> {
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
      const queuedIdx = this.queued.findIndex((q) => q.toolCall.id === id);
      if (queuedIdx !== -1) {
        const { toolCall, params } = this.queued[queuedIdx];
        this.queued.splice(queuedIdx, 1);

        // Guard: 如果 user signal 已 aborted，不启动尚未开始的排队工具
        if (this.execContext.signal?.aborted) {
          logger.debug(
            `[StreamingToolExecutor] Signal aborted, 跳过排队工具: ${toolCall.function.name} (${toolCall.id})`
          );
          yield this.makeAbortResult(
            toolCall,
            'Tool execution skipped: task aborted before launch'
          );
          continue;
        }

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
   * 丢弃所有挂起/排队的工作并重置状态。
   * modelFallback 时调用：清理旧模型的工具执行，使执行器可接受新模型的 tool calls。
   * 递增 epoch，使旧世代工具返回后被忽略。
   */
  discard(): void {
    // 递增 epoch，旧世代的 executeOne() 返回后会被拦截
    this.epoch++;

    // Abort executor 级 signal
    this.abortController.abort();
    this.abortController = new AbortController();

    // Abort 所有 per-tool signal
    for (const [, ac] of this.activeAborts) {
      ac.abort();
    }
    this.activeAborts.clear();

    this.queued = [];
    this.order = [];
    this.dispatched.clear();
    this.completed.clear();
    this.pending.clear();
    logger.debug(
      `[StreamingToolExecutor] 已丢弃所有挂起工作并重置状态 (epoch=${this.epoch})`
    );
  }

  /**
   * 是否有工具被添加
   */
  hasTools(): boolean {
    return this.order.length > 0;
  }

  /**
   * 获取当前 epoch（仅供测试使用）
   */
  getEpoch(): number {
    return this.epoch;
  }

  /** 构建 abort/discard 结果 */
  private makeAbortResult(toolCall: FunctionToolCall, message: string): ToolExecResult {
    return {
      toolCall,
      result: {
        success: false,
        llmContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message,
        },
        metadata: {
          abortedBeforeLaunch: true,
        },
      },
      toolUseUuid: null,
    };
  }

  private async executeOne(
    toolCall: FunctionToolCall,
    params: Record<string, unknown>
  ): Promise<ToolExecResult> {
    // 捕获启动时的 epoch，用于检测 discard
    const startEpoch = this.epoch;

    // 为此工具创建独立的 AbortController
    const perToolAc = new AbortController();
    this.activeAborts.set(toolCall.id, perToolAc);

    // Capture current executor-level signal at dispatch time
    const executorSignal = this.abortController.signal;

    try {
      // Check if already aborted before starting
      if (executorSignal.aborted || perToolAc.signal.aborted) {
        return this.makeAbortResult(toolCall, 'Tool execution aborted due to discard');
      }

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

      // Merge executor signal, per-tool signal, and user signal
      const signalsToMerge = [executorSignal, perToolAc.signal];
      const userSignal = this.execContext.signal;
      if (userSignal) {
        signalsToMerge.push(userSignal);
      }
      const combinedSignal = combineAbortSignals(...signalsToMerge);
      const execContext: ExecutionContext = {
        ...this.execContext,
        signal: combinedSignal,
      };

      const result = await this.pipeline.execute(
        toolCall.function.name,
        params,
        execContext
      );

      // Epoch guard: 如果工具执行期间发生了 discard，丢弃结果
      if (startEpoch !== this.epoch) {
        logger.debug(
          `[StreamingToolExecutor] 丢弃旧世代工具结果: ${toolCall.function.name} (startEpoch=${startEpoch}, currentEpoch=${this.epoch})`
        );
        return this.makeAbortResult(
          toolCall,
          'Tool execution aborted due to epoch mismatch (discard)'
        );
      }

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
      // Epoch guard: 异常路径也检查 epoch
      if (startEpoch !== this.epoch) {
        return this.makeAbortResult(
          toolCall,
          'Tool execution aborted due to epoch mismatch (discard)'
        );
      }

      logger.error(
        `[StreamingToolExecutor] 工具执行失败: ${toolCall.function.name}`,
        error
      );
      const errorResult: ToolResult = {
        success: false,
        llmContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
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
    } finally {
      // 清理 per-tool AbortController
      this.activeAborts.delete(toolCall.id);
    }
  }
}
