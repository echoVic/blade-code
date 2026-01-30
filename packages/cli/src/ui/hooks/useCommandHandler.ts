import { useMemoizedFn } from 'ahooks';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { useEffect, useRef } from 'react';
import { HookManager } from '../../hooks/HookManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { streamDebug } from '../../logging/StreamDebugLogger.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import { safeExit } from '../../services/GracefulShutdown.js';
import type { SessionMetadata } from '../../services/SessionService.js';
import {
  executeSlashCommand,
  isSlashCommand,
  type SlashCommandContext,
} from '../../slash-commands/index.js';
import {
  useAppActions,
  useCommandActions,
  useIsProcessing,
  useMessages,
  usePermissionMode,
  useSessionActions,
  useSessionId,
  useThinkingModeEnabled,
} from '../../store/selectors/index.js';
import { ensureStoreInitialized, getState } from '../../store/vanilla.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import {
  appendMarkdownDelta,
  finalizeMarkdownCache,
} from '../utils/markdownIncremental.js';
import {
  formatToolCallSummary,
  generateToolDetail,
  shouldShowToolDetail,
} from '../utils/toolFormatters.js';
import { useAgent } from './useAgent.js';
import type { ResolvedInput } from './useInputBuffer.js';

// 创建 UI Hook 专用 Logger
const logger = createLogger(LogCategory.UI);

/**
 * invoke_skill action 的数据类型
 */
interface InvokeSkillData {
  action: 'invoke_skill';
  skillName: string;
  skillArgs?: string;
}

/**
 * invoke_custom_command action 的数据类型
 */
interface InvokeCustomCommandData {
  action: 'invoke_custom_command';
  commandName: string;
  processedContent: string;
  config: {
    description?: string;
    allowedTools?: string[];
    argumentHint?: string;
    model?: string;
    disableModelInvocation?: boolean;
  };
}

/**
 * invoke_plugin_command action 的数据类型
 */
interface InvokePluginCommandData {
  action: 'invoke_plugin_command';
  commandName: string;
  pluginName: string;
  processedContent: string;
  config: {
    description?: string;
    allowedTools?: string[];
    argumentHint?: string;
    model?: string;
    disableModelInvocation?: boolean;
  };
}

/**
 * 处理 slash 命令返回的 UI 消息
 * 直接调用 appActions 而非使用 ActionMapper
 *
 * @returns 'handled' | 'invoke_skill' | false
 * - 'handled': 消息已处理完成
 * - 'invoke_skill': 需要调用 Skill（返回 data 供后续处理）
 * - false: 未识别的消息类型
 */
function handleSlashMessage(
  message: string,
  data: unknown,
  appActions: ReturnType<typeof useAppActions>,
  sessionActions: ReturnType<typeof useSessionActions>
): boolean | 'invoke_skill' {
  switch (message) {
    case 'show_theme_selector':
      appActions.setActiveModal('themeSelector');
      return true;
    case 'show_model_selector':
      appActions.setActiveModal('modelSelector');
      return true;
    case 'show_model_add_wizard':
      appActions.setActiveModal('modelAddWizard');
      return true;
    case 'show_permissions_manager':
      appActions.setActiveModal('permissionsManager');
      return true;
    case 'show_agents_manager':
      appActions.setActiveModal('agentsManager');
      return true;
    case 'show_skills_manager':
      appActions.setActiveModal('skillsManager');
      return true;
    case 'show_hooks_manager':
      appActions.setActiveModal('hooksManager');
      return true;
    case 'show_plugins_manager':
      appActions.setActiveModal('pluginsManager');
      return true;
    case 'show_agent_creation_wizard':
      appActions.setActiveModal('agentCreationWizard');
      return true;
    case 'show_session_selector': {
      const sessions = (data as { sessions?: SessionMetadata[] } | undefined)?.sessions;
      appActions.showSessionSelector(sessions);
      return true;
    }
    case 'clear_screen':
      // 完整重置会话状态（参考 Claude Code 的 /clear 行为）
      // 1. 清除消息历史
      sessionActions.clearMessages();
      // 2. 清除错误状态
      sessionActions.setError(null);
      // 3. 重置 token 使用量（让 context 回到 100%）
      sessionActions.resetTokenUsage();
      // 4. 清空 todos
      appActions.setTodos([]);
      return true;
    case 'compact_completed':
    case 'compact_fallback': {
      // 压缩完成后重置 token 使用量
      // 因为压缩后的 token 数量已经大幅减少
      sessionActions.resetTokenUsage();
      return true;
    }
    case 'exit_application':
      safeExit(0);
      return true;
    default:
      return false;
  }
}

