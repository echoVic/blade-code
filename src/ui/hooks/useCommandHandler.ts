import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef, useState } from 'react';
import { Agent } from '../../agent/Agent.js';
import { ConfigManager } from '../../config/ConfigManager.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import {
  executeSlashCommand,
  isSlashCommand,
  type SlashCommandContext,
} from '../../slash-commands/index.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import { useAppState } from '../contexts/AppContext.js';
import { useSession } from '../contexts/SessionContext.js';

// 创建 UI Hook 专用 Logger
const logger = createLogger(LogCategory.UI);

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface LoopState {
  active: boolean;
  turn: number;
  maxTurns: number;
  currentTool?: string;
}

/**
 * 格式化工具调用摘要（用于流式显示）
 */
function formatToolCallSummary(
  toolName: string,
  params: Record<string, unknown>
): string {
  switch (toolName) {
    case 'Write':
      return `Write(${params.file_path || 'file'})`;
    case 'Edit':
      return `Edit(${params.file_path || 'file'})`;
    case 'Read':
      return `Read(${params.file_path || 'file'})`;
    case 'Bash': {
      const cmd = params.command as string;
      return `Bash(${cmd ? cmd.substring(0, 50) : 'command'}${cmd && cmd.length > 50 ? '...' : ''})`;
    }
    case 'Glob':
      return `Glob(${params.pattern || '*'})`;
    case 'Grep': {
      const pattern = params.pattern as string;
      const path = params.path as string;
      if (path) {
        return `Grep("${pattern}" in ${path})`;
      }
      return `Grep("${pattern}")`;
    }
    case 'WebFetch': {
      const url = params.url as string;
      if (url) {
        try {
          const urlObj = new URL(url);
          return `WebFetch(${urlObj.hostname})`;
        } catch {
          return `WebFetch(${url.substring(0, 30)}${url.length > 30 ? '...' : ''})`;
        }
      }
      return 'WebFetch(url)';
    }
    case 'WebSearch':
      return `WebSearch("${params.query || 'query'}")`;
    case 'TodoWrite':
      return `TodoWrite(${(params.todos as unknown[])?.length || 0} items)`;
    case 'UndoEdit':
      return `UndoEdit(${params.file_path || 'file'})`;
    default:
      return `${toolName}()`;
  }
}

/**
 * 判断是否显示工具详细内容
 */
function shouldShowToolDetail(toolName: string, result: any): boolean {
  if (!result?.displayContent) return false;

  switch (toolName) {
    case 'Write':
      // 小文件显示预览（小于 10KB）
      return (result.metadata?.file_size || 0) < 10000;

    case 'Edit':
      // 总是显示 diff 片段
      return true;

    case 'Bash':
      // 短输出显示（小于 1000 字符）
      return (result.metadata?.stdout_length || 0) < 1000;

    case 'Read':
    case 'TodoWrite':
    case 'TodoRead':
      // 不显示详细内容
      return false;

    default:
      // 其他工具默认不显示
      return false;
  }
}

/**
 * 命令处理 Hook
 * 负责命令的执行和状态管理
 */
