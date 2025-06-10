import { getProviderConfig } from '../config/defaults.js';
import type { LLMMessage, LLMRequest } from '../llm/BaseLLM.js';
import { QwenLLM } from '../llm/QwenLLM.js';
import { VolcEngineLLM } from '../llm/VolcEngineLLM.js';

/**
 * LLM 配置接口
 */
export interface LLMConfig {
  provider: 'qwen' | 'volcengine';
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/**
 * LLM 管理器
 * 负责 LLM 实例的创建、初始化和管理
 */
export class LLMManager {
  private llm?: QwenLLM | VolcEngineLLM;
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

    const { provider, apiKey, model, baseURL } = this.config;

    // 获取默认配置
    const defaultConfig = getProviderConfig(provider);

    // 验证API密钥（优先使用传入的，然后是环境变量）
    let finalApiKey: string;
    try {
      // 导入validateApiKey函数
      const { validateApiKey } = await import('../config/defaults.js');
      finalApiKey = validateApiKey(provider, apiKey);
    } catch (error) {
      throw new Error(`API密钥验证失败: ${(error as Error).message}`);
    }

    const finalModel = model || defaultConfig.defaultModel;

    this.log(`初始化 ${provider} LLM...`);

    // 创建 LLM 实例
    switch (provider) {
      case 'qwen':
        this.llm = new QwenLLM(
          {
            apiKey: finalApiKey,
            baseURL: baseURL || defaultConfig.baseURL,
          },
          finalModel
        );
        break;
      case 'volcengine':
        this.llm = new VolcEngineLLM(
          {
            apiKey: finalApiKey,
            baseURL: baseURL || defaultConfig.baseURL,
          },
          finalModel
        );
        break;
      default:
        throw new Error(`不支持的 LLM 提供商: ${provider}`);
    }

    // 初始化 LLM
    await this.llm.init();
    this.isInitialized = true;
    this.log(`${provider} LLM 初始化完成`);
  }

  /**
   * 销毁 LLM
   */
  public async destroy(): Promise<void> {
    if (this.llm) {
      await this.llm.destroy();
      this.log('LLM 已销毁');
    }
    this.llm = undefined;
    this.isInitialized = false;
  }

  /**
   * 检查 LLM 是否可用
   */
  public isAvailable(): boolean {
    return !!this.llm && this.isInitialized;
  }

  /**
   * 获取 LLM 提供商名称
   */
  public getProvider(): string | null {
    if (!this.llm) return null;
    return this.llm instanceof QwenLLM ? 'qwen' : 'volcengine';
  }

  /**
   * 获取 LLM 实例
   */
  public getInstance(): QwenLLM | VolcEngineLLM | undefined {
    return this.llm;
  }

  /**
   * 基础聊天
   */
  public async chat(message: string): Promise<string> {
    this.ensureLLMAvailable();

    this.log(`发送消息: ${message.substring(0, 50)}...`);
    const response = await this.llm!.sendMessage(message);
    this.log(`收到回复: ${response.substring(0, 50)}...`);
    return response;
  }

  /**
   * 多轮对话
   */
  public async conversation(messages: LLMMessage[]): Promise<string> {
    this.ensureLLMAvailable();

    this.log(`开始多轮对话，消息数: ${messages.length}`);
    const response = await this.llm!.conversation(messages);
    this.log(`对话完成: ${response.substring(0, 50)}...`);
    return response;
  }

  /**
   * 流式聊天
   */
  public async streamChat(
    messages: LLMMessage[],
    onChunk: (chunk: string) => void
  ): Promise<string> {
    this.ensureLLMAvailable();

    if (this.llm instanceof QwenLLM && this.llm.streamChat) {
      this.log('开始流式对话...');
      const response = await this.llm.streamChat({ messages }, onChunk);
      this.log('流式对话完成');
      return response.content;
    } else {
      // 降级到普通聊天
      this.log('流式聊天不支持，降级到普通聊天');
      const request: LLMRequest = { messages };
      const response = await this.llm!.chat(request);
      onChunk(response.content);
      return response.content;
    }
  }

  /**
   * 系统提示词聊天
   */
  public async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    return await this.conversation(messages);
  }

  /**
   * 代码生成
   */
  public async generateCode(description: string, language: string = 'javascript'): Promise<string> {
    const prompt = `请用 ${language} 语言生成代码，要求：${description}。只返回代码，不要解释。`;
    return await this.chat(prompt);
  }

  /**
   * 文本摘要
   */
  public async summarize(text: string): Promise<string> {
    const prompt = `请总结以下内容的要点：\n\n${text}`;
    return await this.chat(prompt);
  }

  /**
   * 代码审查
   */
  public async reviewCode(code: string, language: string): Promise<string> {
    const prompt = `请审查以下 ${language} 代码，指出潜在问题和改进建议：

\`\`\`${language}
${code}
\`\`\`

请从以下角度分析：
1. 代码质量
2. 性能优化
3. 安全性
4. 可维护性`;

    return await this.chat(prompt);
  }

  /**
   * 情绪分析
   */
  public async analyzeSentiment(text: string): Promise<string> {
    const prompt = `请分析以下文本的情绪倾向（积极/消极/中性），并给出简短分析：\n\n"${text}"`;
    return await this.chat(prompt);
  }

  /**
   * 智能问答
   */
  public async ask(question: string): Promise<string> {
    this.log(`收到问题: ${question}`);
    const response = await this.chat(question);
    this.log(`生成回答: ${response.substring(0, 50)}...`);
    return response;
  }

  /**
   * 使用 Qwen 的 Function Call 功能
   */
  public async functionCall(messages: any[], toolsOrFunctions: any[], options?: any): Promise<any> {
    this.ensureLLMAvailable();

    if (this.llm instanceof QwenLLM) {
      // 使用智能格式选择
      return await this.llm.smartFunctionCall(messages, toolsOrFunctions, options);
    } else {
      throw new Error('Function call 仅支持 Qwen 模型');
    }
  }

  /**
   * 解析工具调用结果
   */
  public parseToolCallResult(completion: any): any {
    this.ensureLLMAvailable();

    if (this.llm instanceof QwenLLM) {
      return this.llm.parseToolCallResult(completion);
    } else {
      throw new Error('工具调用结果解析仅支持 Qwen 模型');
    }
  }

  /**
   * 执行完整的工具调用工作流
   */
  public async executeToolWorkflow(
    messages: any[],
    availableTools: any[],
    toolExecutor: (toolName: string, args: any) => Promise<any>,
    options?: any
  ): Promise<any> {
    this.ensureLLMAvailable();

    if (this.llm instanceof QwenLLM) {
      return await this.llm.executeToolWorkflow(messages, availableTools, toolExecutor, options);
    } else {
      throw new Error('工具调用工作流仅支持 Qwen 模型');
    }
  }

  /**
   * 获取状态信息
   */
  public getStatus() {
    return {
      isInitialized: this.isInitialized,
      isAvailable: this.isAvailable(),
      provider: this.getProvider(),
      hasInstance: !!this.llm,
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
