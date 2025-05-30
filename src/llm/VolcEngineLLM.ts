import OpenAI from 'openai';
import { BaseLLM, LLMRequest, LLMResponse } from './BaseLLM.js';

/**
 * 火山方舟配置接口
 */
export interface VolcEngineConfig {
  apiKey: string;
  baseURL?: string;
  endpointId?: string;
}

/**
 * 火山方舟 LLM 实现
 * 基于 OpenAI 兼容的 API 接口
 */
export class VolcEngineLLM extends BaseLLM {
  private client: OpenAI;
  private config: VolcEngineConfig;

  constructor(config: VolcEngineConfig, defaultModel: string = 'ep-20250417144747-rgffm') {
    super('volcengine-llm', defaultModel);
    this.config = config;

    // 初始化 OpenAI 客户端，使用火山方舟的 API 端点
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || 'https://ark.cn-beijing.volces.com/api/v3',
    });
  }

  /**
   * 初始化组件
   */
  public async init(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('VolcEngine API key is required');
    }

    // 验证 API 连接
    try {
      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize VolcEngine LLM: ${error}`);
    }
  }

  /**
   * 发送请求到火山方舟
   */
  protected async sendRequest(request: LLMRequest): Promise<LLMResponse> {
    this.validateRequest(request);

    try {
      const completion = await this.client.chat.completions.create({
        model: request.model || this.defaultModel,
        messages: request.messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 2048,
        stream: false,
      });

      const choice = completion.choices[0];
      if (!choice || !choice.message) {
        throw new Error('Invalid response from VolcEngine API');
      }

      return {
        content: choice.message.content || '',
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : undefined,
        model: completion.model,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`VolcEngine API error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 测试 API 连接
   */
  private async testConnection(): Promise<void> {
    try {
      await this.client.chat.completions.create({
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10,
      });
    } catch (error) {
      throw new Error(`Connection test failed: ${error}`);
    }
  }

  /**
   * 流式聊天（火山方舟支持）
   */
  public async streamChat(
    request: LLMRequest,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    this.validateRequest(request);

    return this.withRetry(async () => {
      try {
        const stream = await this.client.chat.completions.create({
          model: request.model || this.defaultModel,
          messages: request.messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: request.temperature || 0.7,
          max_tokens: request.maxTokens || 2048,
          stream: true,
        });

        let fullContent = '';
        let usage: any = undefined;
        let model: string | undefined = undefined;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            onChunk(delta.content);
          }

          if (chunk.usage) {
            usage = chunk.usage;
          }

          if (chunk.model) {
            model = chunk.model;
          }
        }

        return {
          content: fullContent,
          usage: usage
            ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              }
            : undefined,
          model: model,
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`VolcEngine streaming error: ${error.message}`);
        }
        throw error;
      }
    });
  }

  /**
   * 获取可用模型列表
   */
  public async getModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      return models.data.map(model => model.id);
    } catch (error) {
      throw new Error(`Failed to get models: ${error}`);
    }
  }
}
