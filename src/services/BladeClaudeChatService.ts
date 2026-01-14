/**
 * Blade Claude ChatService 适配器
 * 桥接私有包 blade-auth-service 和 Blade 的 IChatService 接口
 */

import { BladeChatService } from 'blade-auth-service';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  ChatConfig,
  ChatResponse,
  ContentPart,
  IChatService,
  Message,
  StreamChunk,
  UsageInfo,
} from './ChatServiceInterface.js';

const logger = createLogger(LogCategory.CHAT);

/**
 * Blade Claude ChatService 适配器
 * 将私有包的接口适配到 Blade 的 IChatService
 */
export class BladeClaudeChatService implements IChatService {
  private config: ChatConfig;
  private service: any = null;

  constructor(config: ChatConfig) {
    this.config = config;
  }

  /**
   * 初始化私有包服务（懒加载）
   */
  private ensureService(): void {
    if (this.service) {
      return;
    }

    this.service = new BladeChatService({
      model: this.config.model,
      temperature: this.config.temperature,
      maxContextTokens: this.config.maxContextTokens,
      maxOutputTokens: this.config.maxOutputTokens,
      timeout: this.config.timeout,
    });
  }

  /**
   * 转换消息格式（Blade → 私有包）
   */
  private convertMessages(messages: Message[]): any[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      reasoningContent: msg.reasoningContent,
      tool_call_id: msg.tool_call_id,
      name: msg.name,
      tool_calls: msg.tool_calls,
    }));
  }

  /**
   * 转换工具格式（Blade → 私有包）
   */
  private convertTools(
    tools?: Array<{ name: string; description: string; parameters: unknown }>
  ): any[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * 转换响应格式（私有包 → Blade）
   */
  private convertResponse(response: any): ChatResponse {
    return {
      content: response.content,
      reasoningContent: response.reasoningContent,
      toolCalls: response.toolCalls as ChatCompletionMessageToolCall[] | undefined,
      usage: response.usage as UsageInfo | undefined,
    };
  }

  /**
   * 转换流式响应（私有包 → Blade）
   */
  private convertStreamChunk(chunk: any): StreamChunk {
    return {
      content: chunk.content,
      reasoningContent: chunk.reasoningContent,
      toolCalls: chunk.toolCalls,
      finishReason: chunk.finishReason,
      usage: chunk.usage as UsageInfo | undefined,
    };
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    this.ensureService();

    const convertedMessages = this.convertMessages(messages);
    const convertedTools = this.convertTools(tools);

    const response = await this.service.chat(convertedMessages, convertedTools, signal);

    return this.convertResponse(response);
  }

  /**
   * 发送聊天请求（流式）
   */
  async *streamChat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.ensureService();

    const convertedMessages = this.convertMessages(messages);
    const convertedTools = this.convertTools(tools);

    const stream = this.service.streamChat(convertedMessages, convertedTools, signal);

    for await (const chunk of stream) {
      yield this.convertStreamChunk(chunk);
    }
  }

  /**
   * 获取配置
   */
  getConfig(): ChatConfig {
    return this.config;
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ChatConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // 如果服务已初始化，也更新服务配置
    if (this.service) {
      this.service.updateConfig({
        model: newConfig.model,
        temperature: newConfig.temperature,
        maxContextTokens: newConfig.maxContextTokens,
        maxOutputTokens: newConfig.maxOutputTokens,
        timeout: newConfig.timeout,
      });
    }
  }
}
