/**
 * AnthropicChatService - Anthropic Claude API 实现
 *
 * 当前状态: 未实现（伪代码占位）
 *
 * TODO 未来实现清单:
 * 1. 安装依赖: pnpm add @anthropic-ai/sdk
 * 2. 实现 Messages API 请求转换
 * 3. 实现响应格式转换
 * 4. 实现流式响应
 * 5. 实现工具调用（Function Calling）
 *
 * 参考文档:
 * - https://docs.anthropic.com/claude/reference/messages_post
 */

import type {
  ChatConfig,
  ChatResponse,
  IChatService,
  Message,
  StreamChunk,
} from './ChatServiceInterface.js';

export class AnthropicChatService implements IChatService {
  constructor(private config: ChatConfig) {
    // 构造函数不抛出错误，让工厂函数处理
  }

  async chat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: any }>
  ): Promise<ChatResponse> {
    throw new Error('AnthropicChatService.chat() not implemented');
  }

  async *streamChat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: any }>
  ): AsyncGenerator<StreamChunk, void, unknown> {
    throw new Error('AnthropicChatService.streamChat() not implemented');
  }
}

/*
 * ============================================================
 * 未来实现参考代码（伪代码）
 * ============================================================

import Anthropic from '@anthropic-ai/sdk';

export class AnthropicChatService implements IChatService {
  private client: Anthropic;

  constructor(private config: ChatConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async chat(messages: Message[], tools?: any[]): Promise<ChatResponse> {
    // 1. 分离 system message
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    // 2. 转换消息格式
    const anthropicMessages = conversationMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));

    // 3. 发送请求
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: systemMessage?.content,
      messages: anthropicMessages,
      temperature: this.config.temperature,
      tools: tools ? this.convertToolsFormat(tools) : undefined,
    });

    // 4. 转换响应格式
    return {
      content: response.content[0].type === 'text'
        ? response.content[0].text
        : '',
      toolCalls: this.extractToolCalls(response.content),
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async *streamChat(messages: Message[], tools?: any[]): AsyncGenerator<StreamChunk> {
    // 实现流式响应...
  }

  private convertToolsFormat(tools: any[]) {
    // 转换工具定义格式...
  }

  private extractToolCalls(content: any[]) {
    // 提取工具调用...
  }
}
*/
