/**
 * AsyncGenerator 驱动的 Agent 循环
 *
 * 从 Agent.executeLoop() 提取的核心循环逻辑，
 * 转换为 AsyncGenerator 模式，yield LoopEvent 事件流。
 */

import { nanoid } from 'nanoid';
import { type PermissionMode } from '../../config/index.js';
import { CompactionService } from '../../context/CompactionService.js';
import { ReactiveCompaction } from '../../context/ReactiveCompaction.js';
import { snipCompact } from '../../context/SnipCompaction.js';
import { createBudgetTracker, recordOutput } from '../../context/TokenBudget.js';
import {
  applyToolResultBudget,
  MessageBudgetTracker,
} from '../../context/ToolResultBudget.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type {
  ChatResponse,
  Message,
  StreamToolCall,
} from '../../services/ChatServiceInterface.js';
import { injectSkillsMetadata } from '../../skills/index.js';
import type { JsonValue } from '../../store/types.js';
import { ToolErrorType } from '../../tools/types/index.js';
import { isAbortError } from '../../utils/abort.js';
import { getAbortReason } from '../../utils/abortReason.js';
import { getCwd } from '../../utils/cwd.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from '../types.js';
import {
  checkIncompleteIntent,
  checkOutputRecovery,
  checkRalphLoop,
  checkStopHook,
} from './completionPolicy.js';
import {
  saveCompaction as persistCompaction,
  saveToolResult as persistToolResult,
  saveAssistantMessage,
  saveToolUse,
  saveUserMessage,
} from './conversationPersistence.js';
import { ConversationState } from './ConversationState.js';
import { StreamingToolExecutor } from './StreamingToolExecutor.js';
import type { FunctionToolCallRef } from './toolDomainPolicy.js';
import { applyToolDomainEffects } from './toolDomainPolicy.js';
import type { LoopDependencies, LoopEvent, ToolCallRef } from './types.js';

const logger = createLogger(LogCategory.AGENT);

const COMPACTION_FALLBACK_OUTPUT_RATIO = 0.1;
const COMPACTION_FALLBACK_MIN_OUTPUT_TOKENS = 8192;
const COMPACTION_FALLBACK_MAX_OUTPUT_TOKENS = 32768;
const SAFETY_LIMIT = 100;

// ===== Helper Functions (extracted from Agent.ts) =====

function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function extractApiErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '未知错误';
  const retryError = error as Error & { lastError?: Error; reason?: string };
  const rootError = retryError.lastError ?? error;
  const apiError = rootError as Error & {
    responseBody?: string;
    statusCode?: number;
  };
  if (apiError.responseBody) {
    try {
      const body = JSON.parse(apiError.responseBody);
      const msg = body?.error?.message;
      if (msg) {
        const statusHint = apiError.statusCode
          ? ` (HTTP ${apiError.statusCode})`
          : '';
        return `${msg}${statusHint}`;
      }
    } catch {
      // JSON 解析失败，fallback
    }
  }
  const message = error.message;
  const lastErrorMatch = message.match(/Last error:\s*(.+)$/);
  if (lastErrorMatch) {
    return lastErrorMatch[1];
  }
  return message;
}

function isStreamingNotSupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const streamErrors = [
    'stream not supported',
    'streaming is not available',
    'sse not supported',
    'does not support streaming',
  ];
  return streamErrors.some((msg) =>
    error.message.toLowerCase().includes(msg.toLowerCase())
  );
}

function isPromptTooLongError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('prompt_too_long') ||
    msg.includes('prompt is too long') ||
    msg.includes('maximum context length') ||
    msg.includes('request too large') ||
    (error as Error & { status?: number }).status === 413
  );
}

