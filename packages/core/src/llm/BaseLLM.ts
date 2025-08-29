/**
 * 极简通用LLM基类
 * 适配开放AI协议的通用调用
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model?: string;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

/**
 * 极简通用LLM基类
 * 提供最基本的重试和调用机制
 */
export abstract class BaseLLM {
  protected retryConfig: RetryConfig;

  constructor() {
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2,
    };
  }

  /**
   * 抽象方法：发送请求到 LLM 服务
   */
  protected abstract sendRequest(request: LLMRequest): Promise<LLMResponse>;

  /**
   * 公共方法：带重试机制的聊天
   */
  public async chat(request: LLMRequest): Promise<LLMResponse> {
    return this.withRetry(async () => {
      return await this.sendRequest(request);
    });
  }

  /**
   * 便捷方法：发送单条消息
   */
  public async sendMessage(
    content: string,
    role: 'user' | 'system' = 'user'
  ): Promise<string> {
    const request: LLMRequest = {
      messages: [{ role, content }],
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

        // 计算延迟时间
        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    throw lastError!;
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
}