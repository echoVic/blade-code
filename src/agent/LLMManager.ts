/**
 * LLM 管理器
 * 负责 LLM 实例的创建、初始化和管理
 */

export interface LLMConfig {
  provider: 'qwen' | 'volcengine';
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/**
 * LLM 管理器
 * 适配新的平铺配置架构
 */
export class LLMManager {
  private config?: LLMConfig;
  private isInitialized = false;
  private debug = false;

  constructor(debug: boolean = false) {
    this.debug = debug;
  }

  /**
   * 配置 LLM
   */
  public configure(config: LLMConfig): void {
    this.config = config;
    this.log(`LLM 已配置: ${config.provider}`);
  }

  /**
   * 初始化 LLM
   */
  public async init(): Promise<void> {
    if (!this.config) {
      throw new Error('LLM 未配置，请先调用 configure()');
    }

    if (this.isInitialized) {
      this.log('LLM 已经初始化');
      return;
    }

    this.isInitialized = true;
    this.log(`${this.config.provider} LLM 初始化完成`);
  }

  /**
   * 销毁 LLM
   */
  public async destroy(): Promise<void> {
    this.log('LLM 已销毁');
    this.isInitialized = false;
  }

  /**
   * 检查 LLM 是否可用
   */
  public isAvailable(): boolean {
    return this.isInitialized;
  }

  /**
   * 获取 LLM 提供商名称
   */
  public getProvider(): string | null {
    return this.config?.provider || null;
  }

  /**
   * 基础聊天
   */
  public async chat(message: string): Promise<string> {
    this.ensureLLMAvailable();
    this.log(`发送消息: ${message.substring(0, 50)}...`);
    return `模拟回复: ${message}`;
  }

  /**
   * 多轮对话
   */
  public async conversation(messages: any[]): Promise<string> {
    this.ensureLLMAvailable();
    this.log(`开始多轮对话，消息数: ${messages.length}`);
    return '模拟对话回复';
  }

  /**
   * 系统提示词聊天
   */
  public async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    return await this.conversation(messages);
  }

  /**
   * 获取状态信息
   */
  public getStatus() {
    return {
      isInitialized: this.isInitialized,
      isAvailable: this.isAvailable(),
      provider: this.getProvider(),
    };
  }

  /**
   * 确保 LLM 可用
   */
  private ensureLLMAvailable(): void {
    if (!this.isAvailable()) {
      throw new Error('LLM 未初始化或不可用');
    }
  }

  /**
   * 日志记录
   */
  private log(message: string): void {
    if (this.debug) {
      console.log(`[LLMManager] ${message}`);
    }
  }
}