/**
 * 检查 data 是否为 invoke_skill action
 */
function isInvokeSkillAction(data: unknown): data is InvokeSkillData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InvokeSkillData).action === 'invoke_skill' &&
    typeof (data as InvokeSkillData).skillName === 'string'
  );
}

/**
 * 检查 data 是否为 invoke_custom_command action
 */
function isInvokeCustomCommandAction(data: unknown): data is InvokeCustomCommandData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InvokeCustomCommandData).action === 'invoke_custom_command' &&
    typeof (data as InvokeCustomCommandData).commandName === 'string' &&
    typeof (data as InvokeCustomCommandData).processedContent === 'string'
  );
}

/**
 * 检查 data 是否为 invoke_plugin_command action
 */
function isInvokePluginCommandAction(data: unknown): data is InvokePluginCommandData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InvokePluginCommandData).action === 'invoke_plugin_command' &&
    typeof (data as InvokePluginCommandData).commandName === 'string' &&
    typeof (data as InvokePluginCommandData).processedContent === 'string'
  );
}

interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 构建用户消息内容
 * 如果包含图片，则返回多模态 ContentPart[]（保留文本和图片的相对顺序）
 * 否则返回纯文本 string
 */
function buildUserMessageContent(resolved: ResolvedInput): string | ContentPart[] {
  const { text, images, parts: resolvedParts } = resolved;

  // 无图片时返回纯文本
  if (images.length === 0) {
    return text;
  }

  // 有图片时构建多模态内容，保留原始顺序
  const parts: ContentPart[] = [];

  for (const part of resolvedParts) {
    if (part.type === 'text') {
      // 文本部分（保留空白分隔符，用于图片间隔）
      parts.push({ type: 'text', text: part.text });
    } else {
      // 图片部分
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.mimeType};base64,${part.base64}`,
        },
      });
    }
  }

  return parts;
}

/**
 * 命令处理 Hook
 * 负责命令的执行和状态管理
 *
 * 已迁移到 Zustand Store
 */
export const useCommandHandler = (
  replaceSystemPrompt?: string, // --system-prompt (完全替换)
  appendSystemPrompt?: string, // --append-system-prompt (追加)
  confirmationHandler?: ConfirmationHandler,
  maxTurns?: number // --max-turns (最大对话轮次)
) => {
  // ==================== Store 选择器 ====================
  const isProcessing = useIsProcessing();
  const messages = useMessages();
  const sessionId = useSessionId();
  const permissionMode = usePermissionMode();
  const thinkingModeEnabled = useThinkingModeEnabled();

  // ==================== Store Actions ====================
  const sessionActions = useSessionActions();
  const appActions = useAppActions();
  const commandActions = useCommandActions();

  // ==================== Local Refs ====================
  const abortMessageSentRef = useRef(false);

  // 使用 Agent 管理 Hook
  // Agent 现在直接通过 vanilla store 更新 todos，不需要回调
  const { createAgent, cleanupAgent } = useAgent({
    systemPrompt: replaceSystemPrompt,
    appendSystemPrompt: appendSystemPrompt,
    maxTurns: maxTurns,
  });

  // ==================== 流式输出批处理 ====================
  // 按多行/块输出，减少渲染次数
  const FLUSH_TIMEOUT = 300; // 超时强制刷新（毫秒）- 增加到 300ms 让块更大
  const MIN_LINES_TO_FLUSH = 5; // 累积 5 行后刷新
  const MIN_CHARS_TO_FLUSH = 400; // 或累积 400 字符后刷新

  // Content 批处理状态
  const contentBufferRef = useRef('');
  const contentFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Thinking 批处理状态
  const thinkingBufferRef = useRef('');
  const thinkingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 刷新 content 缓冲区
  const flushContentBuffer = useMemoizedFn(() => {
    if (contentBufferRef.current) {
      const delta = contentBufferRef.current;
      const messageId = sessionActions.appendAssistantContent(delta);
      appendMarkdownDelta(messageId, delta);
      contentBufferRef.current = '';
    }
    if (contentFlushTimerRef.current) {
      clearTimeout(contentFlushTimerRef.current);
      contentFlushTimerRef.current = null;
    }
  });

  // 刷新 thinking 缓冲区
  const flushThinkingBuffer = useMemoizedFn(() => {
    if (thinkingBufferRef.current) {
      sessionActions.appendThinkingContent(thinkingBufferRef.current);
      thinkingBufferRef.current = '';
    }
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
  });

  // 统计换行符数量
  const countNewlines = (str: string) => {
    let count = 0;
    for (const char of str) {
      if (char === '\n') count++;
    }
    return count;
  };

  // 批量追加 content（按多行刷新）
  const batchAppendContent = useMemoizedFn((delta: string) => {
    contentBufferRef.current += delta;
    const buffer = contentBufferRef.current;

    // 检查是否达到刷新条件：多行 或 足够字符
    const lineCount = countNewlines(buffer);
    if (lineCount >= MIN_LINES_TO_FLUSH || buffer.length >= MIN_CHARS_TO_FLUSH) {
      flushContentBuffer();
      return;
    }

    // 未达到条件，设置超时兜底
    if (!contentFlushTimerRef.current) {
      contentFlushTimerRef.current = setTimeout(flushContentBuffer, FLUSH_TIMEOUT);
    }
  });

  // 批量追加 thinking（按多行刷新）
  const batchAppendThinking = useMemoizedFn((delta: string) => {
    thinkingBufferRef.current += delta;
    const buffer = thinkingBufferRef.current;

    const lineCount = countNewlines(buffer);
    if (lineCount >= MIN_LINES_TO_FLUSH || buffer.length >= MIN_CHARS_TO_FLUSH) {
      flushThinkingBuffer();
      return;
    }

    if (!thinkingFlushTimerRef.current) {
      thinkingFlushTimerRef.current = setTimeout(flushThinkingBuffer, FLUSH_TIMEOUT);
    }
  });

  // 重置批处理状态（新对话开始时调用）
  const resetStreamingBuffers = useMemoizedFn(() => {
    contentBufferRef.current = '';
    if (contentFlushTimerRef.current) {
      clearTimeout(contentFlushTimerRef.current);
      contentFlushTimerRef.current = null;
    }

    thinkingBufferRef.current = '';
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
  });

  // 清理函数
  useEffect(() => {
    return () => {
      cleanupAgent();
      // 清理批处理定时器
      resetStreamingBuffers();
    };
  }, [cleanupAgent, resetStreamingBuffers]);

  useEffect(() => {
    if (!thinkingModeEnabled) {
      sessionActions.setCurrentThinkingContent(null);
    }
  }, [thinkingModeEnabled, sessionActions]);

  // 停止任务
  const handleAbort = useMemoizedFn(() => {
    // 如果没有任务在执行，忽略
    if (!isProcessing) {
      return;
    }

    // 先刷新缓冲区，确保已接收的内容不丢失
    flushContentBuffer();
    flushThinkingBuffer();

    // ⚠️ 顺序很重要：先触发 abort signal，再添加消息
    // 这样 Agent 的 signal.aborted 检查能生效，阻止后续回调
    commandActions.abort();
    appActions.setTodos([]);

    // 结束当前流式消息，避免残留的 streaming 占位遮挡终止提示
    const streamingId = getState().session.currentStreamingMessageId;
    if (streamingId) {
      finalizeMarkdownCache(streamingId);
    }
    sessionActions.finalizeStreamingMessage();

    // 显示"任务已停止"消息（防止重复）
    if (!abortMessageSentRef.current) {
      sessionActions.addAssistantMessage('✋ 任务已停止');
      abortMessageSentRef.current = true;
    }
  });

  // 处理命令提交
  const handleCommandSubmit = useMemoizedFn(
    async (resolved: ResolvedInput): Promise<CommandResult> => {
      const { text: command } = resolved;
      let userMessageAlreadyAdded = false; // 标记用户消息是否已添加

      try {
        // 检查是否为 slash command（先检查，避免 /clear 时显示用户消息）
        // 注意：slash command 不支持图片，仅使用文本部分
        if (isSlashCommand(command)) {
          // ⚠️ 关键：确保 Store 已初始化（防御性检查）
          // slash commands 依赖 Store 状态，必须在执行前确保初始化
          // 这里是统一防御点，避免竞态或未来非 UI 场景踩坑
          await ensureStoreInitialized();

          // 创建 AbortController 用于取消 slash command
          const abortController = commandActions.createAbortController();

          // 简化的 context - slash commands 从 vanilla store 获取状态
          const slashContext: SlashCommandContext = {
            cwd: process.cwd(),
            signal: abortController.signal,
          };

          const slashResult = await executeSlashCommand(command, slashContext);

          // 直接处理 slash 命令的 UI 消息
          if (slashResult.message) {
            const handled = handleSlashMessage(
              slashResult.message,
              slashResult.data,
              appActions,
              sessionActions
            );
            if (handled) {
              return { success: true };
            }
          }

          // 处理 invoke_skill action（User-invoked Skill）
          // 用户输入 /skill-name args 时，转换为普通消息走 Agent 流程
          let isSkillOrCommandInvocation = false;
          if (isInvokeSkillAction(slashResult.data)) {
            const { skillName, skillArgs } = slashResult.data;

            // 构建让 AI 调用 Skill 的提示
            const skillPrompt = skillArgs
              ? `Please use the "${skillName}" skill to help me with: ${skillArgs}`
              : `Please use the "${skillName}" skill.`;

            // 显示用户消息，然后跳出 slash command 分支，进入 Agent 流程
            sessionActions.addUserMessage(skillPrompt);
            userMessageAlreadyAdded = true; // 标记已添加
            isSkillOrCommandInvocation = true;

            // 修改 resolved，让后续 Agent 流程使用 skillPrompt
            resolved = {
              displayText: skillPrompt,
              text: skillPrompt,
              images: [],
              parts: [{ type: 'text', text: skillPrompt }],
            };
            // 不 return，跳出 if (isSlashCommand) 分支，进入普通消息处理
          }

          // 处理 invoke_custom_command action（User-invoked Custom Command）
          // 用户输入 /command-name args 时，处理后的内容发送给 AI
          if (isInvokeCustomCommandAction(slashResult.data)) {
            const { commandName, processedContent } = slashResult.data;

            // 显示用户消息
            sessionActions.addUserMessage(command);
            userMessageAlreadyAdded = true;
            isSkillOrCommandInvocation = true;

            // 构建完整的命令提示（已包含处理后的内容）
            const commandPrompt = `# Custom Command: /${commandName}

The user has invoked the custom command "/${commandName}". Follow the instructions below to complete the task.

---

${processedContent}

---

Remember: Follow the above instructions carefully to complete the user's request.`;

            // 修改 resolved，让后续 Agent 流程使用 commandPrompt
            resolved = {
              displayText: command,
              text: commandPrompt,
              images: [],
              parts: [{ type: 'text', text: commandPrompt }],
            };
            // 不 return，跳出 if (isSlashCommand) 分支，进入普通消息处理
          }

          // 处理 invoke_plugin_command action（User-invoked Plugin Command）
          // 用户输入 /plugin:command args 时，处理后的内容发送给 AI
          if (isInvokePluginCommandAction(slashResult.data)) {
            const { commandName, pluginName, processedContent } = slashResult.data;

            // 显示用户消息
            sessionActions.addUserMessage(command);
            userMessageAlreadyAdded = true;
            isSkillOrCommandInvocation = true;

            // 构建完整的命令提示（已包含处理后的内容）
            const commandPrompt = `# Plugin Command: /${commandName}

The user has invoked the plugin command "/${commandName}" from plugin "${pluginName}". Follow the instructions below to complete the task.

---

${processedContent}

---

Remember: Follow the above instructions carefully to complete the user's request.`;

            // 修改 resolved，让后续 Agent 流程使用 commandPrompt
            resolved = {
              displayText: command,
              text: commandPrompt,
              images: [],
              parts: [{ type: 'text', text: commandPrompt }],
            };
            // 不 return，跳出 if (isSlashCommand) 分支，进入普通消息处理
          }

          if (!isSkillOrCommandInvocation) {
            // 非 invoke_skill 的 slash command，正常处理
            if (!slashResult.success && slashResult.error) {
              sessionActions.addAssistantMessage(`❌ ${slashResult.error}`);
              return {
                success: slashResult.success,
                output: slashResult.message,
                error: slashResult.error,
                metadata: slashResult.data,
              };
            }

            // 显示命令返回的消息
            const slashMessage = slashResult.message;
            if (
              slashResult.success &&
              typeof slashMessage === 'string' &&
              slashMessage.trim() !== ''
            ) {
              sessionActions.addAssistantMessage(slashMessage);
            }

            return {
              success: slashResult.success,
              output: slashResult.message,
              error: slashResult.error,
              metadata: slashResult.data,
            };
          }
        }

        // ========== UserPromptSubmit Hook ==========
        // 在处理用户输入之前执行，可注入上下文或修改提示词
        const hookManager = HookManager.getInstance();
        let resolvedPrompt = resolved;
        let hookContextInjection: string | undefined;

        const hookResult = await hookManager.executeUserPromptSubmitHooks(
          resolved.text,
          {
            projectDir: process.cwd(),
            sessionId: sessionId,
            permissionMode: permissionMode,
            hasImages: resolved.images.length > 0,
            imageCount: resolved.images.length,
          }
        );

        if (!hookResult.proceed) {
          // Hook 阻止了处理
          if (hookResult.warning) {
            sessionActions.addAssistantMessage(`⚠️ ${hookResult.warning}`);
          }
          return { success: false, error: 'blocked by hook' };
        }

        // 应用 hook 的修改
        if (hookResult.updatedPrompt) {
          resolvedPrompt = {
            ...resolved,
            text: hookResult.updatedPrompt,
            displayText: hookResult.updatedPrompt,
            parts: [{ type: 'text', text: hookResult.updatedPrompt }],
          };
        }

        if (hookResult.contextInjection) {
          hookContextInjection = hookResult.contextInjection;
        }

        // 普通命令：添加用户消息（UI 显示带图片占位符的文本）
        // 注意：invoke_skill 的用户消息已在上面添加，这里跳过
        if (!userMessageAlreadyAdded) {
          sessionActions.addUserMessage(resolvedPrompt.displayText);
        }

        // 构建用户消息内容（可能包含图片）
        const userMessageContent = buildUserMessageContent(resolvedPrompt);

        // ⚠️ 先创建 AbortController，再创建 Agent
        // 这样用户在 Agent 初始化期间按 Ctrl+C 也能正确中止
        const abortController = commandActions.createAbortController();

        // 创建并设置 Agent（可能耗时，如连接 MCP）
        const agent = await createAgent();

        // 检查 Agent 创建期间是否已被中止
        if (abortController.signal.aborted) {
          logger.info('[handleCommandSubmit] Agent 创建期间已被中止');
          return { success: false, error: 'aborted' };
        }

        // 构建消息列表（可能包含 hook 注入的上下文）
        const contextMessages = messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

        // 如果有 hook 注入的上下文，添加为 system 消息
        if (hookContextInjection) {
          contextMessages.push({
            role: 'system',
            content: `<user-prompt-submit-hook>\n${hookContextInjection}\n</user-prompt-submit-hook>`,
          });
        }

        const chatContext = {
          messages: contextMessages,
          userId: 'cli-user',
          sessionId: sessionId,
          workspaceRoot: process.cwd(),
          signal: abortController.signal,
          confirmationHandler,
          permissionMode: permissionMode,
        };

        let contentDeltaCount = 0;
        let contentDeltaTotalLen = 0;
        let onContentCallCount = 0;

        const loopOptions = {
          // 启用流式输出（默认）
          stream: true,

          // ===== 流式增量回调 =====

          // 流式内容增量（使用批处理减少渲染频率）
          // batchAppendContent 会累积内容，每 50ms 刷新一次
          onContentDelta: (delta: string) => {
            contentDeltaCount++;
            contentDeltaTotalLen += delta.length;
            streamDebug('useCommandHandler', 'onContentDelta', {
              callCount: contentDeltaCount,
              deltaLen: delta.length,
              totalLen: contentDeltaTotalLen,
            });
            batchAppendContent(delta);
          },

          // 流式推理内容增量（Thinking 模型，使用批处理）
          onThinkingDelta: thinkingModeEnabled
            ? (delta: string) => {
                batchAppendThinking(delta);
              }
            : undefined,

          // ===== 完整内容回调（流结束时调用）=====

          // LLM 推理内容（Thinking 模型如 DeepSeek R1）
          // 流式模式下：增量已通过 onThinkingDelta 发送，这里用于兼容
          // 非流式模式下：这是唯一的通知途径
          onThinking: thinkingModeEnabled
            ? (content: string) => {
                // abort 检查已在 Agent 内部统一处理
                sessionActions.setCurrentThinkingContent(content);
              }
            : undefined,

          // 流式输出结束信号
          // 流式模式下：增量已通过 onContentDelta 发送，这里标记流结束并完成消息
          onStreamEnd: () => {
            streamDebug('useCommandHandler', 'onStreamEnd', {
              contentDeltaCallCount: contentDeltaCount,
              contentDeltaTotalLen,
              remainingBuffer: contentBufferRef.current.length,
            });

            // 清理定时器
            if (contentFlushTimerRef.current) {
              clearTimeout(contentFlushTimerRef.current);
              contentFlushTimerRef.current = null;
            }
            if (thinkingFlushTimerRef.current) {
              clearTimeout(thinkingFlushTimerRef.current);
              thinkingFlushTimerRef.current = null;
            }

            // 一次原子操作：追加缓冲区剩余内容 + 完成消息
            // 避免多次 Store 更新导致闪屏
            const extraContent = contentBufferRef.current;
            const extraThinking = thinkingBufferRef.current;
            contentBufferRef.current = '';
            thinkingBufferRef.current = '';

            const streamingId = getState().session.currentStreamingMessageId;
            if (streamingId) {
              if (extraContent) {
                appendMarkdownDelta(streamingId, extraContent);
              }
              finalizeMarkdownCache(streamingId);
            }

            sessionActions.finalizeStreamingMessage(extraContent, extraThinking);
          },

          // LLM 输出内容（仅非流式模式）
          // 非流式 fallback 模式下：这里创建完整消息
          onContent: (content: string) => {
            onContentCallCount++;
            // abort 检查已在 Agent 内部统一处理
            if (!content.trim()) return;

            streamDebug('useCommandHandler', 'onContent (non-stream)', {
              callCount: onContentCallCount,
              contentLen: content.length,
            });

            // 非流式 fallback：直接添加完整消息
            sessionActions.addAssistantMessageAndClearThinking(content);
          },
          // 工具调用开始
          onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
            // abort 检查已在 Agent 内部统一处理
            if (toolCall.type !== 'function') return;
            // 跳过 TodoWrite 的显示（任务列表由侧边栏显示）
            if (toolCall.function.name === 'TodoWrite') {
              return;
            }

            try {
              const params = JSON.parse(toolCall.function.arguments);
              const summary = formatToolCallSummary(toolCall.function.name, params);
              sessionActions.addToolMessage(summary, {
                toolName: toolCall.function.name,
                phase: 'start',
                summary,
                params,
              });
            } catch (error) {
              logger.error('[useCommandHandler] onToolStart error:', error);
            }
          },
          // 工具执行完成（显示摘要 + 可选的详细内容）
          onToolResult: async (
            toolCall: ChatCompletionMessageToolCall,
            result: ToolResult
          ) => {
            // abort 检查已在 Agent 内部统一处理
            if (toolCall.type !== 'function') return;
            const summary = result.metadata?.summary;
            if (!summary) return;

            // 决定是否显示详细内容，并生成详细内容
            let detail: string | undefined;
            if (shouldShowToolDetail(toolCall.function.name, result)) {
              // 优先使用 generateToolDetail 生成更友好的详情
              detail =
                generateToolDetail(toolCall.function.name, result) ||
                result.displayContent;
            }

            sessionActions.addToolMessage(summary, {
              toolName: toolCall.function.name,
              phase: 'complete',
              summary,
              detail,
            });
          },
          // Token 使用量更新
          onTokenUsage: (usage: {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            maxContextTokens: number;
          }) => {
            sessionActions.updateTokenUsage(usage);
          },
          // 压缩状态更新
          onCompacting: (isCompacting: boolean) => {
            sessionActions.setCompacting(isCompacting);
            // 压缩完成后重置 token 使用量
            if (!isCompacting) {
              sessionActions.resetTokenUsage();
            }
          },
          // 轮次限制回调（达到 maxTurns 后询问用户是否继续）
          onTurnLimitReached: confirmationHandler
            ? async (data: { turnsCount: number }) => {
                const response = await confirmationHandler.requestConfirmation({
                  type: 'maxTurnsExceeded',
                  title: '对话轮次上限',
                  message: `已进行 ${data.turnsCount} 轮对话。是否继续？`,
                  risks: ['继续执行可能导致更长的等待时间', '可能产生更多的 API 费用'],
                });
                return {
                  continue: response.approved,
                  reason: response.reason,
                };
              }
            : undefined,
        };

        const output = await agent.chat(userMessageContent, chatContext, loopOptions);

        // 如果返回空字符串，可能是用户取消或拒绝
        // 流式场景下 output 可能为空，但内容已通过流式回调输出
        // 如果已经发送过 abort 消息，不再重复添加
        if (!output || output.trim() === '') {
          if (!abortMessageSentRef.current && contentDeltaCount === 0) {
            sessionActions.addAssistantMessage('⏹ 已取消');
            return {
              success: true,
              output: '已取消',
            };
          }
          return { success: true, output: output ?? '' };
        }

        return { success: true, output };
      } catch (error) {
        // 如果是 abort 导致的错误，且已经发送过消息，不再重复
        if (abortMessageSentRef.current) {
          return { success: false, error: 'aborted' };
        }

        const errorMessage = error instanceof Error ? error.message : '未知错误';

        // 检测是否是图片/多模态不支持的错误
        const isVisionNotSupportedError =
          errorMessage.includes('can only concatenate str') ||
          errorMessage.includes('image_url') ||
          errorMessage.includes('multimodal') ||
          errorMessage.includes('vision') ||
          errorMessage.includes('does not support images');

        let displayMessage = errorMessage;
        if (isVisionNotSupportedError) {
          displayMessage =
            '当前模型不支持图片理解功能。请切换到支持视觉能力的模型（如 Claude 4.5、GPT-5.2、Gemini 3 Pro、Qwen3-VL-Plus 等）后重试。';
        }

        const errorResult = { success: false, error: displayMessage };
        sessionActions.addAssistantMessage(`❌ ${displayMessage}`);
        return errorResult;
      }
    }
  );

  // 处理提交
  const executeCommand = useMemoizedFn(async (resolved: ResolvedInput) => {
    if (!resolved.text.trim() && resolved.images.length === 0) {
      return;
    }

    // 如果正在处理，静默加入队列（执行时再显示用户消息）
    // 队列支持完整的 ResolvedInput（包含图片）
    if (isProcessing) {
      commandActions.enqueueCommand({
        displayText: resolved.displayText,
        text: resolved.text,
        images: resolved.images,
        parts: resolved.parts,
      });
      return;
    }

    // 清空上一轮对话的 todos
    appActions.setTodos([]);

    // 重置中止提示标记，准备新的执行循环
    abortMessageSentRef.current = false;

    // ⚠️ 先创建 AbortController，保存引用用于 finally 中的清理判断
    // 这样可以防止竞态条件：如果用户快速取消并发送新消息，
    // 旧任务的 finally 不会影响新任务的状态
    const taskAbortController = commandActions.createAbortController();

    // 重置流式批处理缓冲区
    resetStreamingBuffers();

    // 清理上一次的最终渲染标记，避免新任务期间降级显示
    sessionActions.clearFinalizingStreamingMessageId();

    // 设置处理状态
    commandActions.setProcessing(true);

    try {
      const result = await handleCommandSubmit(resolved);

      // 只有非 abort 的错误才写入 session.error
      // abort 是正常中止，不应显示为错误
      if (!result.success && result.error && result.error !== 'aborted') {
        sessionActions.setError(result.error);
      }
    } catch (error) {
      // AbortError 静默处理
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'))
      ) {
        // AbortError 静默处理，不显示错误
      } else {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        sessionActions.setError(`执行失败: ${errorMessage}`);
      }
    } finally {
      // ⚠️ 关键修复：只有当我们的 controller 仍然是当前的才重置状态
      // 这防止了竞态条件：如果用户取消后立即发送新消息，
      // 旧任务的 finally 块不会影响新任务的状态
      //
      // 检查逻辑：如果 store 中的 abortController 与我们保存的不同，
      // 说明新任务已经创建了新的 controller，我们不应该重置状态
      const currentController = commandActions.getAbortController();
      const isOurTask = currentController === taskAbortController;

      if (isOurTask) {
        commandActions.setProcessing(false);
        commandActions.clearAbortController(taskAbortController);
        // 清理 thinking 内容（防止遗留）
        sessionActions.setCurrentThinkingContent(null);

        // 处理队列中的下一个命令（支持完整的 ResolvedInput）
        // ⚠️ 队列调度也必须在 isOurTask 内，防止旧任务并行启动新任务
        const nextCommand = commandActions.dequeueCommand();
        if (nextCommand) {
          // 稍微延迟以让 UI 更新
          setTimeout(
            () =>
              executeCommand({
                displayText: nextCommand.displayText,
                text: nextCommand.text,
                images: nextCommand.images,
                parts: nextCommand.parts,
              }),
            100
          );
        }
      }
    }
  });

  return {
    executeCommand,
    handleAbort,
    isProcessing, // 暴露以供外部组件使用
  };
};
