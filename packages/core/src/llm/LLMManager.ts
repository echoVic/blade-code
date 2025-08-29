/**
 * 平铺配置LLM管理器
 * 直接映射到极简三要素配置
 */

import type { BladeConfig } from '../config/types.js';
import {
  ErrorFactory,
  LLMError,
  NetworkError,
  globalRetryManager
} from '../error/index.js';

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
      throw ErrorFactory.createLLMError('API_KEY_MISSING', 'API密钥未配置');
    }
    if (!config.baseUrl) {
      throw ErrorFactory.createLLMError('BASE_URL_MISSING', 'Base URL未配置');
    }
    if (!config.modelName) {
      throw ErrorFactory.createLLMError('MODEL_NAME_MISSING', '模型名称未配置');
    }
    if (!config.messages) {
      throw ErrorFactory.createLLMError('REQUEST_FAILED', '消息内容不能为空');
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

    // 使用重试管理器执行API调用
    return globalRetryManager.execute(async () => {
      try {
        // 通用API调用实现
        const response = await fetch(config.baseUrl!, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(config.timeout || 30000),
        });

        if (!response.ok) {
          throw ErrorFactory.createHttpError(
            response.status,
            config.baseUrl!,
            response.statusText
          );
        }

        const data = await response.json();
        
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw ErrorFactory.createLLMError('RESPONSE_PARSE_ERROR', '响应格式错误');
        }
        
        return {
          content: data.choices[0].message.content || '',
          usage: data.usage,
          model: data.model,
        };
      } catch (error) {
        if (error instanceof LLMError || error instanceof NetworkError) {
          throw error;
        }
        
        if (error instanceof Error && error.name === 'AbortError') {
          throw ErrorFactory.createTimeoutError('LLM API调用', config.timeout || 30000);
        }
        
        throw ErrorFactory.fromNativeError(error as Error, 'LLM调用失败');
      }
    }, 'LLM_API_CALL');
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