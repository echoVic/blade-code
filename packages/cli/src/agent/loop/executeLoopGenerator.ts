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
import { applyToolResultBudget } from '../../context/ToolResultBudget.js';
import { checkTokenBudget, createBudgetTracker, recordOutput } from '../../context/TokenBudget.js';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import type {
  ChatResponse,
  Message,
  StreamToolCall,
} from '../../services/ChatServiceInterface.js';
import { injectSkillsMetadata } from '../../skills/index.js';
import type { JsonValue } from '../../store/types.js';
import { ToolErrorType } from '../../tools/types/index.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from '../types.js';
import { StreamingToolExecutor } from './StreamingToolExecutor.js';
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
    (error as any).status === 413
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

async function processStreamResponse(
  deps: LoopDependencies,
  messages: Message[],
  tools: Array<{ name: string; description: string; parameters: unknown }>,
  signal?: AbortSignal,
  executor?: StreamingToolExecutor
): Promise<{ response: ChatResponse; events: LoopEvent[] }> {
  let fullContent = '';
  let fullReasoningContent = '';
  let streamUsage: ChatResponse['usage'];
  let streamFinishReason: string | undefined;
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  const events: LoopEvent[] = [];

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
        events.length = 0;
        continue;
      }

      if (chunk.content) {
        fullContent += chunk.content;
        events.push({ type: 'content_delta', delta: chunk.content });
      }
      if (chunk.reasoningContent) {
        fullReasoningContent += chunk.reasoningContent;
        events.push({ type: 'thinking_delta', delta: chunk.reasoningContent });
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
                events.push({ type: 'tool_start', toolCall, toolKind });
                executor.addTool(toolCall, params);
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
      const response = await deps.chatService.chat(messages, tools, signal);
      return { response, events: [] };
    }

    return {
      response: {
        content: fullContent,
        reasoningContent: fullReasoningContent || undefined,
        toolCalls: buildFinalToolCalls(toolCallAccumulator),
        usage: streamUsage,
        finishReason: streamFinishReason,
      },
      events,
    };
  } catch (error) {
    if (isStreamingNotSupportedError(error)) {
      logger.warn('[Loop] 流式请求失败，降级到非流式模式');
      executor?.discard();
      const response = await deps.chatService.chat(messages, tools, signal);
      return { response, events: [] };
    }
    throw error;
  }
}

// ===== checkAndCompactInLoop (extracted from Agent.ts) =====