function accumulateToolCall(
  accumulator: Map<number, { id: string; name: string; arguments: string }>,
  chunk: StreamToolCall
): void {
  const tc = chunk as {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  };
  const index = tc.index ?? 0;
  if (!accumulator.has(index)) {
    accumulator.set(index, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
  }
  const entry = accumulator.get(index)!;
  if (tc.id && !entry.id) entry.id = tc.id;
  if (tc.function?.name && !entry.name) entry.name = tc.function.name;
  if (tc.function?.arguments) {
    entry.arguments += tc.function.arguments;
  }
}

function buildFinalToolCalls(
  accumulator: Map<number, { id: string; name: string; arguments: string }>
): ChatResponse['toolCalls'] | undefined {
  if (accumulator.size === 0) return undefined;
  return Array.from(accumulator.values())
    .filter((tc) => tc.id && tc.name)
    .map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
}

// ===== processStreamResponse (extracted from Agent.ts) =====

/** processStreamResponse 的扩展返回类型，携带 fallback 标记 */
type StreamResponseResult = ChatResponse & {
  /** 标记此 turn 实际走了非流式 fallback（0-chunk 降级 或 streaming-not-supported） */
  _nonStreamingFallback?: boolean;
};

async function* processStreamResponse(
  deps: LoopDependencies,
  messages: Message[],
  tools: Array<{ name: string; description: string; parameters: unknown }>,
  signal?: AbortSignal,
  executor?: StreamingToolExecutor
): AsyncGenerator<LoopEvent, StreamResponseResult, void> {
  let fullContent = '';
  let fullReasoningContent = '';
  let streamUsage: ChatResponse['usage'];
  let streamFinishReason: string | undefined;
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  try {
    const stream = deps.chatService.streamChat(messages, tools, signal);
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount++;
      if (signal?.aborted) break;

      if (chunk.modelFallback) {
        executor?.discard();
        fullContent = '';
        fullReasoningContent = '';
        streamUsage = undefined;
        streamFinishReason = undefined;
        toolCallAccumulator.clear();
        chunkCount = 0;
        yield { kind: 'model_fallback' };
        continue;
      }

      if (chunk.content) {
        fullContent += chunk.content;
        yield { kind: 'content_delta', delta: chunk.content };
      }
      if (chunk.reasoningContent) {
        fullReasoningContent += chunk.reasoningContent;
        yield { kind: 'thinking_delta', delta: chunk.reasoningContent };
      }
      if (chunk.usage) {
        streamUsage = chunk.usage;
      }
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          accumulateToolCall(toolCallAccumulator, tc);

          // Vercel AI SDK 的 tool-call 事件包含完整参数
          // 立即通过 StreamingToolExecutor 启动执行
          if (executor) {
            const castTc = tc as {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            };
            const idx = castTc.index ?? 0;
            const entry = toolCallAccumulator.get(idx);
            if (entry && entry.id && entry.name) {
              try {
                const params = JSON.parse(entry.arguments);
                const toolCall = {
                  id: entry.id,
                  type: 'function' as const,
                  function: { name: entry.name, arguments: entry.arguments },
                };
                const toolDef = deps.executionPipeline.getRegistry().get(entry.name);
                const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
                // 先启动工具执行，再 yield 事件通知消费者
                executor.addTool(toolCall, params);
                yield { kind: 'tool_start', toolCall, toolKind };
              } catch {
                // JSON 解析失败，等流结束后处理
              }
            }
          }
        }
      }
      if (chunk.finishReason) {
        streamFinishReason = chunk.finishReason;
        break;
      }
    }

    // 如果流返回0个chunk且没有被中止，回退到非流式模式
    if (
      chunkCount === 0 &&
      !signal?.aborted &&
      fullContent.length === 0 &&
      toolCallAccumulator.size === 0
    ) {
      logger.warn('[Loop] 流式响应返回0个chunk，回退到非流式模式');
      executor?.discard();
      const fallbackResult = await deps.chatService.chat(messages, tools, signal);
      return { ...fallbackResult, _nonStreamingFallback: true };
    }

    return {
      content: fullContent,
      reasoningContent: fullReasoningContent || undefined,
      toolCalls: buildFinalToolCalls(toolCallAccumulator),
      usage: streamUsage,
      finishReason: streamFinishReason,
    };
  } catch (error) {
    if (isStreamingNotSupportedError(error)) {
      logger.warn('[Loop] 流式请求失败，降级到非流式模式');
      executor?.discard();
      const fallbackResult = await deps.chatService.chat(messages, tools, signal);
      return { ...fallbackResult, _nonStreamingFallback: true };
    }
    throw error;
  }
}

// ===== checkAndCompactInLoop (extracted from Agent.ts) =====

export type CompactResult = 'none' | 'snipped' | 'compacted';

