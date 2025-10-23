/**
 * /compact 命令 - 手动压缩上下文
 */

import { CompactionService } from '../context/CompactionService.js';
import { TokenCounter } from '../context/TokenCounter.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

/**
 * Compact 命令处理函数
 * 手动触发上下文压缩并显示统计信息
 */
async function compactCommandHandler(
  _args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const { addAssistantMessage, configManager } = context;

  try {
    // 获取配置
    if (!configManager) {
      return {
        success: false,
        error: '配置管理器未初始化',
      };
    }

    const config = configManager.getConfig();

    // 获取会话消息
    const sessionMessages = context.messages;

    if (!sessionMessages || sessionMessages.length === 0) {
      addAssistantMessage('⚠️ 当前会话没有消息，无需压缩');
      return {
        success: false,
        error: '没有消息需要压缩',
      };
    }

    // 转换 SessionMessage[] 为 Message[] (CompactionService 使用 ChatService 的 Message 类型)
    const messages = sessionMessages.map((msg) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
    }));

    // 显示压缩前信息
    const preTokens = TokenCounter.countTokens(messages, config.model);
    const tokenLimit = config.maxTokens;
    const usagePercent = ((preTokens / tokenLimit) * 100).toFixed(1);

    addAssistantMessage(`📊 **当前上下文统计**`);
    addAssistantMessage(`  • 消息数量: ${messages.length}`);
    addAssistantMessage(`  • Token 数量: ${preTokens.toLocaleString()}`);
    addAssistantMessage(`  • Token 限制: ${tokenLimit.toLocaleString()}`);
    addAssistantMessage(`  • 使用率: ${usagePercent}%`);
    addAssistantMessage('');

    // 检查是否需要压缩
    if (preTokens < tokenLimit * 0.5) {
      addAssistantMessage(
        `💡 提示: 当前 token 使用率较低（${usagePercent}%），可以暂时不压缩。`
      );
      addAssistantMessage('   系统会在达到 80% 时自动触发压缩。');
      return {
        success: true,
        message: '无需压缩',
      };
    }

    addAssistantMessage('⏳ **正在压缩上下文...**');

    // 执行压缩
    const result = await CompactionService.compact(messages, {
      trigger: 'manual',
      modelName: config.model,
      maxTokens: config.maxTokens,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });

    if (result.success) {
      // 保存压缩数据到 JSONL
      try {
        if (context.sessionId) {
          const { ContextManager } = await import('../context/ContextManager.js');
          // ContextManager 会自动使用 PersistentStore，它会从 cwd 推导项目路径
          // 这里不需要传参数，使用默认配置即可
          const contextMgr = new ContextManager();
          await contextMgr.saveCompaction(
            context.sessionId,
            result.summary,
            {
              trigger: 'manual',
              preTokens: result.preTokens,
              postTokens: result.postTokens,
              filesIncluded: result.filesIncluded,
            },
            null
          );
          console.log('[/compact] 压缩数据已保存到 JSONL');
        }
      } catch (saveError) {
        console.warn('[/compact] 保存压缩数据失败:', saveError);
        // 不阻塞用户反馈
      }

      // 显示成功信息
      addAssistantMessage('');
      addAssistantMessage('✅ **压缩完成！**');
      addAssistantMessage('');
      addAssistantMessage(`📉 **Token 变化**`);
      addAssistantMessage(`  • 压缩前: ${result.preTokens.toLocaleString()} tokens`);
      addAssistantMessage(`  • 压缩后: ${result.postTokens.toLocaleString()} tokens`);
      addAssistantMessage(
        `  • 压缩率: ${((1 - result.postTokens / result.preTokens) * 100).toFixed(1)}%`
      );

      if (result.filesIncluded.length > 0) {
        addAssistantMessage('');
        addAssistantMessage(`📁 **包含文件** (${result.filesIncluded.length})`);
        result.filesIncluded.forEach((file, i) => {
          addAssistantMessage(`  ${i + 1}. ${file}`);
        });
      }

      addAssistantMessage('');
      addAssistantMessage('💡 对话历史已压缩，但完整记录仍保存在会话文件中。');

      // 返回特殊消息，通知 UI 更新消息列表
      return {
        success: true,
        message: 'compact_completed',
        data: {
          compactedMessages: result.compactedMessages,
          boundaryMessage: result.boundaryMessage,
          summaryMessage: result.summaryMessage,
          preTokens: result.preTokens,
          postTokens: result.postTokens,
          filesIncluded: result.filesIncluded,
        },
      };
    } else {
      // 压缩失败，使用了降级策略
      addAssistantMessage('');
      addAssistantMessage('⚠️ **压缩使用降级策略**');
      addAssistantMessage('');
      addAssistantMessage(`📉 **Token 变化**`);
      addAssistantMessage(`  • 压缩前: ${result.preTokens.toLocaleString()} tokens`);
      addAssistantMessage(`  • 压缩后: ${result.postTokens.toLocaleString()} tokens`);
      addAssistantMessage('');
      addAssistantMessage('💡 由于压缩过程出现错误，已使用简单截断策略。');
      addAssistantMessage(`   错误信息: ${result.error}`);

      return {
        success: false,
        message: 'compact_fallback',
        error: result.error,
        data: {
          compactedMessages: result.compactedMessages,
          boundaryMessage: result.boundaryMessage,
          summaryMessage: result.summaryMessage,
          preTokens: result.preTokens,
          postTokens: result.postTokens,
        },
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    addAssistantMessage(`❌ **压缩失败**: ${errorMsg}`);

    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Compact 命令定义
 */
const compactCommand: SlashCommand = {
  name: 'compact',
  description: '手动压缩当前会话的上下文',
  fullDescription:
    '压缩当前对话历史，生成详细的技术总结，保留最近的消息。压缩后的上下文可以节省 token 使用量，同时保留关键信息。',
  usage: '/compact',
  examples: ['/compact'],
  category: 'context',
  handler: compactCommandHandler,
};

export default compactCommand;
