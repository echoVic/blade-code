import { useMemoizedFn } from 'ahooks';
import { useEffect, useRef, useState } from 'react';
import { Agent } from '../../agent/Agent.js';
import { ConfigManager } from '../../config/config-manager.js';
import {
  executeSlashCommand,
  isSlashCommand,
  type SlashCommandContext,
} from '../../slash-commands/index.js';
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
export const useCommandHandler = (systemPrompt?: string) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [loopState, setLoopState] = useState<LoopState>({
    active: false,
    turn: 0,
    maxTurns: 50,
    currentTool: undefined,
  });
  const { dispatch } = useSession();
  const { dispatch: appDispatch, actions: appActions } = useAppState();
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

  // Agent创建函数已准备就绪

  // 处理命令提交
  const handleCommandSubmit = useMemoizedFn(
    async (
      command: string,
      addUserMessage: (message: string) => void,
      addAssistantMessage: (message: string) => void
    ): Promise<CommandResult> => {
      console.log('[DEBUG] handleCommandSubmit 被调用，命令:', command);

      try {
        console.log('[DEBUG] 添加用户消息到UI');
        addUserMessage(command);

        // 检查是否为 slash command
        if (isSlashCommand(command)) {
          console.log('[DEBUG] 检测到 slash command，执行中...');

          const configManager = new ConfigManager();
          await configManager.initialize();

          const slashContext: SlashCommandContext = {
            cwd: process.cwd(),
            addUserMessage,
            addAssistantMessage,
            configManager,
          };

          const slashResult = await executeSlashCommand(command, slashContext);

          // 检查是否需要显示主题选择器
          if (slashResult.message === 'show_theme_selector') {
            appDispatch(appActions.showThemeSelector());
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

            // 清理旧的 Agent 事件监听器
            if (agentRef.current) {
              agentRef.current.removeAllListeners();
            }

            // 处理 AI 分析
            const agent = await Agent.create({ systemPrompt });
            agentRef.current = agent;

            // 监听 Agent 事件
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
              setLoopState({
                active: false,
                turn: 0,
                maxTurns: 50,
                currentTool: undefined,
              });
            });
            agent.on('taskFailed', () => {
              setLoopState({
                active: false,
                turn: 0,
                maxTurns: 50,
                currentTool: undefined,
              });
            });
            agent.on('taskAborted', () => {
              setLoopState({
                active: false,
                turn: 0,
                maxTurns: 50,
                currentTool: undefined,
              });
            });

            // 创建新的 AbortController
            abortControllerRef.current = new AbortController();

            const chatContext = {
              messages: [],
              userId: 'cli-user',
              sessionId: `session-${Date.now()}`,
              workspaceRoot: process.cwd(),
              signal: abortControllerRef.current.signal,
            };

            try {
              const aiOutput = await agent.chat(analysisPrompt, chatContext);

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

        console.log('[DEBUG] 普通命令，发送给 Agent...');

        // 清理旧的 Agent 事件监听器
        if (agentRef.current) {
          agentRef.current.removeAllListeners();
        }

        const agent = await Agent.create({ systemPrompt });
        agentRef.current = agent;

        // 监听 Agent 事件
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
          setLoopState({
            active: false,
            turn: 0,
            maxTurns: 50,
            currentTool: undefined,
          });
        });
        agent.on('taskFailed', () => {
          setLoopState({
            active: false,
            turn: 0,
            maxTurns: 50,
            currentTool: undefined,
          });
        });
        agent.on('taskAborted', () => {
          setLoopState({
            active: false,
            turn: 0,
            maxTurns: 50,
            currentTool: undefined,
          });
        });

        // 创建新的 AbortController
        abortControllerRef.current = new AbortController();

        const chatContext = {
          messages: [],
          userId: 'cli-user',
          sessionId: `session-${Date.now()}`,
          workspaceRoot: process.cwd(),
          signal: abortControllerRef.current.signal,
        };
        const output = await agent.chat(command, chatContext);

        console.log('[DEBUG] 命令执行结果:', output);

        // 如果返回空字符串，可能是用户中止
        if (!output || output.trim() === '') {
          addAssistantMessage('✋ 任务已停止');
          return {
            success: true,
            output: '任务已停止',
          };
        }

        console.log('[DEBUG] 添加助手消息到UI');
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

        console.log('[DEBUG] 开始处理命令:', trimmedCommand);
        setIsProcessing(true);
        dispatch({ type: 'SET_THINKING', payload: true });

        try {
          console.log('[DEBUG] 开始执行 handleCommandSubmit...');
          const result = await handleCommandSubmit(
            trimmedCommand,
            addUserMessage,
            addAssistantMessage
          );

          console.log('[DEBUG] handleCommandSubmit 完成，结果:', result);

          if (!result.success && result.error) {
            console.log('[DEBUG] 设置错误状态:', result.error);
            dispatch({ type: 'SET_ERROR', payload: result.error });
          } else {
            console.log('[DEBUG] 命令执行成功');
          }
        } catch (error) {
          console.log('[ERROR] executeCommand 异常:', error);
          const errorMessage = error instanceof Error ? error.message : '未知错误';
          dispatch({ type: 'SET_ERROR', payload: `执行失败: ${errorMessage}` });
        } finally {
          console.log('[DEBUG] 设置处理状态为 false');
          setIsProcessing(false);
          setLoopState({
            active: false,
            turn: 0,
            maxTurns: 50,
            currentTool: undefined,
          });
          dispatch({ type: 'SET_THINKING', payload: false });
        }
      } else {
        console.log('[DEBUG] 跳过提交 - 输入为空或正在处理中');
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