export async function checkAndCompactInLoop(
  deps: LoopDependencies,
  context: ChatContext,
  currentTurn: number,
  actualPromptTokens?: number,
  signal?: AbortSignal,
): Promise<CompactResult> {
  if (actualPromptTokens === undefined) {
    logger.debug(
      `[Loop] [轮次 ${currentTurn}] 压缩检查: 跳过（无历史 usage 数据）`
    );
    return 'none';
  }

  // Level 1: Snip compaction — 轻量截断旧工具调用，无 LLM 调用
  // 延迟写入：先保存 snip 结果，等确认不需要 LLM compaction 或 LLM compaction 完成后再写入
  // 防止 LLM compaction abort 时 context.messages 处于半 snip 状态
  const snipResult = snipCompact(context.messages);
  let didSnip = false;
  if (snipResult.snippedCount > 0) {
    didSnip = true;
    logger.debug(
      `[Loop] [轮次 ${currentTurn}] Snip 压缩: 移除 ${snipResult.snippedCount} 轮旧工具调用，释放约 ${snipResult.estimatedTokensFreed} tokens`
    );
  }

  // Level 2: LLM compaction — 80% 阈值触发 LLM 摘要压缩
  const chatConfig = deps.chatService.getConfig();
  const modelName = chatConfig.model;
  const maxContextTokens =
    chatConfig.maxContextTokens ?? deps.config.maxContextTokens;
  const maxOutputTokens =
    chatConfig.maxOutputTokens ??
    deps.config.maxOutputTokens ??
    Math.min(
      Math.max(
        Math.floor(maxContextTokens * COMPACTION_FALLBACK_OUTPUT_RATIO),
        COMPACTION_FALLBACK_MIN_OUTPUT_TOKENS
      ),
      COMPACTION_FALLBACK_MAX_OUTPUT_TOKENS
    );

  const availableForInput = maxContextTokens - maxOutputTokens;
  const threshold = Math.floor(availableForInput * 0.8);

  logger.debug(`[Loop] [轮次 ${currentTurn}] 压缩检查:`, {
    promptTokens: actualPromptTokens,
    maxContextTokens,
    maxOutputTokens,
    availableForInput,
    threshold,
    shouldCompact: actualPromptTokens >= threshold,
  });

  if (actualPromptTokens < threshold) {
    // 不需要 LLM compaction，安全写入 snip 结果
    if (didSnip) {
      context.messages = snipResult.messages;
    }
    return didSnip ? 'snipped' : 'none';
  }

  logger.debug(
    currentTurn === 0
      ? '[Loop] 触发自动压缩'
      : `[Loop] [轮次 ${currentTurn}] 触发循环内自动压缩`
  );

  try {
    // LLM compaction 使用 snip 后的消息（如有），但不提前写入 context.messages
    const messagesForCompact = didSnip ? snipResult.messages : context.messages;
    const result = await CompactionService.compact(messagesForCompact, {
      trigger: 'auto',
      modelName,
      maxContextTokens,
      apiKey: chatConfig.apiKey,
      baseURL: chatConfig.baseUrl,
      actualPreTokens: actualPromptTokens,
      signal,
    });

    context.messages = result.compactedMessages;
    if (result.success) {
      logger.debug(
        `[Loop] [轮次 ${currentTurn}] 压缩完成: ${result.preTokens} -> ${result.postTokens} tokens`
      );
    } else {
      logger.warn(
        `[Loop] [轮次 ${currentTurn}] 压缩使用降级策略: ${result.preTokens} -> ${result.postTokens} tokens`
      );
    }

    // 保存压缩数据到 JSONL
    await persistCompaction(deps, context, result.summary, {
      trigger: 'auto',
      preTokens: result.preTokens,
      postTokens: result.postTokens,
      filesIncluded: result.filesIncluded,
    });

    return 'compacted';
  } catch (error) {
    // AbortError（宽口径）: 返回 'none' 让控制流回到主循环的下一个 signal 检查点
    // 注意：abort 时不写入 snip 结果到 context.messages，保持原始状态
    if (isAbortError(error)) {
      logger.debug(`[Loop] [轮次 ${currentTurn}] 压缩被中止`);
      return 'none';
    }
    // 非 abort 错误：snip 是安全的确定性操作，可以保留
    if (didSnip) {
      context.messages = snipResult.messages;
    }
    logger.error(`[Loop] [轮次 ${currentTurn}] 压缩失败，继续执行`, error);
    return didSnip ? 'snipped' : 'none';
  }
}

// ===== Main Generator =====

/** Helper: 构建 abort 返回值，减少重复代码 */
function makeAbortResult(
  turnsCount: number,
  toolCallsCount: number,
  startTime: number,
  signal?: AbortSignal,
): LoopResult {
  const reason = signal ? getAbortReason(signal) : 'user-cancel';
  // interrupt 不显示"任务已停止"（紧接着就有新任务开始），只有 user-cancel 显示
  const message = reason === 'interrupt'
    ? undefined
    : '任务已被用户中止';

  return {
    success: false,
    error: { type: 'aborted', message: message ?? '任务已中断' },
    metadata: {
      turnsCount,
      toolCallsCount,
      duration: Date.now() - startTime,
      abortReason: reason,
    },
  };
}

