/**
 * Token 计算服务
 * 用于计算消息的 token 数量，判断是否需要压缩
 */

import { encodingForModel } from 'js-tiktoken';
import type { Message } from '../services/ChatServiceInterface.js';

/**
 * Token Counter - 计算和管理 token 数量
 */
export class TokenCounter {
  private static encodingCache = new Map<string, any>();

  /**
   * 计算消息列表的 token 数量
   *
   * @param messages - 消息列表
   * @param modelName - 模型名称
   * @returns token 总数
   */
  static countTokens(messages: Message[], modelName: string): number {
    const encoding = this.getEncoding(modelName);
    let totalTokens = 0;

    for (const msg of messages) {
      // 每条消息的固定开销
      totalTokens += 4;

      // Role 字段
      if (msg.role) {
        totalTokens += encoding.encode(msg.role).length;
      }

      // Content 字段
      if (msg.content) {
        if (typeof msg.content === 'string') {
          totalTokens += encoding.encode(msg.content).length;
        } else {
          // 处理复杂 content（如 vision）
          totalTokens += encoding.encode(JSON.stringify(msg.content)).length;
        }
      }

      // 工具调用
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        totalTokens += this.countToolCallTokens(msg.tool_calls, encoding);
      }

      // Name 字段
      if (msg.name) {
        totalTokens += encoding.encode(msg.name).length;
      }
    }

    return totalTokens;
  }

  /**
   * 获取 token 限制（直接返回配置的 maxTokens）
   *
   * @param maxTokens - 配置的 token 限制
   * @returns token 限制
   */
  static getTokenLimit(maxTokens: number): number {
    return maxTokens;
  }

  /**
   * 检查是否需要压缩
   *
   * @param messages - 消息列表
   * @param modelName - 模型名称（用于 token 计算）
   * @param maxTokens - 配置的 token 限制
   * @param thresholdPercent - 触发阈值百分比（默认 0.8，即 80%）
   * @returns 是否需要压缩
   */
  static shouldCompact(
    messages: Message[],
    modelName: string,
    maxTokens: number,
    thresholdPercent: number = 0.8
  ): boolean {
    const currentTokens = this.countTokens(messages, modelName);
    const threshold = Math.floor(maxTokens * thresholdPercent);

    return currentTokens >= threshold;
  }

  /**
   * 获取或创建 encoding
   *
   * @param modelName - 模型名称
   * @returns encoding 实例
   */
  private static getEncoding(modelName: string): any {
    if (!this.encodingCache.has(modelName)) {
      try {
        // 尝试获取模型的 encoding
        const encoding = encodingForModel(modelName as any);
        this.encodingCache.set(modelName, encoding);
      } catch {
        // 如果模型不支持，使用 cl100k_base（GPT-4 的 encoding）
        try {
          const encoding = encodingForModel('gpt-4' as any);
          this.encodingCache.set(modelName, encoding);
        } catch {
          // 最后的降级方案：使用粗略估算
          console.warn(
            `[TokenCounter] 无法为模型 ${modelName} 获取 encoding，使用粗略估算`
          );
          this.encodingCache.set(modelName, {
            encode: (text: string) => {
              // 粗略估算：1 token ≈ 4 字符
              return new Array(Math.ceil(text.length / 4));
            },
          });
        }
      }
    }

    return this.encodingCache.get(modelName);
  }

  /**
   * 计算工具调用的 token 数量
   *
   * @param toolCalls - 工具调用列表
   * @param encoding - encoding 实例
   * @returns token 数量
   */
  private static countToolCallTokens(toolCalls: any[], encoding: any): number {
    let tokens = 0;

    for (const call of toolCalls) {
      // 工具调用的固定开销
      tokens += 4;

      // 函数名
      if (call.function?.name) {
        tokens += encoding.encode(call.function.name).length;
      }

      // 参数
      if (call.function?.arguments) {
        const args =
          typeof call.function.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function.arguments);
        tokens += encoding.encode(args).length;
      }

      // ID
      if (call.id) {
        tokens += encoding.encode(call.id).length;
      }
    }

    return tokens;
  }

  /**
   * 清理 encoding 缓存
   * （用于释放内存）
   */
  static clearCache(): void {
    this.encodingCache.clear();
  }

  /**
   * 估算文本的 token 数量（快速粗略估算）
   *
   * @param text - 文本内容
   * @returns 估算的 token 数量
   */
  static estimateTokens(text: string): number {
    // 粗略估算：1 token ≈ 4 字符（英文）或 1.5 字符（中文）
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;

    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }
}