export const useCommandHandler = (
  replaceSystemPrompt?: string, // --system-prompt (完全替换)
  appendSystemPrompt?: string, // --append-system-prompt (追加)
  confirmationHandler?: ConfirmationHandler,
  maxTurns?: number // --max-turns (最大对话轮次)
) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [loopState, setLoopState] = useState<LoopState>({
    active: false,
    turn: 0,
    maxTurns: 50,
    currentTool: undefined,
  });
  const {
    dispatch,
    state: sessionState,
    restoreSession,
    addToolMessage,
  } = useSession();
  const { dispatch: appDispatch, actions: appActions, state: appState } = useAppState();
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const agentRef = useRef<Agent | undefined>(undefined);

  // 清理函数
  useEffect(() => {
    return () => {
      if (agentRef.current) {
        agentRef.current.removeAllListeners();
      }
    };
  }, []);

  // 停止任务
  const handleAbort = useMemoizedFn(() => {
    if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
      abortControllerRef.current.abort();
      setLoopState({ active: false, turn: 0, maxTurns: 50, currentTool: undefined });
    }
  });

  // 创建并初始化 Agent（共享逻辑）
  const createAndSetupAgent = useMemoizedFn(async (): Promise<Agent> => {
    // 清理旧的 Agent 事件监听器
    if (agentRef.current) {
      agentRef.current.removeAllListeners();
    }

    // 创建新 Agent
    const agent = await Agent.create({
      systemPrompt: replaceSystemPrompt,
      appendSystemPrompt: appendSystemPrompt,
      maxTurns: maxTurns, // 传递 CLI 参数
    });
    agentRef.current = agent;

    // 设置事件监听器
    agent.on(
      'loopTurnStart',
      ({ turn, maxTurns }: { turn: number; maxTurns: number }) => {
        setLoopState({ active: true, turn, maxTurns, currentTool: undefined });
      }
    );
    agent.on('toolExecutionStart', ({ tool }: { tool: string }) => {
      setLoopState((prev) => ({ ...prev, currentTool: tool }));
    });
    agent.on('toolExecutionComplete', () => {
      setLoopState((prev) => ({ ...prev, currentTool: undefined }));
    });
    agent.on('taskCompleted', () => {
      setLoopState({ active: false, turn: 0, maxTurns: 50, currentTool: undefined });
    });
    agent.on('taskFailed', () => {
      setLoopState({ active: false, turn: 0, maxTurns: 50, currentTool: undefined });
    });
    agent.on('taskAborted', () => {
      setLoopState({ active: false, turn: 0, maxTurns: 50, currentTool: undefined });
    });
    agent.on('todoUpdate', ({ todos }: { todos: TodoItem[] }) => {
      appDispatch(appActions.setTodos(todos));
      appDispatch(appActions.showTodoPanel());
    });

    return agent;
  });

  // 处理命令提交
  const handleCommandSubmit = useMemoizedFn(
    async (
      command: string,
      addUserMessage: (message: string) => void,
      addAssistantMessage: (message: string) => void
    ): Promise<CommandResult> => {
      try {
        addUserMessage(command);

        // 检查是否为 slash command
        if (isSlashCommand(command)) {
          const configManager = ConfigManager.getInstance();
          await configManager.initialize();

          const slashContext: SlashCommandContext = {
            cwd: process.cwd(),
            addUserMessage,
            addAssistantMessage,
            configManager,
            restoreSession, // 传递 restoreSession 函数
            sessionId: sessionState.sessionId, // 传递当前 sessionId
            messages: sessionState.messages, // 传递会话消息（用于 /compact 等命令）
          };

          const slashResult = await executeSlashCommand(command, slashContext);

          // 检查是否需要显示主题选择器
          if (slashResult.message === 'show_theme_selector') {
            appDispatch(appActions.showThemeSelector());
            return { success: true };
          }

          if (slashResult.message === 'show_permissions_manager') {
            appDispatch(appActions.showPermissionsManager());
            return { success: true };
          }

          // 检查是否需要显示会话选择器
          if (slashResult.message === 'show_session_selector') {
            // 传递会话数据到 AppContext
            const sessions = slashResult.data?.sessions as unknown[] | undefined;
            appDispatch(appActions.showSessionSelector(sessions));
            return { success: true };
          }

          if (!slashResult.success && slashResult.error) {
            addAssistantMessage(`❌ ${slashResult.error}`);
            return {
              success: slashResult.success,
              output: slashResult.message,
              error: slashResult.error,
              metadata: slashResult.data,
            };
          }

          // /init 命令总是会触发 AI 分析
          if (
            slashResult.success &&
            slashResult.message === 'trigger_analysis' &&
            slashResult.data
          ) {
            const { analysisPrompt } = slashResult.data;

            logger.debug(
              '[DEBUG] 触发 AI 分析，提示:',
              analysisPrompt.substring(0, 100) + '...'
            );

            // 创建并设置 Agent
            const agent = await createAndSetupAgent();

            // 创建新的 AbortController
            abortControllerRef.current = new AbortController();

            const chatContext = {
              messages: sessionState.messages.map((msg) => ({
                role: msg.role as 'user' | 'assistant' | 'system',
                content: msg.content,
              })),
              userId: 'cli-user',
              sessionId: sessionState.sessionId,
              workspaceRoot: process.cwd(),
              signal: abortControllerRef.current.signal,
              confirmationHandler,
              permissionMode: appState.permissionMode,
            };

            const loopOptions = {
              // 🆕 LLM 意图说明
              onThinking: (content: string) => {
                if (content.trim()) {
                  addAssistantMessage(content);
                }
              },
              // 🆕 工具调用开始
              onToolStart: (toolCall: any) => {
                // 跳过 TodoWrite/TodoRead 的显示
                if (
                  toolCall.function.name === 'TodoWrite' ||
                  toolCall.function.name === 'TodoRead'
                ) {
                  return;
                }

                try {
                  const params = JSON.parse(toolCall.function.arguments);
                  const summary = formatToolCallSummary(toolCall.function.name, params);
                  addToolMessage(summary, {
                    toolName: toolCall.function.name,
                    phase: 'start',
                    summary,
                    params,
                  });
                } catch (error) {
                  logger.error('[useCommandHandler] onToolStart error:', error);
                }
              },
              // 🆕 工具执行完成（显示摘要 + 可选的详细内容）
              onToolResult: async (toolCall: any, result: any) => {
                if (!result?.metadata?.summary) {
                  return;
                }

                const detail = shouldShowToolDetail(toolCall.function.name, result)
                  ? result.displayContent
                  : undefined;

                addToolMessage(result.metadata.summary, {
                  toolName: toolCall.function.name,
                  phase: 'complete',
                  summary: result.metadata.summary,
                  detail,
                });
              },
            };

            try {
              const aiOutput = await agent.chat(
                analysisPrompt,
                chatContext,
                loopOptions
              );

              // 如果返回空字符串，可能是用户中止
              if (!aiOutput || aiOutput.trim() === '') {
                addAssistantMessage('✋ 任务已停止');
                return {
                  success: true,
                  output: '任务已停止',
                  metadata: slashResult.data,
                };
              }

              // 注意：LLM 的输出已经通过 onThinking 回调添加到消息历史了，不需要再次添加

              return {
                success: true,
                output: aiOutput,
                metadata: slashResult.data,
              };
            } catch (aiError) {
              const aiErrorMessage =
                aiError instanceof Error ? aiError.message : '未知错误';
              addAssistantMessage(`❌ AI 分析失败: ${aiErrorMessage}`);
              return {
                success: false,
                error: `AI 分析失败: ${aiErrorMessage}`,
              };
            }
          }

          return {
            success: slashResult.success,
            output: slashResult.message,
            error: slashResult.error,
            metadata: slashResult.data,
          };
        }

        // 创建并设置 Agent
        const agent = await createAndSetupAgent();

        // 创建新的 AbortController
        abortControllerRef.current = new AbortController();

        const chatContext = {
          messages: sessionState.messages.map((msg) => ({
            role: msg.role as 'user' | 'assistant' | 'system',
            content: msg.content,
          })),
          userId: 'cli-user',
          sessionId: sessionState.sessionId,
          workspaceRoot: process.cwd(),
          signal: abortControllerRef.current.signal,
          confirmationHandler,
          permissionMode: appState.permissionMode,
        };

        const loopOptions = {
          // 🆕 LLM 意图说明
          onThinking: (content: string) => {
            if (content.trim()) {
              addAssistantMessage(content);
            }
          },
          // 🆕 工具调用开始
          onToolStart: (toolCall: any) => {
            // 跳过 TodoWrite/TodoRead 的显示
            if (
              toolCall.function.name === 'TodoWrite' ||
              toolCall.function.name === 'TodoRead'
            ) {
              return;
            }

            try {
              const params = JSON.parse(toolCall.function.arguments);
              const summary = formatToolCallSummary(toolCall.function.name, params);
              addToolMessage(summary, {
                toolName: toolCall.function.name,
                phase: 'start',
                summary,
                params,
              });
            } catch (error) {
              logger.error('[useCommandHandler] onToolStart error:', error);
            }
          },
          // 🆕 工具执行完成（显示摘要 + 可选的详细内容）
          onToolResult: async (toolCall: any, result: any) => {
            if (!result?.metadata?.summary) {
              return;
            }

            const detail = shouldShowToolDetail(toolCall.function.name, result)
              ? result.displayContent
              : undefined;

            addToolMessage(result.metadata.summary, {
              toolName: toolCall.function.name,
              phase: 'complete',
              summary: result.metadata.summary,
              detail,
            });
          },
        };

        const output = await agent.chat(command, chatContext, loopOptions);

        // 如果返回空字符串，可能是用户中止
        if (!output || output.trim() === '') {
          addAssistantMessage('✋ 任务已停止');
          return {
            success: true,
            output: '任务已停止',
          };
        }

        // 注意：LLM 的输出已经通过 onThinking 回调添加到消息历史了，不需要再次添加

        return { success: true, output };
      } catch (error) {
        logger.debug('[ERROR] handleCommandSubmit 异常:', error);
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        const errorResult = { success: false, error: errorMessage };
        addAssistantMessage(`❌ ${errorMessage}`);
        return errorResult;
      }
    }
  );

  // 处理提交
  const executeCommand = useMemoizedFn(
    async (
      command: string,
      addUserMessage: (message: string) => void,
      addAssistantMessage: (message: string) => void
    ) => {
      logger.debug(
        '[DEBUG] executeCommand 被调用，输入:',
        command,
        '处理中:',
        isProcessing
      );

      if (command.trim() && !isProcessing) {
        const trimmedCommand = command.trim();

        // 清空上一轮对话的 todos
        appDispatch({ type: 'SET_TODOS', payload: [] });

        setIsProcessing(true);
        dispatch({ type: 'SET_THINKING', payload: true });

        try {
          const result = await handleCommandSubmit(
            trimmedCommand,
            addUserMessage,
            addAssistantMessage
          );

          if (!result.success && result.error) {
            dispatch({ type: 'SET_ERROR', payload: result.error });
          }
        } catch (error) {
          logger.debug('[ERROR] executeCommand 异常:', error);
          const errorMessage = error instanceof Error ? error.message : '未知错误';
          dispatch({ type: 'SET_ERROR', payload: `执行失败: ${errorMessage}` });
        } finally {
          setIsProcessing(false);
          setLoopState({
            active: false,
            turn: 0,
            maxTurns: 50,
            currentTool: undefined,
          });
          dispatch({ type: 'SET_THINKING', payload: false });
        }
      }
    }
  );

  return {
    isProcessing,
    executeCommand,
    loopState,
    handleAbort,
  };
};