export async function* executeLoopGenerator(
  deps: LoopDependencies,
  message: UserMessageContent,
  context: ChatContext,
  options: LoopOptions | undefined,
  systemPrompt: string | undefined
): AsyncGenerator<LoopEvent, LoopResult, void> {
  const startTime = Date.now();
  // 提到 try 外，使 catch 中的 makeAbortResult 能拿到真实进度
  let turnsCount = 0;
  const allToolResults: import('../../tools/types/index.js').ToolResult[] = [];

  try {
    // 1. 获取可用工具定义
    const registry = deps.executionPipeline.getRegistry();
    const permissionMode = context.permissionMode as PermissionMode | undefined;
    let rawTools = registry.getFunctionDeclarationsByMode(permissionMode);
    rawTools = injectSkillsMetadata(rawTools);
    const tools = deps.applySkillToolRestrictions(rawTools);

    // 1.5 注入 deferred tools listing 到系统提示
    let finalSystemPrompt = systemPrompt;
    if (
      typeof registry.getDeferredToolsListing === 'function'
    ) {
      const deferredListing = registry.getDeferredToolsListing();
      if (deferredListing && finalSystemPrompt) {
        finalSystemPrompt =
          `${finalSystemPrompt}\n\n${deferredListing}`;
      }
    }

    // 2. 构建消息历史 — 使用 ConversationState 单一消息源
    const state = new ConversationState(context, finalSystemPrompt);
    state.appendUser({ role: 'user', content: message });

    // 保存用户消息到 JSONL
    let lastMessageUuid: string | null = await saveUserMessage(deps, context, message);

    // === Agentic Loop ===
    const isYoloMode = context.permissionMode === ('yolo' as PermissionMode);
    const configuredMaxTurns =
      deps.runtimeOptions.maxTurns ?? options?.maxTurns ?? deps.config.maxTurns ?? -1;

    if (configuredMaxTurns === 0) {
      return {
        success: false,
        error: {
          type: 'chat_disabled',
          message: '对话功能已被禁用 (maxTurns=0)',
        },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    }

    const maxTurns =
      configuredMaxTurns === -1
        ? SAFETY_LIMIT
        : Math.min(configuredMaxTurns, SAFETY_LIMIT);

    let totalTokens = 0;
    let lastPromptTokens: number | undefined;
    let maxOutputRecoveryCount = 0;
    let incompleteIntentRetryCount = 0;

    const isSubagent = !!context.subagentInfo;
    let budgetTracker = createBudgetTracker({
      budget: deps.currentModelMaxContextTokens,
      isSubagent,
    });

    const reactiveCompaction = new ReactiveCompaction();

    try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 1. 检查中断信号
      if (options?.signal?.aborted) {
        return makeAbortResult(turnsCount, allToolResults.length, startTime, options.signal);
      }

      // 2. 上下文压缩检查
      // writeback 确保 context.messages 与 state.history 同步，
      // 因为 checkAndCompactInLoop 直接读取 context.messages
      state.writeback();
      const compactResult = await checkAndCompactInLoop(
        deps,
        context,
        turnsCount,
        lastPromptTokens,
        options?.signal,
      );

      if (compactResult !== 'none') {
        if (compactResult === 'compacted') {
          yield { kind: 'compaction', phase: 'start' as const };
          yield { kind: 'compaction', phase: 'end' as const };
        }
        // checkAndCompactInLoop 已更新 context.messages，同步到 state
        state.replaceHistory(context.messages);
      }

      // 3. 轮次计数
      turnsCount++;
      reactiveCompaction.reset();
      yield { kind: 'turn_start', turn: turnsCount, maxTurns };

      if (options?.signal?.aborted) {
        return makeAbortResult(turnsCount - 1, allToolResults.length, startTime, options.signal);
      }

      // 4. 调用 LLM
      const isStreamEnabled = options?.stream !== false;
      let turnResult: StreamResponseResult;
      let streamingExecutor: StreamingToolExecutor | undefined;

      try {
        if (isStreamEnabled) {
          streamingExecutor = new StreamingToolExecutor(
            deps.executionPipeline,
            {
              sessionId: context.sessionId,
              userId: context.userId || 'default',
              workspaceRoot: context.workspaceRoot || getCwd(),
              signal: options?.signal,
              confirmationHandler: context.confirmationHandler,
              permissionMode: context.permissionMode,
              toolRegistry: registry,
              deferredToolManager:
                registry.deferredToolManager,
            },
            deps.executionPipeline.getRegistry(),
            deps.executionEngine?.getContextManager(),
            context.sessionId,
            lastMessageUuid,
            context.subagentInfo
          );

          turnResult = yield* processStreamResponse(
            deps,
            state.toLLMMessages(),
            tools,
            options?.signal,
            streamingExecutor
          );
        } else {
          turnResult = await deps.chatService.chat(
            state.toLLMMessages(),
            tools,
            options?.signal
          );
        }
      } catch (llmError) {
        // Check if it's a 413 / prompt_too_long error
        if (isPromptTooLongError(llmError)) {
          logger.warn('[Loop] 检测到 prompt_too_long 错误，尝试反应式压缩');
          const chatConfig = deps.chatService.getConfig();
          const result = await reactiveCompaction.tryReactiveCompact(
            context.messages,
            {
              modelName: chatConfig.model,
              maxContextTokens: chatConfig.maxContextTokens ?? deps.config.maxContextTokens,
              apiKey: chatConfig.apiKey,
              baseURL: chatConfig.baseUrl,
              signal: options?.signal,
            }
          );
          if (result.success) {
            context.messages = result.messages;
            // 同步到 state（此时 pending 已被 writeback() commit，为空）
            state.replaceHistory(context.messages);
            logger.info('[Loop] 反应式压缩成功，重试 LLM 调用');
            turnsCount--;
            continue; // Retry the turn
          }
        }
        throw llmError; // Re-throw if not recoverable
      }

      // Token 使用量
      if (turnResult.usage) {
        if (turnResult.usage.totalTokens) {
          totalTokens += turnResult.usage.totalTokens;
        }
        lastPromptTokens = turnResult.usage.promptTokens;
        yield {
          kind: 'token_usage',
          usage: {
            inputTokens: turnResult.usage.promptTokens ?? 0,
            outputTokens: turnResult.usage.completionTokens ?? 0,
            totalTokens: turnResult.usage.totalTokens ?? 0,
            maxContextTokens: deps.currentModelMaxContextTokens,
          },
        };
      }

      // Record output for token budget tracking
      const outputTokens = turnResult.usage?.completionTokens ?? 0;
      budgetTracker = recordOutput(budgetTracker, outputTokens, maxOutputRecoveryCount > 0);

      if (options?.signal?.aborted) {
        return makeAbortResult(turnsCount - 1, allToolResults.length, startTime, options.signal);
      }

      // Content 通知 — delta 是唯一内容信号
      // - 正常流式：delta 已在 processStreamResponse 中逐 chunk yield
      // - 非流式 fallback / 纯非流式：补发单个完整内容的 delta
      const needsDelta = !isStreamEnabled || !!(turnResult as StreamResponseResult)._nonStreamingFallback;
      if (needsDelta) {
        if (turnResult.reasoningContent && turnResult.reasoningContent.trim()) {
          yield { kind: 'thinking_delta', delta: turnResult.reasoningContent };
        }
        if (turnResult.content && turnResult.content.trim()) {
          yield { kind: 'content_delta', delta: turnResult.content };
        }
      }
      // stream_end 作为 per-turn 无条件终止信号，即使 content 和 thinking 都为空
      // （例如空 content + tool_calls 场景），消费者依赖此信号结束 turn 渲染
      yield { kind: 'stream_end' };


      // Max output tokens recovery (via completionPolicy)
      const recoveryAction = checkOutputRecovery(
        turnResult.finishReason,
        maxOutputRecoveryCount,
        budgetTracker,
      );

      if (recoveryAction.action === 'recover') {
        maxOutputRecoveryCount++;
        logger.warn(
          `[Loop] Max output tokens hit (recovery ${maxOutputRecoveryCount}/3)`
        );

        // Add the truncated assistant message to history
        const truncatedAssistantMsg: Message = {
          role: 'assistant',
          content: turnResult.content || '',
          reasoningContent: turnResult.reasoningContent,
          tool_calls: turnResult.toolCalls,
        };
        state.appendToHistory(truncatedAssistantMsg);

        // JSONL 持久化：确保 resume 时能恢复此 assistant 消息
        const recoveryAssistantUuid = await saveAssistantMessage(
          deps, context, turnResult.content || '', lastMessageUuid,
        );
        if (recoveryAssistantUuid) lastMessageUuid = recoveryAssistantUuid;

        // Inject recovery prompt
        const recoveryMsg: Message = {
          role: 'user',
          content:
            'Output token limit hit. Resume directly — no apology, no recap. ' +
            'Pick up mid-thought if that is where the cut happened. ' +
            'Break remaining work into smaller pieces.',
        };
        state.appendToHistory(recoveryMsg);

        // JSONL 持久化：确保 resume 时能恢复此 recovery prompt
        const recoveryUserUuid = await saveUserMessage(deps, context, recoveryMsg.content as string, lastMessageUuid);
        if (recoveryUserUuid) lastMessageUuid = recoveryUserUuid;

        continue; // Retry the turn
      }

      if (recoveryAction.action === 'truncated' || recoveryAction.action === 'budget_stop') {
        // 截断：recovery 达上限或 budget 递减收益，标记截断并正常结束
        // 必须将最终 assistant 消息写入 state，确保 writeback 时 context.messages 包含它
        state.appendAssistant({
          role: 'assistant',
          content: turnResult.content || '',
          reasoningContent: turnResult.reasoningContent,
          tool_calls: turnResult.toolCalls,
        });

        const uuid = await saveAssistantMessage(
          deps, context, turnResult.content || '', lastMessageUuid,
        );
        if (uuid) lastMessageUuid = uuid;

        return {
          success: true,
          finalMessage: turnResult.content,
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
            tokensUsed: totalTokens,
            outputTruncated: true,
          },
        };
      }

      if (turnResult.finishReason !== 'length') {
        // Reset recovery counter on normal completion to prevent drift
        maxOutputRecoveryCount = 0;
      }

      // 5. 检查是否需要工具调用
      if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
        // 意图未完成检测 (via completionPolicy)
        const intentAction = checkIncompleteIntent(
          turnResult.content,
          incompleteIntentRetryCount,
        );

        if (intentAction.action === 'retry') {
          incompleteIntentRetryCount++;
          // assistant 输出与 retry 控制消息必须走同一条 pending 队列，保证下一轮看到的时序正确
          state.appendAssistant({
            role: 'assistant',
            content: turnResult.content || '',
            reasoningContent: turnResult.reasoningContent,
          });

          // JSONL 持久化：确保 resume 时能恢复此 assistant 消息
          const retryAssistantUuid = await saveAssistantMessage(
            deps, context, turnResult.content || '', lastMessageUuid,
          );
          if (retryAssistantUuid) lastMessageUuid = retryAssistantUuid;

          const retryMsg: Message = { role: 'user', content: intentAction.prompt };
          state.appendControl('user', retryMsg);

          // JSONL 持久化：确保 resume 时能恢复此 retry prompt
          const retryUserUuid = await saveUserMessage(deps, context, retryMsg.content as string, lastMessageUuid);
          if (retryUserUuid) lastMessageUuid = retryUserUuid;

          continue;
        }

        // 正常完成时归零 incompleteIntentRetryCount
        incompleteIntentRetryCount = 0;

        // Ralph Loop: Spec 未完成任务时自动继续
        const ralphAction = await checkRalphLoop({
          turnsCount,
          maxTurns,
        });
        if (ralphAction.action === 'continue') {
          state.appendAssistant({
            role: 'assistant',
            content: turnResult.content || '',
            reasoningContent: turnResult.reasoningContent,
          });

          const ralphAssistantUuid = await saveAssistantMessage(
            deps, context, turnResult.content || '', lastMessageUuid,
          );
          if (ralphAssistantUuid) lastMessageUuid = ralphAssistantUuid;

          const ralphMsg: Message = {
            role: 'user',
            content: `\n\n<system-reminder>\n${ralphAction.reason}\n</system-reminder>`,
          };
          state.appendControl('user', ralphMsg);

          const ralphUserUuid = await saveUserMessage(
            deps, context, ralphMsg.content as string, lastMessageUuid,
          );
          if (ralphUserUuid) lastMessageUuid = ralphUserUuid;

          continue;
        }

        // Stop Hook (via completionPolicy, with timeout)
        const stopAction = await checkStopHook({
          sessionId: context.sessionId,
          permissionMode: context.permissionMode as PermissionMode,
          reason: turnResult.content,
          abortSignal: options?.signal,
        });

        if (stopAction.action === 'continue') {
          // assistant 输出与 continue 控制消息必须走同一条 pending 队列，保证下一轮看到的时序正确
          state.appendAssistant({
            role: 'assistant',
            content: turnResult.content || '',
            reasoningContent: turnResult.reasoningContent,
          });

          // JSONL 持久化：确保 resume 时能恢复此 assistant 消息
          const continueAssistantUuid = await saveAssistantMessage(
            deps, context, turnResult.content || '', lastMessageUuid,
          );
          if (continueAssistantUuid) lastMessageUuid = continueAssistantUuid;

          const continueMessage = stopAction.reason
            ? `\n\n<system-reminder>\n${stopAction.reason}\n</system-reminder>`
            : '\n\n<system-reminder>\nPlease continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.\n</system-reminder>';
          const continueMsg: Message = { role: 'user', content: continueMessage };
          state.appendControl('user', continueMsg);

          // JSONL 持久化：确保 resume 时能恢复此 continue prompt
          const continueUserUuid = await saveUserMessage(deps, context, continueMsg.content as string, lastMessageUuid);
          if (continueUserUuid) lastMessageUuid = continueUserUuid;

          continue;
        }

        // 保存助手最终响应到 JSONL
        // 必须将最终 assistant 消息写入 state，确保 writeback 时 context.messages 包含它
        state.appendAssistant({
          role: 'assistant',
          content: turnResult.content || '',
          reasoningContent: turnResult.reasoningContent,
        });

        const uuid = await saveAssistantMessage(
          deps, context, turnResult.content || '', lastMessageUuid,
        );
        if (uuid) lastMessageUuid = uuid;

        return {
          success: true,
          finalMessage: turnResult.content,
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
            tokensUsed: totalTokens,
          },
        };
      }

      // 6. 添加 LLM 响应到消息历史
      state.appendAssistant({
        role: 'assistant',
        content: turnResult.content || '',
        reasoningContent: turnResult.reasoningContent,
        tool_calls: turnResult.toolCalls,
      });

      // 保存助手工具调用请求到 JSONL
      {
        const uuid = await saveAssistantMessage(
          deps, context, turnResult.content || '', lastMessageUuid,
        );
        if (uuid) lastMessageUuid = uuid;
      }

      // 7. 执行工具
      if (options?.signal?.aborted) {
        return makeAbortResult(turnsCount, allToolResults.length, startTime, options.signal);
      }

      const functionCalls = turnResult.toolCalls.filter(
        (tc) => tc.type === 'function'
      );

      // 使用 StreamingToolExecutor 或 Promise.all 执行工具
      let executionResults: Array<{
        toolCall: ToolCallRef;
        result: import('../../tools/types/index.js').ToolResult;
        toolUseUuid: string | null;
        error?: Error;
      }>;

      if (streamingExecutor?.hasTools()) {
        // 流式模式：工具已在流式中开始执行，收集结果
        // tool_start 事件已在 processStreamResponse 中 yield
        logger.debug(
          `[Loop] 使用 StreamingToolExecutor 收集 ${functionCalls.length} 个工具结果`
        );
        executionResults = [];
        for await (const execResult of streamingExecutor.getRemainingResults()) {
          executionResults.push(execResult);
        }
      } else {
        // 非流式模式或 fallback：传统 Promise.all 执行
        // Yield tool_start 事件
        for (const toolCall of functionCalls) {
          const toolDef = registry.get(toolCall.function.name);
          const toolKind = toolDef?.kind as
            | 'readonly'
            | 'write'
            | 'execute'
            | undefined;
          yield {
            kind: 'tool_start',
            toolCall: toolCall as ToolCallRef,
            toolKind,
          };
        }

        // 并行执行所有工具
        const executeToolCall = async (
          toolCall: (typeof functionCalls)[0]
        ) => {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            if (
              toolCall.function.name === 'Task' &&
              (typeof params.subagent_session_id !== 'string' ||
                params.subagent_session_id.length === 0)
            ) {
              params.subagent_session_id =
                typeof params.resume === 'string' && params.resume.length > 0
                  ? params.resume
                  : nanoid();
            }
            let toolUseUuid: string | null = null;
            toolUseUuid = await saveToolUse(
              deps, context, toolCall.function.name, params, lastMessageUuid,
            );

            const result = await deps.executionPipeline.execute(
              toolCall.function.name,
              params,
              {
                sessionId: context.sessionId,
                userId: context.userId || 'default',
                workspaceRoot: context.workspaceRoot || getCwd(),
                signal: options?.signal,
                confirmationHandler: context.confirmationHandler,
                permissionMode: context.permissionMode,
                toolRegistry: registry,
                deferredToolManager:
                  registry.deferredToolManager,
              }
            );
            return { toolCall, result, toolUseUuid };
          } catch (error) {
            logger.error(
              `Tool execution failed for ${toolCall.function.name}:`,
              error
            );
            return {
              toolCall,
              result: {
                success: false,
                llmContent: '',
                error: {
                  type: ToolErrorType.EXECUTION_ERROR,
                  message:
                    error instanceof Error ? error.message : 'Unknown error',
                },
                metadata: undefined,
              } as import('../../tools/types/index.js').ToolResult,
              toolUseUuid: null,
              error: error instanceof Error ? error : new Error('Unknown error'),
            };
          }
        };

        executionResults = await Promise.all(
          functionCalls.map(executeToolCall)
        );
      }

      // 8. 处理执行结果
      const messageBudget = new MessageBudgetTracker();
      for (const { toolCall: rawToolCall, result, toolUseUuid } of executionResults) {
        // 安全断言：所有 toolCall 都是 function 类型
        const toolCall = rawToolCall as {
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        };
        allToolResults.push(result);

        // 如果工具未实际执行就被 abort（如排队工具 skip、确认阶段 abort），
        // 跳过 yield/持久化/appendToolResult，避免在历史中留下无意义的失败记录。
        // 注意：只检查 abortedBeforeLaunch，不会误伤正常的 shouldExitLoop 结果
        // （如 ExitPlanModeTool 带 targetMode/planContent 的合法退出）。
        if (result.metadata?.abortedBeforeLaunch) {
          return makeAbortResult(turnsCount, allToolResults.length, startTime, options?.signal);
        }

        // Yield tool_result 事件
        yield {
          kind: 'tool_result',
          toolCall: toolCall as ToolCallRef,
          result,
        };

        // 保存 tool_result 到 JSONL (via conversationPersistence)
        {
          const metadata =
            result.metadata && typeof result.metadata === 'object'
              ? (result.metadata as Record<string, unknown>)
              : undefined;
          const isSubagentStatus = (
            value: unknown
          ): value is
            | 'running'
            | 'completed'
            | 'failed'
            | 'cancelled' =>
            value === 'running' ||
            value === 'completed' ||
            value === 'failed' ||
            value === 'cancelled';
          const subagentStatus = isSubagentStatus(metadata?.subagentStatus)
            ? metadata.subagentStatus
            : 'completed';
          const subagentRef =
            metadata && typeof metadata.subagentSessionId === 'string'
              ? {
                  subagentSessionId: metadata.subagentSessionId,
                  subagentType:
                    typeof metadata.subagentType === 'string'
                      ? metadata.subagentType
                      : toolCall.function.name,
                  subagentStatus,
                  subagentSummary:
                    typeof metadata.subagentSummary === 'string'
                      ? metadata.subagentSummary
                      : undefined,
                }
              : undefined;
          const uuid = await persistToolResult(
            deps,
            context,
            toolCall.id,
            toolCall.function.name,
            result.success ? toJsonValue(result.llmContent) : null,
            toolUseUuid,
            result.success ? undefined : result.error?.message,
            subagentRef,
          );
          if (uuid) lastMessageUuid = uuid;
        }

        // 领域副作用 (via toolDomainPolicy)
        const taskAction = await applyToolDomainEffects(
          toolCall as FunctionToolCallRef,
          result,
          deps,
        );
        if (taskAction) {
          yield taskAction;
        }

        // 添加工具结果到消息历史
        let toolResultContent = result.success
          ? result.llmContent || ''
          : result.error?.message || '执行失败';
        if (
          typeof toolResultContent === 'object' &&
          toolResultContent !== null
        ) {
          toolResultContent = JSON.stringify(toolResultContent, null, 2);
        }

        // Apply tool result budget — per-tool + per-message 截断
        if (typeof toolResultContent === 'string') {
          toolResultContent = applyToolResultBudget(
            toolResultContent,
            toolCall.function.name,
            { messageBudget },
          ) as string;
        }

        const finalContent =
          typeof toolResultContent === 'string'
            ? toolResultContent
            : JSON.stringify(toolResultContent);
        state.appendToolResult({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: finalContent,
        });

        // shouldExitLoop 检查
        if (result.metadata?.shouldExitLoop) {
          const finalMessage =
            typeof result.llmContent === 'string'
              ? result.llmContent
              : '循环已退出';
          return {
            success: result.success,
            finalMessage,
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
              shouldExitLoop: true,
              targetMode: result.metadata?.targetMode,
              planContent:
                typeof result.metadata?.planContent === 'string'
                  ? result.metadata.planContent
                  : undefined,
            },
          };
        }
      }

      // 检查工具执行后的中断信号
      if (options?.signal?.aborted) {
        return makeAbortResult(turnsCount, allToolResults.length, startTime, options.signal);
      }

      // 9. 检查轮次上限
      if (turnsCount >= maxTurns && !isYoloMode) {
        logger.info(`Warning: 达到轮次上限 ${maxTurns} 轮`);

        if (options?.onTurnLimitReached) {
          const response = await options.onTurnLimitReached({ turnsCount });

          if (response?.continue) {
            // 用户选择继续，压缩上下文
            // 先同步 state 到 context，确保压缩读取到完整历史
            state.writeback();
            try {
              const chatConfig = deps.chatService.getConfig();
              const compactResult = await CompactionService.compact(
                context.messages,
                {
                  trigger: 'auto',
                  modelName: chatConfig.model,
                  maxContextTokens:
                    chatConfig.maxContextTokens ?? deps.config.maxContextTokens,
                  apiKey: chatConfig.apiKey,
                  baseURL: chatConfig.baseUrl,
                  actualPreTokens: lastPromptTokens,
                  signal: options?.signal,
                }
              );

              context.messages = compactResult.compactedMessages;
              state.replaceHistory(context.messages);

              const continueMessage: Message = {
                role: 'user',
                content:
                  'This session is being continued from a previous conversation. ' +
                  'The conversation is summarized above.\n\n' +
                  'Please continue the conversation from where we left it off without asking the user any further questions. ' +
                  'Continue with the last task that you were asked to work on.',
              };
              state.appendToHistory(continueMessage);

              // 保存压缩数据到 JSONL
              await persistCompaction(deps, context, compactResult.summary, {
                trigger: 'auto',
                preTokens: compactResult.preTokens,
                postTokens: compactResult.postTokens,
                filesIncluded: compactResult.filesIncluded,
              });
            } catch (compactError) {
              // 降级处理：保留最近 80 条消息
              logger.error('[Loop] 压缩失败，使用降级策略:', compactError);
              const currentHistory = state.getHistory();
              const recentHistory = currentHistory.slice(-80);
              state.replaceHistory(recentHistory);
            }

            turnsCount = 0;
            continue;
          }

          // 用户选择停止
          return {
            success: true,
            finalMessage:
              response?.reason || '已达到对话轮次上限，用户选择停止',
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
              tokensUsed: totalTokens,
            },
          };
        }

        // 非交互模式
        return {
          success: false,
          error: {
            type: 'max_turns_exceeded',
            message: `已达到轮次上限 (${maxTurns} 轮)。使用 --permission-mode yolo 跳过此限制。`,
          },
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
            tokensUsed: totalTokens,
          },
        };
      }

      // 继续下一轮循环...
    }
    } finally {
      // 确保所有退出路径都将消息回写到 context.messages
      state.writeback();
    }
  } catch (error) {
    if (isAbortError(error)) {
      return makeAbortResult(turnsCount, allToolResults.length, startTime, options?.signal);
    }
    const friendlyMessage = extractApiErrorMessage(error);
    logger.error(`API 调用失败: ${friendlyMessage}`);
    return {
      success: false,
      error: { type: 'api_error', message: friendlyMessage, details: error },
      metadata: { turnsCount, toolCallsCount: allToolResults.length, duration: Date.now() - startTime },
    };
  }
}
