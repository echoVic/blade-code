/**
 * Chat服务 - 统一的聊天接口
 * 替代LLM模块，提供统一的聊天调用能力
 */

// 使用Anthropic的工具调用格式
export type Message = {
  role: "user" | "assistant";
  content: string | Array<{
    type: "text" | "tool_use" | "tool_result";
    text?: string;
    tool_use?: {
      id: string;
      name: string;
      input: Record<string, any>;
    };
    tool_result?: {
      tool_use_id: string;
      content: string;
    };
  }>;
};

export interface ChatConfig {
  apiKey: string;  // Anthropic API Key
  model: string;   // Anthropic模型名称
  baseUrl: string; // 必须配置的API端点
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

export interface ChatResponse {
  content: string | Array<{
    type: "text" | "tool_use" | "tool_result";
    text?: string;
    tool_use?: {
      id: string;
      name: string;
      input: Record<string, any>;
    };
    tool_result?: {
      tool_use_id: string;
      content: string;
    };
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Chat服务类 - 统一的聊天接口
 */
export class ChatService {
  private baseUrl: string;
  
  constructor(private config: ChatConfig) {
    if (!config.baseUrl) {
      throw new Error('baseUrl is required in ChatConfig');
    }
    this.baseUrl = config.baseUrl;
  }

  /**
   * 统一的聊天接口
   */
  async chat(messages: Message[]): Promise<string> {
    const response = await this.callAnthropic(messages);
    if (typeof response.content === 'string') {
      return response.content;
    }
    // 如果是数组，连接所有文本内容
    return response.content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n');
  }

  /**
   * 详细的聊天接口，返回完整响应信息
   */
  async chatDetailed(messages: Message[]): Promise<ChatResponse> {
    return this.callAnthropic(messages);
  }

  /**
   * 简单文本聊天
   */
  async chatText(message: string): Promise<string> {
    const messages: Message[] = [{ role: 'user', content: message }];
    return this.chat(messages);
  }

  /**
   * 带系统提示词的聊天
   */
  async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    // 将system消息转为user消息前缀
    const messages: Message[] = [
      {
        role: 'user',
        content: `系统提示: ${systemPrompt}\n\n用户消息: ${userMessage}`
      }
    ];
    return this.chat(messages);
  }

  /**
   * 调用Anthropic API
   */
  private async callAnthropic(messages: Message[]): Promise<ChatResponse> {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01'
    };

    const body = {
      model: this.config.model,
      messages: messages,
      max_tokens: this.config.maxTokens || 1000,
      temperature: this.config.temperature || 0.7
    };

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`API调用失败: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // 转换响应格式
      return {
        content: data.content,
        usage: {
          promptTokens: data.usage?.input_tokens || 0,
          completionTokens: data.usage?.output_tokens || 0,
          totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
        }
      };
    } catch (error) {
      throw new Error(`Anthropic API调用失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }


  /**
   * 获取当前配置
   */
  getConfig(): ChatConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ChatConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}
