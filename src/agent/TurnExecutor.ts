/**
 * TurnExecutor - 单轮对话执行器
 */

import type { ChatService, Message } from '../services/ChatService.js';
import type { TurnExecutorConfig, TurnOptions, TurnResult } from './types.js';

export class TurnExecutor {
  constructor(
    private chatService: ChatService,
    private config: TurnExecutorConfig
  ) {}

  /**
   * 执行单轮对话 - 带重试机制
   */
  async execute(
    messages: Message[],
    tools: Array<{
      name: string;
      description: string;
      parameters: any;
    }>,
    options: TurnOptions = {}
  ): Promise<TurnResult> {
    const maxRetries = options.maxRetries || 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        return await this.tryExecuteTurn(messages, tools, options);
      } catch (error) {
        if (this.isRetriableError(error)) {
          retries++;
          console.log(`🔄 重试 ${retries}/${maxRetries}...`);

          // 指数退避策略：1s → 2s → 4s
          await this.delay(1000 * Math.pow(2, retries - 1));
        } else {
          // 非可重试错误，直接抛出
          throw error;
        }
      }
    }

    throw new Error(`达到最大重试次数 ${maxRetries}`);
  }

  /**
   * 尝试执行单轮 - 支持流式处理
   */
  private async tryExecuteTurn(
    messages: Message[],
    tools: Array<{
      name: string;
      description: string;
      parameters: any;
    }>,
    options: TurnOptions
  ): Promise<TurnResult> {
    // 调用 ChatService
    const response = await this.chatService.chat(messages, tools);

    // 如果支持流式处理，触发回调（未来扩展）
    if (options.stream && options.onTextDelta) {
      const content = typeof response.content === 'string' ? response.content : '';
      if (content) {
        options.onTextDelta(content);
      }
    }

    // 返回统一的 TurnResult (直接透传,类型已统一)
    return {
      content: typeof response.content === 'string' ? response.content : '',
      tool_calls: response.tool_calls,
      usage: response.usage,
    };
  }

  /**
   * 判断错误是否可重试
   * 网络错误、流中断、超时等可重试
   */
  private isRetriableError(error: any): boolean {
    // 网络错误代码
    const retriableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'];

    // 可重试的错误消息关键词
    const retriableMessages = [
      'stream closed',
      'connection reset',
      'timeout',
      'network error',
      'socket hang up',
    ];

    // 检查错误代码
    if (error.code && retriableCodes.includes(error.code)) {
      return true;
    }

    // 检查错误消息
    const errorMessage = error.message?.toLowerCase() || '';
    return retriableMessages.some((msg) => errorMessage.includes(msg));
  }

  /**
   * 延迟工具函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
