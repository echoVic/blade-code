import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat';

export type Message = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string; // tool 角色必需
  name?: string; // 工具名称
  tool_calls?: ChatCompletionMessageToolCall[]; // assistant 返回工具调用时需要
};

export interface ChatConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface StreamChunk {
  content?: string;
  toolCalls?: ChatCompletionChunk.Choice.Delta.ToolCall[];
  finishReason?: string;
}

export class ChatService {
  private client: OpenAI;

  constructor(private config: ChatConfig) {
    console.log('🚀 [ChatService] Initializing ChatService');
    console.log('⚙️ [ChatService] Config:', {
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      timeout: config.timeout,
      hasApiKey: !!config.apiKey,
    });

    if (!config.baseUrl) {
      console.error('❌ [ChatService] baseUrl is required in ChatConfig');
      throw new Error('baseUrl is required in ChatConfig');
    }
    if (!config.apiKey) {
      console.error('❌ [ChatService] apiKey is required in ChatConfig');
      throw new Error('apiKey is required in ChatConfig');
    }
    if (!config.model) {
      console.error('❌ [ChatService] model is required in ChatConfig');
      throw new Error('model is required in ChatConfig');
    }

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 30000,
      maxRetries: 3,
    });

    console.log('✅ [ChatService] ChatService initialized successfully');
  }

  async chat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: any;
    }>
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    console.log('🚀 [ChatService] Starting chat request');
    console.log('📝 [ChatService] Messages count:', messages.length);
    console.log(
      '📝 [ChatService] Messages preview:',
      messages.map((m) => ({ role: m.role, contentLength: m.content.length }))
    );

    const openaiMessages: ChatCompletionMessageParam[] = messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.tool_call_id!,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        };
      }
      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      };
    });

    const openaiTools: ChatCompletionTool[] | undefined = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    console.log('🔧 [ChatService] Tools count:', openaiTools?.length || 0);
    if (openaiTools && openaiTools.length > 0) {
      console.log(
        '🔧 [ChatService] Available tools:',
        openaiTools.map((t) => (t.type === 'function' ? t.function.name : 'unknown'))
      );
    }

    const requestParams = {
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice:
        openaiTools && openaiTools.length > 0 ? ('auto' as const) : undefined,
      max_tokens: this.config.maxTokens ?? 32000,
      temperature: this.config.temperature ?? 0.0,
    };

    console.log('📤 [ChatService] Request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
      tool_choice: requestParams.tool_choice,
      max_tokens: requestParams.max_tokens,
      temperature: requestParams.temperature,
    });

    try {
      const completion = await this.client.chat.completions.create(requestParams);
      const requestDuration = Date.now() - startTime;

      console.log('📥 [ChatService] Response received in', requestDuration, 'ms');
      console.log('📊 [ChatService] Response usage:', completion.usage);
      console.log(
        '📊 [ChatService] Response choices count:',
        completion.choices.length
      );

      const choice = completion.choices[0];
      if (!choice) {
        console.error('❌ [ChatService] No completion choice returned');
        throw new Error('No completion choice returned');
      }

      console.log('📝 [ChatService] Response choice:', {
        finishReason: choice.finish_reason,
        contentLength: choice.message.content?.length || 0,
        hasToolCalls: !!choice.message.tool_calls,
        toolCallsCount: choice.message.tool_calls?.length || 0,
      });

      if (choice.message.tool_calls) {
        console.log(
          '🔧 [ChatService] Tool calls:',
          choice.message.tool_calls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            functionName: tc.type === 'function' ? tc.function?.name : 'unknown',
            functionArgsLength:
              tc.type === 'function' ? tc.function?.arguments?.length || 0 : 0,
          }))
        );
      }

      const toolCalls = choice.message.tool_calls?.filter(
        (tc): tc is ChatCompletionMessageToolCall => tc.type === 'function'
      );

      const response = {
        content: choice.message.content || '',
        toolCalls: toolCalls,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
      };

      console.log('✅ [ChatService] Chat completed successfully');
      console.log('📊 [ChatService] Final response:', {
        contentLength: response.content.length,
        toolCallsCount: response.toolCalls?.length || 0,
        usage: response.usage,
      });

      return response;
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      console.error(
        '❌ [ChatService] Chat request failed after',
        requestDuration,
        'ms'
      );
      console.error('❌ [ChatService] Error details:', error);
      throw error;
    }
  }

  async *chatStream(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: any;
    }>
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const startTime = Date.now();
    console.log('🚀 [ChatService] Starting chat stream request');
    console.log('📝 [ChatService] Messages count:', messages.length);
    console.log(
      '📝 [ChatService] Messages preview:',
      messages.map((m) => ({ role: m.role, contentLength: m.content.length }))
    );

    const openaiMessages: ChatCompletionMessageParam[] = messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.tool_call_id!,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        };
      }
      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      };
    });

    const openaiTools: ChatCompletionTool[] | undefined = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    console.log('🔧 [ChatService] Stream tools count:', openaiTools?.length || 0);
    if (openaiTools && openaiTools.length > 0) {
      console.log(
        '🔧 [ChatService] Stream available tools:',
        openaiTools.map((t) => (t.type === 'function' ? t.function.name : 'unknown'))
      );
    }

    const requestParams = {
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice:
        openaiTools && openaiTools.length > 0 ? ('auto' as const) : ('none' as const),
      max_tokens: this.config.maxTokens ?? 32000,
      temperature: this.config.temperature ?? 0.0,
      stream: true as const,
    };

    console.log('📤 [ChatService] Stream request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
      tool_choice: requestParams.tool_choice,
      max_tokens: requestParams.max_tokens,
      temperature: requestParams.temperature,
      stream: requestParams.stream,
    });

    try {
      const stream = await this.client.chat.completions.create(requestParams);
      const requestDuration = Date.now() - startTime;
      console.log('📥 [ChatService] Stream started in', requestDuration, 'ms');

      let chunkCount = 0;
      let totalContent = '';
      let toolCallsReceived = false;

      for await (const chunk of stream) {
        chunkCount++;
        const delta = chunk.choices[0]?.delta;
        if (!delta) {
          console.log('⚠️ [ChatService] Empty delta in chunk', chunkCount);
          continue;
        }

        if (delta.content) {
          totalContent += delta.content;
        }

        if (delta.tool_calls && !toolCallsReceived) {
          toolCallsReceived = true;
          console.log('🔧 [ChatService] Tool calls detected in stream');
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          console.log('🏁 [ChatService] Stream finished with reason:', finishReason);
          console.log('📊 [ChatService] Stream summary:', {
            totalChunks: chunkCount,
            totalContentLength: totalContent.length,
            hadToolCalls: toolCallsReceived,
            duration: Date.now() - startTime + 'ms',
          });
        }

        yield {
          content: delta.content || undefined,
          toolCalls: delta.tool_calls,
          finishReason: finishReason || undefined,
        };
      }

      console.log('✅ [ChatService] Stream completed successfully');
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      console.error(
        '❌ [ChatService] Stream request failed after',
        requestDuration,
        'ms'
      );
      console.error('❌ [ChatService] Stream error details:', error);
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    console.log('🔄 [ChatService] Updating configuration');
    console.log('🔄 [ChatService] New config:', {
      model: newConfig.model,
      baseUrl: newConfig.baseUrl,
      temperature: newConfig.temperature,
      maxTokens: newConfig.maxTokens,
      timeout: newConfig.timeout,
      hasApiKey: !!newConfig.apiKey,
    });

    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout ?? 30000,
      maxRetries: 3,
    });

    console.log('✅ [ChatService] Configuration updated successfully');
    console.log('📊 [ChatService] Config changes:', {
      modelChanged: oldConfig.model !== this.config.model,
      baseUrlChanged: oldConfig.baseUrl !== this.config.baseUrl,
      temperatureChanged: oldConfig.temperature !== this.config.temperature,
      maxTokensChanged: oldConfig.maxTokens !== this.config.maxTokens,
      timeoutChanged: oldConfig.timeout !== this.config.timeout,
      apiKeyChanged: oldConfig.apiKey !== this.config.apiKey,
    });
  }
}
