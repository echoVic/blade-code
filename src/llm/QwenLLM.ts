import OpenAI from 'openai';
import { BaseLLM, LLMRequest, LLMResponse } from './BaseLLM.js';

/**
 * 阿里云百练配置接口
 */
export interface QwenConfig {
  apiKey: string;
  baseURL?: string;
}

/**
 * 阿里云百练 Qwen LLM 实现
 * 基于 OpenAI 兼容的 API 接口
 */
export class QwenLLM extends BaseLLM {
  private client: OpenAI;
  private config: QwenConfig;

  constructor(config: QwenConfig, defaultModel: string = 'qwen3-235b-a22b') {
    super('qwen-llm', defaultModel);
    this.config = config;

    // 初始化 OpenAI 客户端，使用阿里云百练的 API 端点
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
  }

  /**
   * 初始化组件
   */
  public async init(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('Qwen API key is required');
    }

    // 验证 API 连接
    try {
      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize Qwen LLM: ${error}`);
    }
  }

  /**
   * 判断是否为 Qwen3 模型
   * 根据官方文档，现在大部分模型都基于 Qwen3
   */
  private isQwen3Model(model: string): boolean {
    const lowerModel = model.toLowerCase();

    // 明确的 Qwen3 模型
    if (lowerModel.startsWith('qwen3')) {
      return true;
    }

    // Latest 版本都是 Qwen3
    if (lowerModel.includes('latest')) {
      return true;
    }

    // 2025年版本都是 Qwen3
    if (lowerModel.includes('2025-04-28')) {
      return true;
    }

    // 当前的 turbo 和 plus 也是 Qwen3
    if (lowerModel === 'qwen-turbo' || lowerModel === 'qwen-plus') {
      return true;
    }

    // 其他旧版本可能不是 Qwen3
    return false;
  }

  /**
   * 获取 Qwen3 模型的 enable_thinking 默认值
   * 根据千问官方文档：
   * - Qwen3 商业版模型默认值为 False
   * - Qwen3 开源版模型默认值为 True
   * - 但某些场景下需要显式设置为 false
   */
  private getEnableThinkingValue(model: string): boolean {
    // 对于我们遇到错误的特定模型，强制设置为 false
    if (model === 'qwen3-235b-a22b') {
      return false;
    }

    // 其他 Qwen3 模型，根据是否为商业版决定
    // 这里假设大多数是商业版，默认为 false
    // 如果遇到其他模型的问题，可以在这里添加特殊处理
    return false;
  }

  /**
   * 发送请求到阿里云百练
   */
  protected async sendRequest(request: LLMRequest): Promise<LLMResponse> {
    this.validateRequest(request);

    try {
      const model = request.model || this.defaultModel;
      const requestParams: any = {
        model: model,
        messages: request.messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 2048,
        stream: false,
      };

      // 对于 Qwen3 模型，设置 enable_thinking 参数
      if (this.isQwen3Model(model)) {
        requestParams.enable_thinking = this.getEnableThinkingValue(model);
      }

      const completion = await this.client.chat.completions.create(requestParams);

      const choice = completion.choices[0];
      if (!choice || !choice.message) {
        throw new Error('Invalid response from Qwen API');
      }

      return {
        content: choice.message.content || '',
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : undefined,
        model: completion.model,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Qwen API error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 测试 API 连接
   */
  private async testConnection(): Promise<void> {
    try {
      const requestParams: any = {
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10,
      };

      // 对于 Qwen3 模型，设置 enable_thinking 参数
      if (this.isQwen3Model(this.defaultModel)) {
        requestParams.enable_thinking = this.getEnableThinkingValue(this.defaultModel);
      }

      await this.client.chat.completions.create(requestParams);
    } catch (error) {
      throw new Error(`Connection test failed: ${error}`);
    }
  }

  /**
   * 流式聊天（阿里云百练支持）
   */
  public async streamChat(
    request: LLMRequest,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    this.validateRequest(request);

    return this.withRetry(async () => {
      try {
        const model = request.model || this.defaultModel;
        const requestParams: any = {
          model: model,
          messages: request.messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: request.temperature || 0.7,
          max_tokens: request.maxTokens || 2048,
          stream: true,
        };

        // 对于 Qwen3 模型，设置 enable_thinking 参数
        if (this.isQwen3Model(model)) {
          requestParams.enable_thinking = this.getEnableThinkingValue(model);
        }

        const stream = (await this.client.chat.completions.create(requestParams)) as any;

        let fullContent = '';
        let usage: any = undefined;
        let model_response: string | undefined = undefined;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            onChunk(delta.content);
          }

          if (chunk.usage) {
            usage = chunk.usage;
          }

          if (chunk.model) {
            model_response = chunk.model;
          }
        }

        return {
          content: fullContent,
          usage: usage
            ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              }
            : undefined,
          model: model_response,
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Qwen streaming error: ${error.message}`);
        }
        throw error;
      }
    });
  }

  /**
   * 获取可用模型列表
   */
  public async getModels(): Promise<string[]> {
    // Qwen 官方模型列表（基于最新官方文档）
    return [
      // 动态更新版本（Latest）
      'qwen-plus-latest', // 通义千问-Plus-Latest (Qwen3)
      'qwen-turbo-latest', // 通义千问-Turbo-Latest (Qwen3)

      // 快照版本（Snapshot） - Qwen3 系列
      'qwen3-235b-a22b', // 通义千问3-235B-A22B (默认)
      'qwen3-30b-a3b', // 通义千问3-30B-A3B
      'qwen3-32b', // 通义千问3-32B
      'qwen3-14b', // 通义千问3-14B
      'qwen3-8b', // 通义千问3-8B
      'qwen3-4b', // 通义千问3-4B
      'qwen3-1.7b', // 通义千问3-1.7B
      'qwen3-0.6b', // 通义千问3-0.6B

      // 时间快照版本
      'qwen-turbo-2025-04-28', // 通义千问-Turbo-2025-04-28 (Qwen3)
      'qwen-plus-2025-04-28', // 通义千问-Plus-2025-04-28 (Qwen3)

      // 兼容性别名（指向 Latest 版本）
      'qwen-turbo', // 指向 qwen-turbo-latest
      'qwen-plus', // 指向 qwen-plus-latest
    ];
  }

  /**
   * 设置系统提示词
   */
  public async chatWithSystem(
    systemPrompt: string,
    userMessage: string,
    options?: Partial<LLMRequest>
  ): Promise<string> {
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      ...options,
    };

    const response = await this.chat(request);
    return response.content;
  }

  /**
   * 函数调用（Qwen 支持函数调用）
   */
  public async functionCall(
    messages: any[],
    functions: any[],
    options?: Partial<LLMRequest>
  ): Promise<any> {
    try {
      const completion = await this.client.chat.completions.create({
        model: options?.model || this.defaultModel,
        messages: messages,
        functions: functions,
        function_call: 'auto',
        temperature: options?.temperature || 0.7,
        max_tokens: options?.maxTokens || 2048,
      } as any);

      return completion;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Qwen function call error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 现代 Tools 格式的函数调用（推荐使用）
   * 支持 Qwen 最新的 tools 接口
   */
  public async toolsCall(
    messages: any[],
    tools: any[],
    options?: Partial<LLMRequest>
  ): Promise<any> {
    try {
      const model = options?.model || this.defaultModel;
      const requestParams: any = {
        model: model,
        messages: messages,
        tools: tools,
        tool_choice: 'auto',
        temperature: options?.temperature || 0.7,
        max_tokens: options?.maxTokens || 2048,
        stream: false,
      };

      // 对于 Qwen3 模型，设置 enable_thinking 参数
      if (this.isQwen3Model(model)) {
        requestParams.enable_thinking = this.getEnableThinkingValue(model);
      }

      const completion = await this.client.chat.completions.create(requestParams);

      return completion;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Qwen tools call error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 自动选择最佳的函数调用方式
   * 优先使用 tools 格式，如果不支持则回退到 functions 格式
   */
  public async smartFunctionCall(
    messages: any[],
    toolsOrFunctions: any[],
    options?: Partial<LLMRequest>
  ): Promise<any> {
    try {
      // 首先尝试使用现代 tools 格式
      const tools = this.convertToToolsFormat(toolsOrFunctions);
      return await this.toolsCall(messages, tools, options);
    } catch (error) {
      // 如果 tools 格式失败，回退到 functions 格式
      if (error instanceof Error && error.message.includes('tools')) {
        console.warn('Qwen: Tools 格式不支持，回退到 functions 格式');
        const functions = this.convertToFunctionsFormat(toolsOrFunctions);
        return await this.functionCall(messages, functions, options);
      }
      throw error;
    }
  }

  /**
   * 将工具定义转换为 OpenAI Tools 格式
   */
  private convertToToolsFormat(toolsOrFunctions: any[]): any[] {
    return toolsOrFunctions.map(item => {
      // 如果已经是 tools 格式，直接返回
      if (item.type === 'function' && item.function) {
        return item;
      }

      // 如果是 functions 格式，转换为 tools 格式
      if (item.name && item.description && item.parameters) {
        return {
          type: 'function',
          function: {
            name: item.name,
            description: item.description,
            parameters: item.parameters,
          },
        };
      }

      // 如果是项目内部的 ToolDefinition 格式，转换为 tools 格式
      if (item.name && item.description && item.parameters) {
        return {
          type: 'function',
          function: {
            name: item.name,
            description: item.description,
            parameters: {
              type: 'object',
              properties: item.parameters,
              required: item.required || [],
            },
          },
        };
      }

      return item;
    });
  }

  /**
   * 将工具定义转换为旧的 Functions 格式（向后兼容）
   */
  private convertToFunctionsFormat(toolsOrFunctions: any[]): any[] {
    return toolsOrFunctions.map(item => {
      // 如果已经是 functions 格式，直接返回
      if (item.name && item.description && item.parameters && !item.type) {
        return item;
      }

      // 如果是 tools 格式，转换为 functions 格式
      if (item.type === 'function' && item.function) {
        return {
          name: item.function.name,
          description: item.function.description,
          parameters: item.function.parameters,
        };
      }

      // 如果是项目内部的 ToolDefinition 格式，转换为 functions 格式
      if (item.name && item.description && item.parameters) {
        return {
          name: item.name,
          description: item.description,
          parameters: {
            type: 'object',
            properties: item.parameters,
            required: item.required || [],
          },
        };
      }

      return item;
    });
  }

  /**
   * 解析 function call 或 tool call 的结果
   */
  public parseToolCallResult(completion: any): {
    hasToolCalls: boolean;
    toolCalls: Array<{
      id?: string;
      type?: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
    content?: string;
  } {
    const choice = completion.choices?.[0];
    if (!choice) {
      return { hasToolCalls: false, toolCalls: [], content: undefined };
    }

    const message = choice.message;

    // 检查新格式的 tool_calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        hasToolCalls: true,
        toolCalls: message.tool_calls,
        content: message.content,
      };
    }

    // 检查旧格式的 function_call
    if (message.function_call) {
      return {
        hasToolCalls: true,
        toolCalls: [
          {
            type: 'function',
            function: {
              name: message.function_call.name,
              arguments: message.function_call.arguments,
            },
          },
        ],
        content: message.content,
      };
    }

    return {
      hasToolCalls: false,
      toolCalls: [],
      content: message.content,
    };
  }

  /**
   * 执行完整的工具调用流程
   * 包括调用 LLM、解析工具调用、执行工具、返回结果
   */
  public async executeToolWorkflow(
    messages: any[],
    availableTools: any[],
    toolExecutor: (toolName: string, args: any) => Promise<any>,
    options?: Partial<LLMRequest>
  ): Promise<{
    finalResponse: string;
    toolExecutions: Array<{
      toolName: string;
      arguments: any;
      result: any;
      success: boolean;
      error?: string;
    }>;
  }> {
    const toolExecutions: Array<{
      toolName: string;
      arguments: any;
      result: any;
      success: boolean;
      error?: string;
    }> = [];

    // 调用 LLM 获取工具调用建议
    const completion = await this.smartFunctionCall(messages, availableTools, options);
    const parseResult = this.parseToolCallResult(completion);

    // 如果没有工具调用，直接返回 LLM 的回复
    if (!parseResult.hasToolCalls) {
      return {
        finalResponse: parseResult.content || '',
        toolExecutions: [],
      };
    }

    // 执行所有工具调用
    const updatedMessages = [...messages];

    // 添加 LLM 的回复（包含工具调用）
    updatedMessages.push({
      role: 'assistant',
      content: parseResult.content,
      tool_calls: parseResult.toolCalls,
    });

    for (const toolCall of parseResult.toolCalls) {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await toolExecutor(toolCall.function.name, args);

        toolExecutions.push({
          toolName: toolCall.function.name,
          arguments: args,
          result: result,
          success: true,
        });

        // 添加工具执行结果到消息历史
        updatedMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id || `call_${Date.now()}`,
          content: JSON.stringify(result),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        toolExecutions.push({
          toolName: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
          result: null,
          success: false,
          error: errorMsg,
        });

        // 添加错误结果到消息历史
        updatedMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id || `call_${Date.now()}`,
          content: `Error: ${errorMsg}`,
        });
      }
    }

    // 让 LLM 基于工具执行结果生成最终回复
    const finalCompletion = await this.chat({
      messages: updatedMessages,
      model: options?.model,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    });

    return {
      finalResponse: finalCompletion.content,
      toolExecutions,
    };
  }

  /**
   * 带 thinking 模式控制的聊天（仅适用于 Qwen3 模型）
   */
  public async chatWithThinking(
    request: LLMRequest,
    enableThinking?: boolean
  ): Promise<LLMResponse> {
    this.validateRequest(request);

    const model = request.model || this.defaultModel;

    if (!this.isQwen3Model(model)) {
      // 非 Qwen3 模型，使用普通聊天
      return this.chat(request);
    }

    return this.withRetry(async () => {
      try {
        const requestParams: any = {
          model: model,
          messages: request.messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: request.temperature || 0.7,
          max_tokens: request.maxTokens || 2048,
          stream: false,
        };

        // 如果指定了 enableThinking，使用指定值，否则使用默认逻辑
        if (enableThinking !== undefined) {
          requestParams.enable_thinking = enableThinking;
        } else {
          requestParams.enable_thinking = this.getEnableThinkingValue(model);
        }

        const completion = await this.client.chat.completions.create(requestParams);

        const choice = completion.choices[0];
        if (!choice || !choice.message) {
          throw new Error('Invalid response from Qwen API');
        }

        return {
          content: choice.message.content || '',
          usage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens,
                completionTokens: completion.usage.completion_tokens,
                totalTokens: completion.usage.total_tokens,
              }
            : undefined,
          model: completion.model,
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Qwen API error: ${error.message}`);
        }
        throw error;
      }
    });
  }
}
