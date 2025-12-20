import { useMemoizedFn } from 'ahooks';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { useEffect, useRef } from 'react';
import { createLogger, LogCategory } from '../../logging/Logger.js';
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
} from '../../store/selectors/index.js';
import { ensureStoreInitialized } from '../../store/vanilla.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import {
  formatToolCallSummary,
  shouldShowToolDetail,
} from '../utils/toolFormatters.js';
import { useAgent } from './useAgent.js';

// 创建 UI Hook 专用 Logger
const logger = createLogger(LogCategory.UI);

/**
 * 处理 slash 命令返回的 UI 消息
 * 直接调用 appActions 而非使用 ActionMapper
 */
function handleSlashMessage(
  message: string,
  data: unknown,
  appActions: ReturnType<typeof useAppActions>
): boolean {
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
    case 'show_agent_creation_wizard':
      appActions.setActiveModal('agentCreationWizard');
      return true;
    case 'show_session_selector': {
      const sessions = (data as { sessions?: SessionMetadata[] } | undefined)?.sessions;
      appActions.showSessionSelector(sessions);
      return true;
    }
    case 'exit_application':
      process.exit(0);
      return true;
    default:
      return false;
  }
}

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
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

  // 清理函数
  useEffect(() => {
    return () => {
      cleanupAgent();
    };
  }, [cleanupAgent]);

  // 停止任务
  const handleAbort = useMemoizedFn(() => {
    // 如果没有任务在执行，忽略
    if (!isProcessing) {
      return;
    }

    // 乐观更新：立即显示"任务已停止"消息（防止重复）
    if (!abortMessageSentRef.current) {
      sessionActions.addAssistantMessage('✋ 任务已停止');
      abortMessageSentRef.current = true;
    }

    // 使用 store 的 abort action（会同时重置 isProcessing 和 isThinking）
    commandActions.abort();
    appActions.setTodos([]);
  });

  // 处理命令提交
  const handleCommandSubmit = useMemoizedFn(
    async (command: string): Promise<CommandResult> => {
      try {
        sessionActions.addUserMessage(command);

        // 检查是否为 slash command
        if (isSlashCommand(command)) {
          // ⚠️ 关键：确保 Store 已初始化（防御性检查）
          // slash commands 依赖 Store 状态，必须在执行前确保初始化
          // 这里是统一防御点，避免竞态或未来非 UI 场景踩坑
          await ensureStoreInitialized();

          // 简化的 context - slash commands 从 vanilla store 获取状态
          const slashContext: SlashCommandContext = {
            cwd: process.cwd(),
          };

          const slashResult = await executeSlashCommand(command, slashContext);

          // 直接处理 slash 命令的 UI 消息
          if (slashResult.message) {
            const handled = handleSlashMessage(
              slashResult.message,
              slashResult.data,
              appActions
            );
            if (handled) {
              return { success: true };
            }
          }

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

        // 创建并设置 Agent
        const agent = await createAgent();

        // 从 store 获取 AbortController
        const abortController = commandActions.createAbortController();

        const chatContext = {
          messages: messages.map((msg) => ({
            role: msg.role as 'user' | 'assistant' | 'system',
            content: msg.content,
          })),
          userId: 'cli-user',
          sessionId: sessionId,
          workspaceRoot: process.cwd(),
          signal: abortController.signal,
          confirmationHandler,
          permissionMode: permissionMode,
        };

        const loopOptions = {
          // LLM 推理内容（Thinking 模型如 DeepSeek R1）
          onThinking: (content: string) => {
            // 设置 thinking 内容（流式显示）
            sessionActions.setCurrentThinkingContent(content);
          },
          // LLM 输出内容
          onContent: (content: string) => {
            // 获取当前 thinking 内容，保存到消息中
            // 注意：这里需要在 addAssistantMessage 之前获取，因为 addMessage 会清空 currentThinkingContent
            if (content.trim()) {
              sessionActions.addAssistantMessage(content);
              // 清空流式 thinking 内容（已保存到消息中）
              sessionActions.setCurrentThinkingContent(null);
            }
          },
          // 工具调用开始
          onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
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
            if (toolCall.type !== 'function') return;
            if (!result?.metadata?.summary) {
              return;
            }

            const detail = shouldShowToolDetail(toolCall.function.name, result)
              ? result.displayContent
              : undefined;

            sessionActions.addToolMessage(result.metadata.summary, {
              toolName: toolCall.function.name,
              phase: 'complete',
              summary: result.metadata.summary,
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
          },
          // 轮次限制回调（达到 maxTurns 后询问用户是否继续）
          onTurnLimitReached: confirmationHandler
            ? async (data: { turnsCount: number }) => {
                const response = await confirmationHandler.requestConfirmation({
                  type: 'maxTurnsExceeded',
                  title: '对话轮次上限',
                  message: `已进行 ${data.turnsCount} 轮对话。是否继续？`,
                  risks: [
                    '继续执行可能导致更长的等待时间',
                    '可能产生更多的 API 费用',
                  ],
                });
                return {
                  continue: response.approved,
                  reason: response.reason,
                };
              }
            : undefined,
        };

        const output = await agent.chat(command, chatContext, loopOptions);

        // 如果返回空字符串，可能是用户取消
        if (!output || output.trim() === '') {
          sessionActions.addAssistantMessage('⏹ 已取消');
          return {
            success: true,
            output: '已取消',
          };
        }

        return { success: true, output };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        const errorResult = { success: false, error: errorMessage };
        sessionActions.addAssistantMessage(`❌ ${errorMessage}`);
        return errorResult;
      }
    }
  );

  // 处理提交
  const executeCommand = useMemoizedFn(async (command: string) => {
    if (!command.trim()) {
      return;
    }

    const trimmedCommand = command.trim();

    // 如果正在处理，静默加入队列（执行时再显示用户消息）
    if (isProcessing) {
      commandActions.enqueueCommand(trimmedCommand);
      return;
    }

    // 清空上一轮对话的 todos
    appActions.setTodos([]);

    // 重置中止提示标记，准备新的执行循环
    abortMessageSentRef.current = false;

    // 设置处理状态
    commandActions.setProcessing(true);
    sessionActions.setThinking(true);

    try {
      const result = await handleCommandSubmit(trimmedCommand);

      if (!result.success && result.error) {
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
      // 重置状态
      commandActions.setProcessing(false);
      sessionActions.setThinking(false);
      commandActions.clearAbortController();
      // 清理 thinking 内容（防止遗留）
      sessionActions.setCurrentThinkingContent(null);

      // 处理队列中的下一个命令
      const nextCommand = commandActions.dequeueCommand();
      if (nextCommand) {
        // 稍微延迟以让 UI 更新
        setTimeout(() => executeCommand(nextCommand), 100);
      }
    }
  });

  return {
    executeCommand,
    handleAbort,
    isProcessing, // 暴露以供外部组件使用
  };
};
