import { useCallback, useState } from 'react';

import { createAgent } from '../../agent/agent-creator.js';
import { useSession } from '../contexts/SessionContext.js';
import {
  isSlashCommand,
  executeSlashCommand,
  type SlashCommandContext
} from '../../slash-commands/index.js';

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 命令处理 Hook
 * 负责命令的执行和状态管理
 */
export const useCommandHandler = (systemPrompt?: string) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const { dispatch } = useSession();

  // Agent创建函数已准备就绪

  // 处理命令提交
  const handleCommandSubmit = useCallback(
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

          const slashContext: SlashCommandContext = {
            cwd: process.cwd(),
            addUserMessage,
            addAssistantMessage
          };

          const slashResult = await executeSlashCommand(command, slashContext);

          if (!slashResult.success && slashResult.error) {
            addAssistantMessage(`❌ ${slashResult.error}`);
            return {
              success: slashResult.success,
              output: slashResult.message,
              error: slashResult.error,
              metadata: slashResult.data
            };
          }

          // /init 命令总是会触发 AI 分析
          if (slashResult.success && slashResult.message === 'trigger_analysis' && slashResult.data) {
            const { analysisPrompt } = slashResult.data;

            console.log('[DEBUG] 触发 AI 分析，提示:', analysisPrompt.substring(0, 100) + '...');

            // 处理 AI 分析
            const agent = await createAgent({ systemPrompt });
            const chatContext = {
              messages: [],
              userId: 'cli-user',
              sessionId: `session-${Date.now()}`,
              workspaceRoot: process.cwd(),
            };

            try {
              const aiOutput = await agent.chat(analysisPrompt, chatContext);
              addAssistantMessage(aiOutput);

              return {
                success: true,
                output: aiOutput,
                metadata: slashResult.data
              };
            } catch (aiError) {
              const aiErrorMessage = aiError instanceof Error ? aiError.message : '未知错误';
              addAssistantMessage(`❌ AI 分析失败: ${aiErrorMessage}`);
              return {
                success: false,
                error: `AI 分析失败: ${aiErrorMessage}`
              };
            }
          }

          return {
            success: slashResult.success,
            output: slashResult.message,
            error: slashResult.error,
            metadata: slashResult.data
          };
        }

        console.log('[DEBUG] 普通命令，发送给 Agent...');

        // 直接使用createAgent函数创建Agent并执行命令
        const agent = await createAgent({ systemPrompt });
        const chatContext = {
          messages: [],
          userId: 'cli-user',
          sessionId: `session-${Date.now()}`,
          workspaceRoot: process.cwd(),
        };
        const output = await agent.chat(command, chatContext);
        const result = { success: true, output };

        console.log('[DEBUG] 命令执行结果:', result);

        if (result.output) {
          console.log('[DEBUG] 添加助手消息到UI');
          addAssistantMessage(result.output);
        } else {
          // 成功但没有输出内容的情况
          console.log('[DEBUG] 命令执行成功但无输出内容');
          addAssistantMessage('✅ 处理完成');
        }

        return result;
      } catch (error) {
        console.log('[ERROR] handleCommandSubmit 异常:', error);
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        const errorResult = { success: false, error: errorMessage };
        addAssistantMessage(`❌ ${errorMessage}`);
        return errorResult;
      }
    },
    [systemPrompt]
  );

  // 处理提交
  const executeCommand = useCallback(
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
        console.log('[DEBUG] 设置处理状态为 true');
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
          dispatch({ type: 'SET_THINKING', payload: false });
        }
      } else {
        console.log('[DEBUG] 跳过提交 - 输入为空或正在处理中');
      }
    },
    [isProcessing, handleCommandSubmit, dispatch]
  );

  return {
    isProcessing,
    executeCommand,
  };
};
