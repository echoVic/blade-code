/**
 * StreamingToolExecutor — 流式工具执行器
 *
 * 在 LLM 流式输出过程中即开始执行工具，节省 RTT。
 *
 * 设计：
 * - STREAMING_PRELAUNCH_ALLOWLIST 中的工具 -> 立即启动（流式预启动）
 * - 不在 allowlist 中的工具 -> 排队到流提交后交给 ToolExecutor 公平调度
 * - parallelism=shared 的工具共享执行，exclusive 工具形成 FIFO 屏障
 * - discard() 用于流式降级到非流式时清理，递增 epoch 阻止旧世代结果
 *
 * 流式预启动要求 allowlist 和 isConcurrencySafe 同时成立。allowlist 防止在
 * provider 流提交前启动不可回放的副作用；批内语义由 parallelism 负责。
 */

import type { ContextManager } from '../../context/ContextManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { SessionInteractionService } from '../../services/SessionInteractionService.js';
import type { JsonValue } from '../../store/types.js';
import type { ToolExecutor } from '../../tools/execution/ToolExecutor.js';
import { ToolTurnAdmission } from '../../tools/execution/ToolTurnAdmission.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type {
  ExecutionContext,
  ToolProgressUpdate,
} from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import { ToolErrorType } from '../../tools/types/index.js';
import { combineAbortSignals } from '../../utils/abort.js';
import { DURABLE_TOOL_USE_FAILURE_MESSAGE } from './conversationPersistence.js';
import { ensureDurableToolIdentity } from './durableToolIdentity.js';
import type { ToolExecResult } from './types.js';

export type ToolExecutionPolicy = (
  toolName: string,
  params: Record<string, unknown>,
  context: ExecutionContext
) => Promise<ToolResult>;

