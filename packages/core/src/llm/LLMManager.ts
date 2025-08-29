/**
 * 平铺配置LLM管理器
 * 直接映射到极简三要素配置
 */

import type { BladeConfig } from '../config/types.js';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  apiKey: string;
  baseUrl: string;
  modelName: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  timeout?: number;
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

/**
 * 平铺配置LLM管理器  
 * 核心职责：用平铺三要素(apiKey, baseUrl, modelName)直接驱动模型
 */
export class LLMManager {
  private config: Partial<LLMRequest> = {};

  constructor(config: Pick<BladeConfig, 'apiKey' | 'baseUrl' | 'modelName'>) {
    this.config = {
      apiKey: config.apiKey || '',
      baseUrl: config.baseUrl || 'https://apis.iflow.cn/v1',
      modelName: config.modelName || 'Qwen3-Coder',
    };
  }

  /**
   * 设置配置
   */
  configure(config: Partial<LLMRequest>) {
    Object.assign(this.config, config);
  }

  /**
   * 基础调用
   */
  async send(request: Partial<LLMRequest>): Promise<LLMResponse> {
    const config = { ...this.config, ...request };
    
    // 验证必要配置
    if (!config.apiKey) {
      throw new Error('API密钥未配置');
    }
    if (!config.baseUrl) {
      throw new Error('Base URL未配置');
    }
    if (!config.messages) {
      throw new Error('消息内容不能为空');
    }

    // 构造请求
    const payload = {
      model: config.modelName,
      messages: config.messages,
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 2048,
      stream: config.stream || false,
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };

    try {
      // 通用API调用实现
      const response = await fetch(config.baseUrl!, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.timeout || 30000),
      });

      if (!response.ok) {
        throw new Error(`API错误: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      return {
        content: data.choices?.[0]?.message?.content || '',
        usage: data.usage,
        model: data.model,
      };
    } catch (error) {
      throw new Error(`LLM调用失败: ${(error as Error).message}`);
    }
  }

  /**
   * 快速对话
   */
  async chat(message: string): Promise<string> {
    return await this.send({ messages: [{ role: 'user', content: message }] }).then(r => r.content);
  }

  /**
   * 系统对话
   */
  async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    return await this.send({ 
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    }).then(r => r.content);
  }

  /**
   * 多轮对话
   */
  async conversation(messages: LLMMessage[]): Promise<string> {
    return await this.send({ messages }).then(r => r.content);
  }
}