export async function checkAndCompactInLoop(
  deps: LoopDependencies,
  context: ChatContext,
  currentTurn: number,
  actualPromptTokens?: number
): Promise<boolean> {
  if (actualPromptTokens === undefined) {
    logger.debug(
      `[Loop] [轮次 ${currentTurn}] 压缩检查: 跳过（无历史 usage 数据）`
    );
    return false;
  }

  // Level 1: Snip compaction — 轻量截断旧工具调用，无 LLM 调用
  const snipResult = snipCompact(context.messages);
  if (snipResult.snippedCount > 0) {
    context.messages = snipResult.messages;
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

  if (actualPromptTokens < threshold) return false;

  logger.debug(
    currentTurn === 0
      ? '[Loop] 触发自动压缩'
      : `[Loop] [轮次 ${currentTurn}] 触发循环内自动压缩`
  );

  try {
    const result = await CompactionService.compact(context.messages, {
      trigger: 'auto',
      modelName,
      maxContextTokens,
      apiKey: chatConfig.apiKey,
      baseURL: chatConfig.baseUrl,
      actualPreTokens: actualPromptTokens,
    });

    context.messages = result.compactedMessages;
    if (result.success) {
      logger.debug(
        `[Loop] [轮次 ${currentTurn}] 压缩完成: ${result.preTokens} → ${result.postTokens} tokens`
      );
    } else {
      logger.warn(
        `[Loop] [轮次 ${currentTurn}] 压缩使用降级策略: ${result.preTokens} → ${result.postTokens} tokens`
      );
    }

    // 保存压缩数据到 JSONL
    try {
      const contextMgr = deps.executionEngine?.getContextManager();
      if (contextMgr && context.sessionId) {
        await contextMgr.saveCompaction(
          context.sessionId,
          result.summary,
          {
            trigger: 'auto',
            preTokens: result.preTokens,
            postTokens: result.postTokens,
            filesIncluded: result.filesIncluded,
          },
          null
        );
      }
    } catch (saveError) {
      logger.warn(`[Loop] [轮次 ${currentTurn}] 保存压缩数据失败:`, saveError);
    }

    return true;
  } catch (error) {
    logger.error(`[Loop] [轮次 ${currentTurn}] 压缩失败，继续执行`, error);
    return false;
  }
}

// ===== Main Generator =====

export async function* executeLoopGenerator(
  deps: LoopDependencies,
  message: UserMessageContent,
  context: ChatContext,
  options: LoopOptions | undefined,
  systemPrompt: string | undefined
): AsyncGenerator<LoopEvent, LoopResult, void> {
  const startTime = Date.now();

  try {
    // 1. 获取可用工具定义
    const registry = deps.executionPipeline.getRegistry();
    const permissionMode = context.permissionMode as PermissionMode | undefined;
    let rawTools = registry.getFunctionDeclarationsByMode(permissionMode);
    rawTools = injectSkillsMetadata(rawTools);
    const tools = deps.applySkillToolRestrictions(rawTools);

    // 2. 构建消息历史
    const needsSystemPrompt =
      context.messages.length === 0 ||
      !context.messages.some((msg) => msg.role === 'system');

    const messages: Message[] = [];
    if (needsSystemPrompt && systemPrompt) {
      messages.push({
        role: 'system',
        content: [
          {
            type: 'text',
            text: systemPrompt,
            providerOptions: {
              anthropic: { cacheControl: { type: 'ephemeral' } },
            },
          },
        ],
      });
    }
    messages.push(...context.messages, { role: 'user', content: message });

    // 保存用户消息到 JSONL
    let lastMessageUuid: string | null = null;
    try {
      const contextMgr = deps.executionEngine?.getContextManager();
      const hasPersistableContent =
        typeof message === 'string'
          ? message.trim() !== ''
          : message.some((part) =>
              part.type === 'text' ? part.text.trim() !== '' : true
            );
      if (contextMgr && context.sessionId && hasPersistableContent) {
        lastMessageUuid = await contextMgr.saveMessage(
          context.sessionId,
          'user',
          message,
          null,
          undefined,
          context.subagentInfo
        );
      }
    } catch (error) {
      logger.warn('[Loop] 保存用户消息失败:', error);
    }

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

    let turnsCount = 0;
    const allToolResults: import('../../tools/types/index.js').ToolResult[] = [];
    let totalTokens = 0;
    let lastPromptTokens: number | undefined;
    let maxOutputRecoveryCount = 0;

    const isSubagent = !!context.subagentInfo;
    let budgetTracker = createBudgetTracker({
      budget: deps.currentModelMaxContextTokens,
      isSubagent,
    });

    const reactiveCompaction = new ReactiveCompaction();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 1. 检查中断信号
      if (options?.signal?.aborted) {
        return {
          success: false,
          error: { type: 'aborted', message: '任务已被用户中止' },
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
          },
        };
      }

      // 2. 上下文压缩检查
      const preCompactLength = context.messages.length;
      const didCompact = await checkAndCompactInLoop(
        deps,
        context,
        turnsCount,
        lastPromptTokens
      );

      if (didCompact) {
        yield { type: 'compaction_start' } as LoopEvent;
        yield { type: 'compaction_end' } as LoopEvent;
        const systemMsgCount = needsSystemPrompt && systemPrompt ? 1 : 0;
        const historyEndIdx = systemMsgCount + preCompactLength;
        const systemMessages = messages.slice(0, systemMsgCount);
        const newMessages = messages.slice(historyEndIdx);
        messages.length = 0;
        messages.push(...systemMessages, ...context.messages, ...newMessages);
      }

      // 3. 轮次计数
      turnsCount++;
      reactiveCompaction.reset();
      yield { type: 'turn_start', turn: turnsCount, maxTurns } as LoopEvent;

      if (options?.signal?.aborted) {
        return {
          success: false,
          error: { type: 'aborted', message: '任务已被用户中止' },
          metadata: {
            turnsCount: turnsCount - 1,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
          },
        };
      }

      // 4. 调用 LLM
      const isStreamEnabled = options?.stream !== false;
      let turnResult: ChatResponse;
      let streamingExecutor: StreamingToolExecutor | undefined;

      try {
        if (isStreamEnabled) {
          streamingExecutor = new StreamingToolExecutor(
            deps.executionPipeline,
            {
              sessionId: context.sessionId,
              userId: context.userId || 'default',
              workspaceRoot: context.workspaceRoot || process.cwd(),
              signal: options?.signal,
              confirmationHandler: context.confirmationHandler,
              permissionMode: context.permissionMode,
            },
            deps.executionPipeline.getRegistry(),
            deps.executionEngine?.getContextManager(),
            context.sessionId,
            lastMessageUuid,
            context.subagentInfo
          );

          const { response, events } = await processStreamResponse(
            deps,
            messages,
            tools,
            options?.signal,
            streamingExecutor
          );
          // Yield 所有流式事件（content_delta, thinking_delta, tool_start）
          for (const event of events) {
            yield event;
          }
          turnResult = response;
        } else {
          turnResult = await deps.chatService.chat(
            messages,
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
            }
          );
          if (result.success) {
            context.messages = result.messages;
            const systemMsgCount = needsSystemPrompt && systemPrompt ? 1 : 0;
            const systemMessages = messages.slice(0, systemMsgCount);
            messages.length = 0;
            messages.push(...systemMessages, ...context.messages);
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
          type: 'token_usage',
          usage: {
            inputTokens: turnResult.usage.promptTokens ?? 0,
            outputTokens: turnResult.usage.completionTokens ?? 0,
            totalTokens,
            maxContextTokens: deps.currentModelMaxContextTokens,
          },
        } as LoopEvent;
      }

      // Record output for token budget tracking
      const outputTokens = turnResult.usage?.completionTokens ?? 0;
      budgetTracker = recordOutput(budgetTracker, outputTokens, maxOutputRecoveryCount > 0);

      if (options?.signal?.aborted) {
        return {
          success: false,
          error: { type: 'aborted', message: '任务已被用户中止' },
          metadata: {
            turnsCount: turnsCount - 1,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
          },
        };
      }

      // Thinking 内容（非流式模式）
      if (turnResult.reasoningContent && !isStreamEnabled) {
        yield { type: 'thinking', content: turnResult.reasoningContent } as LoopEvent;
      }

      // Content 通知
      if (turnResult.content && turnResult.content.trim()) {
        if (isStreamEnabled) {
          yield { type: 'stream_end' } as LoopEvent;
        } else {
          yield { type: 'content', content: turnResult.content } as LoopEvent;
        }
      }


      // Max output tokens recovery
      const MAX_OUTPUT_RECOVERY_LIMIT = 3;
      if (
        turnResult.finishReason === 'length' &&
        maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT
      ) {
        if (checkTokenBudget(budgetTracker) === 'stop') {
          logger.info('[Loop] Token budget: diminishing returns detected, skipping recovery');
        } else {
          maxOutputRecoveryCount++;
          logger.warn(
            `[Loop] Max output tokens hit (recovery ${maxOutputRecoveryCount}/${MAX_OUTPUT_RECOVERY_LIMIT})`
          );

          // Add the truncated assistant message to history
          const truncatedAssistantMsg: Message = {
            role: 'assistant',
            content: turnResult.content || '',
            reasoningContent: turnResult.reasoningContent,
            tool_calls: turnResult.toolCalls,
          };
          messages.push(truncatedAssistantMsg);
          context.messages.push(truncatedAssistantMsg);

          // Inject recovery prompt
          const recoveryMsg: Message = {
            role: 'user',
            content:
              'Output token limit hit. Resume directly — no apology, no recap. ' +
              'Pick up mid-thought if that is where the cut happened. ' +
              'Break remaining work into smaller pieces.',
          };
          messages.push(recoveryMsg);
          context.messages.push(recoveryMsg);

          continue; // Retry the turn
        }
      }

      // 5. 检查是否需要工具调用
      if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
        // 意图未完成检测
        const INCOMPLETE_INTENT_PATTERNS = [
          /：\s*$/,
          /:\s*$/,
          /\.\.\.\s*$/,
          /让我(先|来|开始|查看|检查|修复)/,
          /Let me (first|start|check|look|fix)/i,
        ];
        const content = turnResult.content || '';
        const isIncompleteIntent = INCOMPLETE_INTENT_PATTERNS.some((p) =>
          p.test(content)
        );
        const RETRY_PROMPT = '请执行你提到的操作，不要只是描述。';
        const recentRetries = messages
          .slice(-10)
          .filter((m) => m.role === 'user' && m.content === RETRY_PROMPT).length;

        if (isIncompleteIntent && recentRetries < 2) {
          const retryMsg: Message = { role: 'user', content: RETRY_PROMPT };
          messages.push(retryMsg);
          context.messages.push(retryMsg);
          continue;
        }

        // Stop Hook
        try {
          const hookManager = HookManager.getInstance();
          const stopResult = await hookManager.executeStopHooks({
            projectDir: process.cwd(),
            sessionId: context.sessionId,
            permissionMode: context.permissionMode as PermissionMode,
            reason: turnResult.content,
            abortSignal: options?.signal,
          });

          if (!stopResult.shouldStop) {
            const continueMessage = stopResult.continueReason
              ? `\n\n<system-reminder>\n${stopResult.continueReason}\n</system-reminder>`
              : '\n\n<system-reminder>\nPlease continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.\n</system-reminder>';
            const continueMsg: Message = { role: 'user', content: continueMessage };
            messages.push(continueMsg);
            context.messages.push(continueMsg);
            continue;
          }
        } catch (hookError) {
          logger.warn('[Loop] Stop hook execution failed:', hookError);
        }

        // 保存助手最终响应到 JSONL
        try {
          const contextMgr = deps.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId && turnResult.content?.trim()) {
            lastMessageUuid = await contextMgr.saveMessage(
              context.sessionId,
              'assistant',
              turnResult.content,
              lastMessageUuid,
              undefined,
              context.subagentInfo
            );
          }
        } catch (error) {
          logger.warn('[Loop] 保存助手消息失败:', error);
        }

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
      messages.push({
        role: 'assistant',
        content: turnResult.content || '',
        reasoningContent: turnResult.reasoningContent,
        tool_calls: turnResult.toolCalls,
      });

      // 保存助手工具调用请求到 JSONL
      try {
        const contextMgr = deps.executionEngine?.getContextManager();
        if (contextMgr && context.sessionId && turnResult.content?.trim()) {
          lastMessageUuid = await contextMgr.saveMessage(
            context.sessionId,
            'assistant',
            turnResult.content,
            lastMessageUuid,
            undefined,
            context.subagentInfo
          );
        }
      } catch (error) {
        logger.warn('[Loop] 保存助手工具调用消息失败:', error);
      }

      // 7. 执行工具
      if (options?.signal?.aborted) {
        return {
          success: false,
          error: { type: 'aborted', message: '任务已被用户中止' },
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
          },
        };
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
            type: 'tool_start',
            toolCall: toolCall as ToolCallRef,
            toolKind,
          } as LoopEvent;
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
            if (params.todos && typeof params.todos === 'string') {
              try {
                params.todos = JSON.parse(params.todos);
              } catch {
                // 由验证层处理
              }
            }

            let toolUseUuid: string | null = null;
            try {
              const contextMgr = deps.executionEngine?.getContextManager();
              if (contextMgr && context.sessionId) {
                toolUseUuid = await contextMgr.saveToolUse(
                  context.sessionId,
                  toolCall.function.name,
                  params,
                  lastMessageUuid,
                  context.subagentInfo
                );
              }
            } catch (err) {
              logger.warn('[Loop] 保存工具调用失败:', err);
            }

            const result = await deps.executionPipeline.execute(
              toolCall.function.name,
              params,
              {
                sessionId: context.sessionId,
                userId: context.userId || 'default',
                workspaceRoot: context.workspaceRoot || process.cwd(),
                signal: options?.signal,
                confirmationHandler: context.confirmationHandler,
                permissionMode: context.permissionMode,
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
                displayContent: '',
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
      for (const { toolCall: rawToolCall, result, toolUseUuid } of executionResults) {
        // 安全断言：所有 toolCall 都是 function 类型
        const toolCall = rawToolCall as {
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        };
        allToolResults.push(result);

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
            },
          };
        }

        // Yield tool_result 事件
        yield {
          type: 'tool_result',
          toolCall: toolCall as ToolCallRef,
          result,
        } as LoopEvent;

        // 保存 tool_result 到 JSONL
        try {
          const contextMgr = deps.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId) {
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
            lastMessageUuid = await contextMgr.saveToolResult(
              context.sessionId,
              toolCall.id,
              toolCall.function.name,
              result.success ? toJsonValue(result.llmContent) : null,
              toolUseUuid,
              result.success ? undefined : result.error?.message,
              context.subagentInfo,
              subagentRef
            );
          }
        } catch (err) {
          logger.warn('[Loop] 保存工具结果失败:', err);
        }

        // TodoWrite 处理
        if (
          toolCall.function.name === 'TodoWrite' &&
          result.success &&
          result.llmContent
        ) {
          const content =
            typeof result.llmContent === 'object' ? result.llmContent : {};
          const todos = Array.isArray(content)
            ? content
            : ((content as Record<string, unknown>).todos as unknown[]) || [];
          yield {
            type: 'todo_update',
            todos: todos as import('../../tools/builtin/todo/types.js').TodoItem[],
          } as LoopEvent;
        }

        // Skill 激活
        if (
          toolCall.function.name === 'Skill' &&
          result.success &&
          result.metadata
        ) {
          const metadata = result.metadata as Record<string, unknown>;
          if (metadata.skillName) {
            deps.onSkillActivated?.({
              skillName: metadata.skillName as string,
              allowedTools: metadata.allowedTools as string[] | undefined,
              basePath: (metadata.basePath as string) || '',
            });
          }
        }

        // 模型切换
        const modelId =
          (result.metadata as Record<string, unknown>)?.modelId?.toString().trim() ||
          (result.metadata as Record<string, unknown>)?.model?.toString().trim() ||
          undefined;
        if (modelId) {
          await deps.onModelSwitch?.(modelId);
        }

        // 添加工具结果到消息历史
        let toolResultContent = result.success
          ? result.llmContent || result.displayContent || ''
          : result.error?.message || '执行失败';
        if (
          typeof toolResultContent === 'object' &&
          toolResultContent !== null
        ) {
          toolResultContent = JSON.stringify(toolResultContent, null, 2);
        }

        // Apply tool result budget — truncate oversized results
        if (typeof toolResultContent === 'string' && toolResultContent.length > 100_000) {
          toolResultContent = applyToolResultBudget(
            toolResultContent,
            toolCall.function.name
          ) as string;
        }

        const finalContent =
          typeof toolResultContent === 'string'
            ? toolResultContent
            : JSON.stringify(toolResultContent);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: finalContent,
        });
      }

      // 检查工具执行后的中断信号
      if (options?.signal?.aborted) {
        return {
          success: false,
          error: { type: 'aborted', message: '任务已被用户中止' },
          metadata: {
            turnsCount,
            toolCallsCount: allToolResults.length,
            duration: Date.now() - startTime,
          },
        };
      }

      // 9. 检查轮次上限
      if (turnsCount >= maxTurns && !isYoloMode) {
        logger.info(`⚠️ 达到轮次上限 ${maxTurns} 轮`);

        if (options?.onTurnLimitReached) {
          const response = await options.onTurnLimitReached({ turnsCount });

          if (response?.continue) {
            // 用户选择继续，压缩上下文
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
                }
              );

              context.messages = compactResult.compactedMessages;
              const systemMsg = messages.find((m) => m.role === 'system');
              messages.length = 0;
              if (systemMsg) messages.push(systemMsg);
              messages.push(...context.messages);

              const continueMessage: Message = {
                role: 'user',
                content:
                  'This session is being continued from a previous conversation. ' +
                  'The conversation is summarized above.\n\n' +
                  'Please continue the conversation from where we left it off without asking the user any further questions. ' +
                  'Continue with the last task that you were asked to work on.',
              };
              messages.push(continueMessage);
              context.messages.push(continueMessage);

              // 保存压缩数据到 JSONL
              try {
                const contextMgr = deps.executionEngine?.getContextManager();
                if (contextMgr && context.sessionId) {
                  await contextMgr.saveCompaction(
                    context.sessionId,
                    compactResult.summary,
                    {
                      trigger: 'auto',
                      preTokens: compactResult.preTokens,
                      postTokens: compactResult.postTokens,
                      filesIncluded: compactResult.filesIncluded,
                    },
                    null
                  );
                }
              } catch (saveError) {
                logger.warn('[Loop] 保存压缩数据失败:', saveError);
              }
            } catch (compactError) {
              // 降级处理
              logger.error('[Loop] 压缩失败，使用降级策略:', compactError);
              const systemMsg = messages.find((m) => m.role === 'system');
              const recentMessages = messages.slice(-80);
              messages.length = 0;
              if (systemMsg && !recentMessages.some((m) => m.role === 'system')) {
                messages.push(systemMsg);
              }
              messages.push(...recentMessages);
              context.messages = messages.filter((m) => m.role !== 'system');
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
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'))
    ) {
      return {
        success: false,
        error: { type: 'aborted', message: '任务已被用户中止' },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: Date.now() - startTime },
      };
    }
    const friendlyMessage = extractApiErrorMessage(error);
    logger.error(`API 调用失败: ${friendlyMessage}`);
    return {
      success: false,
      error: { type: 'api_error', message: friendlyMessage, details: error },
      metadata: { turnsCount: 0, toolCallsCount: 0, duration: Date.now() - startTime },
    };
  }
}
