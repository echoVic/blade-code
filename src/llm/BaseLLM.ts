import { BaseComponent } from '../agent/BaseComponent.js';

/**
 * LLM 消息接口
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * LLM 请求参数
 */
export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

/**
 * LLM 响应接口
 */
export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model?: string;
}

/**
 * 重试配置
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

/**
 * 基础 LLM 组件类
 */
export abstract class BaseLLM extends BaseComponent {
  protected retryConfig: RetryConfig;
  protected defaultModel: string;

  constructor(name: string, defaultModel: string = 'gpt-3.5-turbo') {
    super(name);
    this.defaultModel = defaultModel;
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
    };
  }

  /**
   * 设置重试配置
   */
  public setRetryConfig(config: Partial<RetryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config };
  }

  /**
   * 抽象方法：发送请求到 LLM 服务
   */
  protected abstract sendRequest(request: LLMRequest): Promise<LLMResponse>;

  /**
   * 公共方法：带重试机制的聊天
   */
  public async chat(request: LLMRequest): Promise<LLMResponse> {
    // 设置默认模型
    if (!request.model) {
      request.model = this.defaultModel;
    }

    return this.withRetry(async () => {
      return await this.sendRequest(request);
    });
  }

  /**
   * 便捷方法：发送单条消息
   */
  public async sendMessage(
    content: string,
    role: 'user' | 'system' = 'user',
    options?: Partial<LLMRequest>
  ): Promise<string> {
    const request: LLMRequest = {
      messages: [{ role, content }],
      ...options,
    };

    const response = await this.chat(request);
    return response.content;
  }

  /**
   * 便捷方法：多轮对话
   */
  public async conversation(
    messages: LLMMessage[],
    options?: Partial<LLMRequest>
  ): Promise<string> {
    const request: LLMRequest = {
      messages,
      ...options,
    };

    const response = await this.chat(request);
    return response.content;
  }

  /**
   * 重试机制实现
   */
  protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // 如果是最后一次尝试，直接抛出错误
        if (attempt === this.retryConfig.maxRetries) {
          throw lastError;
        }

        // 检查是否应该重试
        if (!this.shouldRetry(error as Error)) {
          throw lastError;
        }

        // 计算延迟时间
        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    throw lastError!;
  }

  /**
   * 判断是否应该重试
   */
  protected shouldRetry(error: Error): boolean {
    // 检查错误类型，某些错误不应该重试
    const errorMessage = error.message.toLowerCase();

    // 网络错误或临时服务错误应该重试
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('503') ||
      errorMessage.includes('502') ||
      errorMessage.includes('500')
    ) {
      return true;
    }

    // 认证错误、参数错误等不应该重试
    if (
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('invalid') ||
      errorMessage.includes('400') ||
      errorMessage.includes('401') ||
      errorMessage.includes('403')
    ) {
      return false;
    }

    // 默认重试
    return true;
  }

  /**
   * 计算延迟时间（指数退避）
   */
  protected calculateDelay(attempt: number): number {
    const delay = this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt);
    return Math.min(delay, this.retryConfig.maxDelay);
  }

  /**
   * 睡眠函数
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 验证请求参数
   */
  protected validateRequest(request: LLMRequest): void {
    if (!request.messages || request.messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    for (const message of request.messages) {
      if (!message.role || !message.content) {
        throw new Error('Each message must have role and content');
      }
    }
  }
}
