/**
 * Chat服务 - 统一的聊天接口
 * 替代LLM模块，提供统一的聊天调用能力
 */

// 使用Anthropic兼容的工具调用格式
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
  apiKey: string;  // API密钥
  model: string;   // 模型名称
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
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
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
    if (!config.apiKey) {
      throw new Error('apiKey is required in ChatConfig');
    }
    if (!config.model) {
      throw new Error('model is required in ChatConfig');
    }
    // 直接使用配置的baseUrl，要求用户配置完整的可调用端点
    this.baseUrl = config.baseUrl;
  }

  /**
   * 统一的聊天接口 - 支持工具调用
   */
  async chat(messages: Message[], tools?: Array<{
    name: string;
    description: string;
    parameters: any;
  }>): Promise<string> {
    const response = tools && tools.length > 0 
      ? await this.callChatAPIWithTools(messages, tools)
      : await this.callChatAPI(messages);
      
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
   * 详细的聊天接口，返回完整响应（包含工具调用）
   */
  async chatDetailed(messages: Message[], tools?: Array<{
    name: string;
    description: string;
    parameters: any;
  }>): Promise<ChatResponse> {
    return tools && tools.length > 0 
      ? await this.callChatAPIWithTools(messages, tools)
      : await this.callChatAPI(messages);
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
   * 支持工具调用的API调用
   */
  private async callChatAPIWithTools(
    messages: Message[], 
    tools: Array<{
      name: string;
      description: string;
      parameters: any;
    }>
  ): Promise<ChatResponse> {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`
    };

    const body = {
      model: this.config.model,
      messages: messages,
      tools: tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      })),
      max_tokens: this.config.maxTokens || 4000,
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
      
      // 处理包含工具调用的响应
      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error('API响应格式无效');
      }

      const message = choice.message;
      
      // 检查是否有工具调用
      if (message.tool_calls) {
        return {
          content: message.content || '',
          tool_calls: message.tool_calls,
          usage: {
            promptTokens: data.usage?.prompt_tokens || 0,
            completionTokens: data.usage?.completion_tokens || 0,
            totalTokens: data.usage?.total_tokens || 0,
          }
        };
      }

      // 普通文本响应
      return {
        content: message.content || '',
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        }
      };

    } catch (error) {
      console.error('ChatService API调用失败:', error);
      throw error;
    }
  }

  /**
   * 调用OpenAI兼容的Chat API
   */
  private async callChatAPI(messages: Message[]): Promise<ChatResponse> {
    
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`
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
      
      // 处理OpenAI格式的响应
      return {
        content: data.choices?.[0]?.message?.content || '',
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0
        }
      };
    } catch (error) {
      throw new Error(`Chat API调用失败: ${error instanceof Error ? error.message : '未知错误'}`);
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
