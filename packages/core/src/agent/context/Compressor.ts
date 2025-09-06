/**
 * 上下文压缩器
 * 负责压缩和优化上下文数据
 */

import type { ChatMessage } from '../../services/ChatService.js';

export interface CompressionConfig {
  maxTokens?: number;
  maxMessages?: number;
  compressionRatio?: number;
  keepRecentMessages?: number;
}

export interface CompressedContext {
  summary: string;
  recentMessages: ChatMessage[];
  compressedTokens: number;
  originalTokens: number;
}

/**
 * 上下文压缩器类
 */
export class ContextCompressor {
  constructor(private config: CompressionConfig = {}) {
    this.config = {
      maxTokens: 4000,
      maxMessages: 50,
      compressionRatio: 0.7,
      keepRecentMessages: 10,
      ...config,
    };
  }

  /**
   * 压缩上下文
   */
  async compress(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const { maxMessages, maxTokens, keepRecentMessages } = this.config;

    // 如果消息数量在限制内，直接返回
    if (messages.length <= (maxMessages || 50)) {
      return messages;
    }

    // 保留最近的消息
    const recentCount = keepRecentMessages || 10;
    const recentMessages = messages.slice(-recentCount);

    // 计算需要压缩的消息数量
    const messagesToCompress = messages.slice(0, -recentCount);

    if (messagesToCompress.length === 0) {
      return recentMessages;
    }

    // 创建压缩后的摘要消息
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: await this.createSummary(messagesToCompress),
      metadata: {
        type: 'compressed_summary',
        originalMessageCount: messagesToCompress.length,
      },
    };

    // 返回压缩后的上下文
    return [summaryMessage, ...recentMessages];
  }

  /**
   * 创建上下文摘要
   */
  private async createSummary(messages: ChatMessage[]): Promise<string> {
    // 简化的摘要生成逻辑
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    const summary = `Previous conversation summary:
- ${userMessages.length} user messages
- ${assistantMessages.length} assistant responses
- Topics discussed: ${this.extractTopics(messages)}`;

    return summary;
  }

  /**
   * 提取话题
   */
  private extractTopics(messages: ChatMessage[]): string {
    // 简化的主题提取
    const contents = messages.map(m => m.content).join(' ');
    const words = contents.split(' ').slice(0, 20); // 取前20个词作为主题
    return words.join(', ');
  }

  /**
   * 估算token数量
   */
  private estimateTokens(messages: ChatMessage[]): number {
    const totalChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    // 粗略估算：1个token约等于4个字符
    return Math.ceil(totalChars / 4);
  }

  /**
   * 获取配置
   */
  getConfig(): CompressionConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<CompressionConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}
