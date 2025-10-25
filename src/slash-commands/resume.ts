/**
 * Resume Slash Command
 * 恢复历史会话
 */

import { SessionService } from '../services/SessionService.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume a conversation',
  fullDescription:
    '恢复历史会话。可以指定 sessionId 直接恢复，或不带参数打开会话选择器',
  usage: '/resume [sessionId]',
  aliases: ['r'],
  category: 'Session',
  examples: ['/resume - 打开会话选择器', '/resume abc123xyz - 直接恢复指定的会话'],
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    const { addAssistantMessage, restoreSession } = context;

    // 情况 1: 提供了 sessionId,直接恢复
    if (args.length > 0) {
      const sessionId = args[0];

      try {
        // 加载会话消息
        const messages = await SessionService.loadSession(sessionId);

        if (messages.length === 0) {
          addAssistantMessage(`❌ 会话 \`${sessionId}\` 为空或无法加载`);
          return {
            success: false,
            error: '会话为空',
          };
        }

        // 调用 restoreSession 恢复会话
        if (restoreSession) {
          // 转换为 SessionMessage 格式
          const sessionMessages = messages
            .filter((msg) => msg.role !== 'tool')
            .map((msg, index) => ({
              id: `restored-${Date.now()}-${index}`,
              role: msg.role as 'user' | 'assistant' | 'system',
              content:
                typeof msg.content === 'string'
                  ? msg.content
                  : JSON.stringify(msg.content),
              timestamp: Date.now() - (messages.length - index) * 1000,
            }));

          restoreSession(sessionId, sessionMessages);

          addAssistantMessage(
            `✅ 已恢复会话 \`${sessionId}\`\n\n共 ${sessionMessages.length} 条消息已加载，可以继续对话`
          );

          return {
            success: true,
            message: 'session_restored',
            data: {
              sessionId,
              messageCount: sessionMessages.length,
            },
          };
        }

        addAssistantMessage('❌ 无法恢复会话: restoreSession 函数不可用');
        return {
          success: false,
          error: 'restoreSession 不可用',
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知错误';
        addAssistantMessage(`❌ 加载会话失败: ${errorMessage}`);
        return {
          success: false,
          error: `加载会话失败: ${errorMessage}`,
        };
      }
    }

    // 情况 2: 没有提供 sessionId,显示会话选择器
    try {
      const sessions = await SessionService.listSessions();

      if (sessions.length === 0) {
        addAssistantMessage(
          '📭 **没有找到历史会话**\n\n开始一次对话后,会话历史将自动保存到 `~/.blade/projects/`'
        );
        return {
          success: true,
          message: '没有可用会话',
        };
      }

      // 返回特殊消息,触发 UI 显示会话选择器
      return {
        success: true,
        message: 'show_session_selector',
        data: {
          sessions,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      addAssistantMessage(`❌ 获取会话列表失败: ${errorMessage}`);
      return {
        success: false,
        error: `获取会话列表失败: ${errorMessage}`,
      };
    }
  },
};

export default resumeCommand;
