import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef, useState } from 'react';
import { Agent } from '../../agent/Agent.js';
import { ConfigManager } from '../../config/ConfigManager.js';
import {
  executeSlashCommand,
  isSlashCommand,
  type SlashCommandContext,
} from '../../slash-commands/index.js';
import type { TodoItem } from '../../tools/builtin/todo/types.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import { useAppState } from '../contexts/AppContext.js';
import { useSession } from '../contexts/SessionContext.js';

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
 * 命令处理 Hook
 * 负责命令的执行和状态管理
 */
export const useCommandHandler = (
  replaceSystemPrompt?: string, // --system-prompt (完全替换)
  appendSystemPrompt?: string, // --append-system-prompt (追加)
  confirmationHandler?: ConfirmationHandler,
  maxTurns?: number // --max-turns (最大对话轮次)
) => {
  // 调试日志：追踪 confirmationHandler 参数接收
  console.log('[useCommandHandler] Received confirmationHandler parameter:', {
    hasHandler: !!confirmationHandler,
    hasMethod: !!confirmationHandler?.requestConfirmation,
    methodType: typeof confirmationHandler?.requestConfirmation,
  });

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

            console.log(
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
              onToolResult: async (toolCall: any, result: any) => {
                if (result && result.displayContent) {
                  addToolMessage(result.displayContent);
                }
              },
            };

            // 调试日志：追踪 chatContext 中的 confirmationHandler
            console.log(
              '[useCommandHandler] Created chatContext with confirmationHandler:',
              {
                hasHandler: !!chatContext.confirmationHandler,
                hasMethod: !!chatContext.confirmationHandler?.requestConfirmation,
                methodType: typeof chatContext.confirmationHandler?.requestConfirmation,
              }
            );

            try {
              const aiOutput = await agent.chat(analysisPrompt, chatContext, loopOptions);

              // 如果返回空字符串，可能是用户中止
              if (!aiOutput || aiOutput.trim() === '') {
                addAssistantMessage('✋ 任务已停止');
                return {
                  success: true,
                  output: '任务已停止',
                  metadata: slashResult.data,
                };
              }

              addAssistantMessage(aiOutput);

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
          // 工具执行结果回调：将工具输出添加到 UI
          onToolResult: async (toolCall: any, result: any) => {
            if (result && result.displayContent) {
              addToolMessage(result.displayContent);
            }
          },
        };

        // 调试日志：追踪 chatContext 中的 confirmationHandler（普通命令）
        console.log(
          '[useCommandHandler] Created chatContext (normal command) with confirmationHandler:',
          {
            hasHandler: !!chatContext.confirmationHandler,
            hasMethod: !!chatContext.confirmationHandler?.requestConfirmation,
            methodType: typeof chatContext.confirmationHandler?.requestConfirmation,
          }
        );

        const output = await agent.chat(command, chatContext, loopOptions);

        // 如果返回空字符串，可能是用户中止
        if (!output || output.trim() === '') {
          addAssistantMessage('✋ 任务已停止');
          return {
            success: true,
            output: '任务已停止',
          };
        }

        addAssistantMessage(output);

        return { success: true, output };
      } catch (error) {
        console.log('[ERROR] handleCommandSubmit 异常:', error);
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
      console.log(
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
          console.log('[ERROR] executeCommand 异常:', error);
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
