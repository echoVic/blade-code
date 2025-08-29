/**
 * 平铺配置Agent入口
 * 直接使用三要素配置驱动LLM调用
 */

import { ConfigManager } from '../config/ConfigManager.js';
import { LLMManager, type LLMMessage } from '../llm/LLMManager.js';
import type { BladeConfig } from '../config/types.js';

/**
 * Agent 主类 - 极简智能代理入口
 * 使用平铺配置三要素(apiKey, baseUrl, modelName)驱动所有AI能力
 */
export class Agent {
  private configManager: ConfigManager;
  private llmManager: LLMManager;

  constructor(config?: Partial<BladeConfig>) {
    // 初始化配置管理器
    this.configManager = new ConfigManager();
    
    // 合并传入配置
    if (config) {
      this.configManager.updateConfig(config);
    }

    // 获取配置并构建LLM管理器
    const bladeConfig = this.configManager.getConfig();
    this.llmManager = new LLMManager({
      apiKey: bladeConfig.apiKey,
      baseUrl: bladeConfig.baseUrl,
      modelName: bladeConfig.modelName,
    });
  }

  /**
   * 基础聊天
   */
  public async chat(message: string): Promise<string> {
    return await this.llmManager.chat(message);
  }

  /**
   * 系统提示词聊天
   */
  public async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    return await this.llmManager.chatWithSystem(systemPrompt, userMessage);
  }

  /**
   * 多轮对话
   */
  public async conversation(messages: LLMMessage[]): Promise<string> {
    return await this.llmManager.conversation(messages);
  }

  /**
   * 获取当前配置
   */
  public getConfig(): BladeConfig {
    return this.configManager.getConfig();
  }

  /**
   * 更新配置
   */
  public updateConfig(config: Partial<BladeConfig>): void {
    this.configManager.updateConfig(config);
    
    // 同步更新LLM管理器配置
    this.llmManager.configure({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      modelName: config.modelName,
    });
  }
}