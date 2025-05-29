import { EventEmitter } from 'events';
import { getProviderConfig } from '../config/defaults.js';
import type { LLMMessage, LLMRequest } from '../llm/BaseLLM.js';
import { QwenLLM } from '../llm/QwenLLM.js';
import { VolcEngineLLM } from '../llm/VolcEngineLLM.js';
import { BaseComponent } from './BaseComponent.js';

/**
 * Agent 配置接口
 */
export interface AgentConfig {
  debug?: boolean;
  llm?: {
    provider: 'qwen' | 'volcengine';
    apiKey?: string;
    model?: string;
    baseURL?: string;
  };
}

/**
 * Agent 主类 - 智能代理的核心控制器
 * 内置 LLM 功能，提供完整的 AI 能力
 */
export class Agent extends EventEmitter {
  private config: AgentConfig;
  private components = new Map<string, BaseComponent>();
  private isInitialized = false;
  private isDestroyed = false;
  private llm?: QwenLLM | VolcEngineLLM;

  constructor(config: AgentConfig = {}) {
    super();
    this.config = {
      debug: false,
      ...config
    };
    
    this.log('Agent 实例已创建');
  }

  /**
   * 初始化 Agent 和所有组件
   */
  public async init(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('Agent 已经初始化');
    }

    if (this.isDestroyed) {
      throw new Error('Agent 已被销毁，无法重新初始化');
    }

    this.log('初始化 Agent...');

    try {
      // 初始化 LLM（如果配置了）
      if (this.config.llm) {
        await this.initLLM();
      }

      // 初始化所有组件
      for (const [name, component] of this.components) {
        this.log(`初始化组件: ${name}`);
        await component.init();
      }

      this.isInitialized = true;
      this.log('Agent 初始化完成');
      this.emit('initialized');

    } catch (error) {
      this.log(`初始化失败: ${error}`);
      throw error;
    }
  }

  /**
   * 初始化 LLM
   */
  private async initLLM(): Promise<void> {
    if (!this.config.llm) return;

    const { provider, apiKey, model, baseURL } = this.config.llm;
    
    // 获取默认配置
    const defaultConfig = getProviderConfig(provider);
    
    // 使用提供的配置或默认配置
    const finalApiKey = apiKey || defaultConfig.apiKey;
    const finalModel = model || defaultConfig.defaultModel;
    
    if (!finalApiKey) {
      throw new Error(`${provider} API key 未配置`);
    }

    this.log(`初始化 ${provider} LLM...`);

    // 创建 LLM 实例
    switch (provider) {
      case 'qwen':
        this.llm = new QwenLLM({
          apiKey: finalApiKey,
          baseURL: baseURL || defaultConfig.baseURL
        }, finalModel);
        break;
      case 'volcengine':
        this.llm = new VolcEngineLLM({
          apiKey: finalApiKey,
          baseURL: baseURL || defaultConfig.baseURL
        }, finalModel);
        break;
      default:
        throw new Error(`不支持的 LLM 提供商: ${provider}`);
    }

    // 初始化 LLM
    await this.llm.init();
    this.log(`${provider} LLM 初始化完成`);
  }

  /**
   * 销毁 Agent 和所有组件
   */
  public async destroy(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    this.log('销毁 Agent...');

    try {
      // 销毁所有组件
      for (const [name, component] of this.components) {
        this.log(`销毁组件: ${name}`);
        await component.destroy();
      }

      // 销毁 LLM
      if (this.llm) {
        await this.llm.destroy();
        this.log('LLM 已销毁');
      }

      this.isDestroyed = true;
      this.log('Agent 已销毁');
      this.emit('destroyed');

    } catch (error) {
      this.log(`销毁失败: ${error}`);
      throw error;
    }
  }

  /**
   * 注册组件
   */
  public registerComponent(component: BaseComponent): void {
    const id = component.getId();
    
    if (this.components.has(id)) {
      throw new Error(`组件 "${id}" 已存在`);
    }

    this.components.set(id, component);
    this.log(`组件 "${id}" 已注册`);
    this.emit('componentRegistered', { id, component });
  }

  /**
   * 获取组件
   */
  public getComponent<T extends BaseComponent>(id: string): T | undefined {
    return this.components.get(id) as T;
  }

  /**
   * 移除组件
   */
  public async removeComponent(id: string): Promise<boolean> {
    const component = this.components.get(id);
    if (!component) {
      return false;
    }

    // 如果组件已初始化，先销毁它
    if (this.isInitialized) {
      await component.destroy();
    }

    this.components.delete(id);
    this.log(`组件 "${id}" 已移除`);
    this.emit('componentRemoved', { id });
    return true;
  }

  /**
   * 获取所有组件ID
   */
  public getComponentIds(): string[] {
    return Array.from(this.components.keys());
  }

  // ======================== LLM 功能 ========================

  /**
   * 检查 LLM 是否可用
   */
  public hasLLM(): boolean {
    return !!this.llm;
  }

  /**
   * 获取 LLM 提供商名称
   */
  public getLLMProvider(): string | null {
    if (!this.llm) return null;
    return this.llm instanceof QwenLLM ? 'qwen' : 'volcengine';
  }

  /**
   * 基础聊天
   */
  public async chat(message: string): Promise<string> {
    if (!this.llm) {
      throw new Error('LLM 未配置');
    }

    this.log(`发送消息: ${message.substring(0, 50)}...`);
    const response = await this.llm.sendMessage(message);
    this.log(`收到回复: ${response.substring(0, 50)}...`);
    return response;
  }

  /**
   * 多轮对话
   */
  public async conversation(messages: LLMMessage[]): Promise<string> {
    if (!this.llm) {
      throw new Error('LLM 未配置');
    }

    this.log(`开始多轮对话，消息数: ${messages.length}`);
    const response = await this.llm.conversation(messages);
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
    if (!this.llm) {
      throw new Error('LLM 未配置');
    }

    if (this.llm instanceof QwenLLM && this.llm.streamChat) {
      this.log('开始流式对话...');
      const response = await this.llm.streamChat({ messages }, onChunk);
      this.log('流式对话完成');
      return response.content;
    } else {
      // 降级到普通聊天
      this.log('流式聊天不支持，降级到普通聊天');
      const request: LLMRequest = { messages };
      const response = await this.llm.chat(request);
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
      { role: 'user', content: userMessage }
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

  // ======================== 工具方法 ========================

  /**
   * 获取 Agent 状态
   */
  public getStatus() {
    return {
      initialized: this.isInitialized,
      destroyed: this.isDestroyed,
      componentCount: this.components.size,
      hasLLM: this.hasLLM(),
      llmProvider: this.getLLMProvider()
    };
  }

  /**
   * 内部日志记录
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[Agent] ${message}`);
    }
  }
} 