export type ToolAdmissionPolicy = (
  toolName: string,
  params: Record<string, unknown>
) => ToolResult | undefined;
export type ToolAdmissionRollback = (toolName: string) => void;
export type ToolProgressSink = (
  toolCall: FunctionToolCall,
  update: ToolProgressUpdate
) => void;
export type ToolDispatchStatus = 'prelaunched' | 'queued' | 'rejected';

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
  'ReadPromptArtifact',
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
  private hasExclusiveBarrier = false;

  /** 世代计数器：每次 discard() 递增，用于防止旧世代工具结果泄漏 */
  private epoch = 0;
  /** 每个工具执行的独立 AbortController，discard() 时逐一 abort */
  private activeAborts = new Map<string, AbortController>();
  private executeTool?: ToolExecutionPolicy;
  private admitTool?: ToolAdmissionPolicy;
  private rollbackAdmission?: ToolAdmissionRollback;
  private readonly turnAdmission = new ToolTurnAdmission();
  private toolUsePersistenceTail: Promise<void> = Promise.resolve();

  constructor(
    private pipeline: ToolExecutor,
    private execContext: ExecutionContext,
    private registry: ToolRegistry,
    private contextMgr?: ContextManager | null,
    private sessionId?: string,
    private lastMessageUuid?: string | null,
    private subagentInfo?: {
      parentSessionId: string;
      subagentType: string;
      isSidechain: boolean;
    },
    private progressSink?: ToolProgressSink,
    private requireDurableToolUse = false
  ) {}

  setExecutionPolicy(executeTool: ToolExecutionPolicy): void {
    this.executeTool = executeTool;
  }

  setAdmissionPolicy(admitTool: ToolAdmissionPolicy): void {
    this.admitTool = admitTool;
  }

  setAdmissionRollback(rollbackAdmission: ToolAdmissionRollback): void {
    this.rollbackAdmission = rollbackAdmission;
  }

  /**
   * 流式中调用：在 allowlist 中的工具立即执行，否则排队
   */
  addTool(
    toolCall: FunctionToolCall,
    params: Record<string, unknown>
  ): ToolDispatchStatus {
    if (this.dispatched.has(toolCall.id)) {
      logger.debug(
        `[StreamingToolExecutor] 跳过已分发工具: ${toolCall.function.name} (${toolCall.id})`
      );
      return 'rejected';
    }
    this.dispatched.add(toolCall.id);
    this.order.push(toolCall.id);
    const batchRejection = this.turnAdmission.admit();
    if (batchRejection) {
      this.completed.set(toolCall.id, {
        toolCall,
        result: batchRejection,
        toolUseUuid: null,
      });
      return 'rejected';
    }
    ensureDurableToolIdentity(toolCall.function.name, params);
    toolCall.function.arguments = JSON.stringify(params);

    const admissionRejection = this.admitTool?.(toolCall.function.name, params);
    if (admissionRejection) {
      this.completed.set(toolCall.id, {
        toolCall,
        result: admissionRejection,
        toolUseUuid: null,
      });
      return 'rejected';
    }
    const tool = this.registry.get(toolCall.function.name);
    const concurrencySafe = tool?.isConcurrencySafe === true;
    const shared =
      tool?.parallelism === 'shared' ||
      (tool?.parallelism === undefined && concurrencySafe);
    const canPrelaunch =
      STREAMING_PRELAUNCH_ALLOWLIST.has(toolCall.function.name) &&
      concurrencySafe &&
      !this.hasExclusiveBarrier;

    if (canPrelaunch) {
      logger.debug(
        `[StreamingToolExecutor] 立即执行预启动工具: ${toolCall.function.name}`
      );
      const promise = this.executeOne(toolCall, params);
      this.pending.set(toolCall.id, promise);
      return 'prelaunched';
    } else {
      logger.debug(
        `[StreamingToolExecutor] 排队非预启动工具: ${toolCall.function.name}`
      );
      this.queued.push({ toolCall, params });
      if (!shared) {
        this.hasExclusiveBarrier = true;
      }
      return 'queued';
    }
  }

  getQueuedToolCalls(): readonly FunctionToolCall[] {
    return this.queued.map((queued) => queued.toolCall);
  }

  /**
   * 流结束后调用：按添加顺序 yield 所有结果
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecResult> {
    this.dispatchQueuedTools();

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

      // All queued calls are dispatched before ordered collection. Missing IDs
      // can only belong to a discarded generation and are intentionally ignored.
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
    for (const queued of this.queued) {
      this.rollbackAdmission?.(queued.toolCall.function.name);
    }
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
    this.hasExclusiveBarrier = false;
    this.turnAdmission.reset();
    this.toolUsePersistenceTail = Promise.resolve();
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
  private makeAbortResult(
    toolCall: FunctionToolCall,
    message: string,
    toolUseUuid: string | null = null
  ): ToolExecResult {
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
      toolUseUuid,
    };
  }

  private dispatchQueuedTools(): void {
    const queued = this.queued;
    this.queued = [];
    this.hasExclusiveBarrier = false;
    const scheduledEpoch = this.epoch;

    for (const { toolCall, params } of queued) {
      if (this.execContext.signal?.aborted) {
        this.completed.set(
          toolCall.id,
          this.makeAbortResult(
            toolCall,
            'Tool execution skipped: task aborted before launch'
          )
        );
        continue;
      }

      const promise = this.executeQueued(toolCall, params, scheduledEpoch);
      this.pending.set(toolCall.id, promise);
    }
  }

  private async executeQueued(
    toolCall: FunctionToolCall,
    params: Record<string, unknown>,
    scheduledEpoch: number
  ): Promise<ToolExecResult> {
    if (scheduledEpoch !== this.epoch) {
      return this.makeAbortResult(
        toolCall,
        'Tool execution aborted due to epoch mismatch (discard)'
      );
    }
    if (this.execContext.signal?.aborted) {
      return this.makeAbortResult(
        toolCall,
        'Tool execution skipped: task aborted before launch'
      );
    }
    return this.executeOne(toolCall, params);
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
    let toolUseUuid: string | null = null;

    // Capture current executor-level signal at dispatch time
    const executorSignal = this.abortController.signal;

    try {
      // Check if already aborted before starting
      if (executorSignal.aborted || perToolAc.signal.aborted) {
        return this.makeAbortResult(toolCall, 'Tool execution aborted due to discard');
      }

      try {
        if (this.contextMgr && this.sessionId) {
          toolUseUuid = await this.persistToolUseInOrder(toolCall, params);
        } else if (this.requireDurableToolUse && this.sessionId) {
          throw new Error('Durable tool-use storage is unavailable');
        }
      } catch (error) {
        logger.warn('[StreamingToolExecutor] 保存工具调用失败:', error);
        if (!this.requireDurableToolUse) {
          toolUseUuid = null;
        } else {
          return {
            toolCall,
            result: {
              success: false,
              llmContent: DURABLE_TOOL_USE_FAILURE_MESSAGE,
              error: {
                type: ToolErrorType.EXECUTION_ERROR,
                message: DURABLE_TOOL_USE_FAILURE_MESSAGE,
              },
              metadata: {
                durableToolUseFailed: true,
                summary: 'Blocked tool before execution',
              },
            },
            toolUseUuid: null,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
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
        messageId: toolUseUuid ?? toolCall.id,
        signal: combinedSignal,
        confirmationHandler:
          this.execContext.sessionId && this.execContext.workspaceRoot
            ? SessionInteractionService.createConfirmationHandler(
                this.execContext.confirmationHandler,
                {
                  sessionId: this.execContext.sessionId,
                  projectPath: this.execContext.workspaceRoot,
                  toolCallId: toolUseUuid ?? toolCall.id,
                  toolName: toolCall.function.name,
                }
              )
            : this.execContext.confirmationHandler,
        onProgress: (message) => {
          this.execContext.onProgress?.(message);
          this.progressSink?.(toolCall, {
            message: message.slice(0, 1_000),
          });
        },
        onProgressUpdate: (update) => {
          this.execContext.onProgressUpdate?.(update);
          this.progressSink?.(toolCall, update);
        },
      };

      const result = this.executeTool
        ? await this.executeTool(toolCall.function.name, params, execContext)
        : await this.pipeline.execute(toolCall.function.name, params, execContext);

      // Epoch guard: 如果工具执行期间发生了 discard，丢弃结果
      if (startEpoch !== this.epoch) {
        logger.debug(
          `[StreamingToolExecutor] 丢弃旧世代工具结果: ${toolCall.function.name} (startEpoch=${startEpoch}, currentEpoch=${this.epoch})`
        );
        return this.makeAbortResult(
          toolCall,
          'Tool execution aborted due to epoch mismatch (discard)',
          toolUseUuid
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
          'Tool execution aborted due to epoch mismatch (discard)',
          toolUseUuid
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
        toolUseUuid,
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

  private persistToolUseInOrder(
    toolCall: FunctionToolCall,
    params: Record<string, unknown>
  ): Promise<string | null> {
    const contextMgr = this.contextMgr;
    const sessionId = this.sessionId;
    if (!contextMgr || !sessionId) {
      return Promise.resolve(null);
    }
    const persistence = this.toolUsePersistenceTail.then(() =>
      contextMgr.saveToolUse(
        sessionId,
        toolCall.function.name,
        params as JsonValue,
        this.lastMessageUuid ?? null,
        this.subagentInfo,
        toolCall.id
      )
    );
    this.toolUsePersistenceTail = persistence.then(
      () => undefined,
      () => undefined
    );
    return persistence;
  }
}
