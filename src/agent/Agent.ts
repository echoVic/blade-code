import { EventEmitter } from 'events';
import type { ContextFilter, ToolCall as ContextToolCall } from '../context/index.js';
import type { LLMMessage } from '../llm/BaseLLM.js';
import type { ToolCallRequest, ToolDefinition } from '../tools/index.js';
import { BaseComponent } from './BaseComponent.js';
import { ComponentManager, type ComponentManagerConfig } from './ComponentManager.js';
import { ContextComponent, type ContextComponentConfig } from './ContextComponent.js';
import { LLMManager, type LLMConfig } from './LLMManager.js';
import { ToolComponent } from './ToolComponent.js';

/**
 * Agent 配置接口
 */
export interface AgentConfig {
  debug?: boolean;
  llm?: LLMConfig;
  tools?: {
    enabled?: boolean;
    includeBuiltinTools?: boolean;
    excludeTools?: string[];
    includeCategories?: string[];
  };
  context?: ContextComponentConfig;
  components?: ComponentManagerConfig;
}

/**
 * 工具调用结果
 */
export interface ToolCallResult {
  toolName: string;
  success: boolean;
  result: any;
  error?: string;
  duration?: number;
}

/**
 * Agent 聊天响应
 */
export interface AgentResponse {
  content: string;
  toolCalls?: ToolCallResult[];
  reasoning?: string;
}

/**
 * Agent 主类 - 智能代理的核心协调器
 * 专注于代理协调逻辑，LLM 和组件管理由专门的管理器负责
 */
export class Agent extends EventEmitter {
  private config: AgentConfig;
  private llmManager: LLMManager;
  private componentManager: ComponentManager;
  private isInitialized = false;
  private isDestroyed = false;

  constructor(config: AgentConfig = {}) {
    super();
    this.config = {
      debug: false,
      tools: {
        enabled: true,
        includeBuiltinTools: true,
        ...config.tools,
      },
      context: {
        enabled: true,
        debug: config.debug,
        ...config.context,
      },
      components: {
        debug: config.debug,
        autoInit: true,
        ...config.components,
      },
      ...config,
    };

    // 初始化管理器
    this.llmManager = new LLMManager(this.config.debug);
    this.componentManager = new ComponentManager(this.config.components);

    // 转发管理器事件
    this.setupManagerEventForwarding();

    this.log('Agent 实例已创建');

    // 配置 LLM
    if (this.config.llm) {
      this.llmManager.configure(this.config.llm);
    }

    // 自动注册默认组件
    this.autoRegisterComponents();
  }

  /**
   * 初始化 Agent 和所有管理器
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
      // 初始化 LLM 管理器
      if (this.config.llm) {
        await this.llmManager.init();
      }

      // 初始化组件管理器
      await this.componentManager.init();

      this.isInitialized = true;
      this.log('Agent 初始化完成');
      this.emit('initialized');
    } catch (error) {
      this.log(`初始化失败: ${error}`);
      throw error;
    }
  }

  /**
   * 销毁 Agent 和所有管理器
   */
  public async destroy(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    this.log('销毁 Agent...');

    try {
      // 销毁组件管理器
      await this.componentManager.destroy();

      // 销毁 LLM 管理器
      await this.llmManager.destroy();

      this.isDestroyed = true;
      this.log('Agent 已销毁');
      this.emit('destroyed');
    } catch (error) {
      this.log(`销毁失败: ${error}`);
      throw error;
    }
  }

  // ======================== 管理器访问方法 ========================

  /**
   * 获取 LLM 管理器
   */
  public getLLMManager(): LLMManager {
    return this.llmManager;
  }

  /**
   * 获取组件管理器
   */
  public getComponentManager(): ComponentManager {
    return this.componentManager;
  }

  // ======================== LLM 功能代理方法 ========================

  /**
   * 检查 LLM 是否可用
   */
  public hasLLM(): boolean {
    return this.llmManager.isAvailable();
  }

  /**
   * 获取 LLM 提供商名称
   */
  public getLLMProvider(): string | null {
    return this.llmManager.getProvider();
  }

  /**
   * 基础聊天
   */
  public async chat(message: string): Promise<string> {
    return await this.llmManager.chat(message);
  }

  /**
   * 多轮对话
   */
  public async conversation(messages: LLMMessage[]): Promise<string> {
    return await this.llmManager.conversation(messages);
  }

  /**
   * 流式聊天
   */
  public async streamChat(
    messages: LLMMessage[],
    onChunk: (chunk: string) => void
  ): Promise<string> {
    return await this.llmManager.streamChat(messages, onChunk);
  }

  /**
   * 系统提示词聊天
   */
  public async chatWithSystem(systemPrompt: string, userMessage: string): Promise<string> {
    return await this.llmManager.chatWithSystem(systemPrompt, userMessage);
  }

  /**
   * 代码生成
   */
  public async generateCode(description: string, language: string = 'javascript'): Promise<string> {
    return await this.llmManager.generateCode(description, language);
  }

  /**
   * 文本摘要
   */
  public async summarize(text: string): Promise<string> {
    return await this.llmManager.summarize(text);
  }

  /**
   * 代码审查
   */
  public async reviewCode(code: string, language: string): Promise<string> {
    return await this.llmManager.reviewCode(code, language);
  }

  /**
   * 情绪分析
   */
  public async analyzeSentiment(text: string): Promise<string> {
    return await this.llmManager.analyzeSentiment(text);
  }

  /**
   * 智能问答
   */
  public async ask(question: string): Promise<string> {
    return await this.llmManager.ask(question);
  }

  // ======================== 组件管理代理方法 ========================

  /**
   * 注册组件
   */
  public async registerComponent(component: BaseComponent): Promise<void> {
    return await this.componentManager.registerComponent(component);
  }

  /**
   * 获取组件
   */
  public getComponent<T extends BaseComponent>(id: string): T | undefined {
    return this.componentManager.getComponent<T>(id);
  }

  /**
   * 移除组件
   */
  public async removeComponent(id: string): Promise<boolean> {
    return await this.componentManager.removeComponent(id);
  }

  /**
   * 获取所有组件ID
   */
  public getComponentIds(): string[] {
    return this.componentManager.getComponentIds();
  }

  // ======================== 核心代理协调逻辑 ========================

  /**
   * 智能聊天 - 支持工具调用的完整流程
   * 这是 Agent 的核心协调逻辑
   */
  public async smartChat(message: string): Promise<AgentResponse> {
    if (!this.llmManager.isAvailable()) {
      throw new Error('LLM 未配置或不可用');
    }

    this.log(`开始智能聊天: ${message.substring(0, 50)}...`);

    // 第一步：分析用户意图，判断是否需要工具调用
    const toolAnalysis = await this.analyzeToolNeed(message);

    if (!toolAnalysis.needsTool) {
      // 不需要工具，直接回答
      const content = await this.llmManager.chat(message);
      return {
        content,
        reasoning: '无需工具调用，直接回答',
      };
    }

    // 第二步：识别并调用工具
    const toolResults: ToolCallResult[] = [];

    for (const toolCall of toolAnalysis.toolCalls) {
      try {
        this.log(`调用工具: ${toolCall.toolName}`);
        const result = await this.callToolSmart(toolCall);
        toolResults.push(result);
      } catch (error) {
        const errorResult: ToolCallResult = {
          toolName: toolCall.toolName,
          success: false,
          result: null,
          error: (error as Error).message,
        };
        toolResults.push(errorResult);
      }
    }

    // 第三步：基于工具结果生成最终回答
    const finalAnswer = await this.generateAnswerWithToolResults(message, toolResults);

    return {
      content: finalAnswer,
      toolCalls: toolResults,
      reasoning: `使用了 ${toolResults.length} 个工具协助回答`,
    };
  }

  /**
   * 分析用户消息是否需要工具调用
   */
  private async analyzeToolNeed(message: string): Promise<{
    needsTool: boolean;
    toolCalls: Array<{ toolName: string; parameters: Record<string, any> }>;
    reasoning: string;
  }> {
    const toolComponent = this.getComponent<ToolComponent>('tools');
    if (!toolComponent) {
      return { needsTool: false, toolCalls: [], reasoning: '工具组件未启用' };
    }

    // 获取可用工具列表
    const availableTools = toolComponent.getTools();
    const toolDescriptions = availableTools
      .map(tool => `${tool.name}: ${tool.description}`)
      .join('\n');

    // 构造分析提示
    const analysisPrompt = `
分析以下用户消息，判断是否需要调用工具来回答问题。

用户消息: "${message}"

可用工具:
${toolDescriptions}

请分析：
1. 这个问题是否需要使用工具？
2. 如果需要，应该使用哪些工具？
3. 工具的参数是什么？

请按以下JSON格式回答（只返回JSON，不要其他内容）：
{
  "needsTool": boolean,
  "toolCalls": [
    {
      "toolName": "工具名称",
      "parameters": { "参数名": "参数值" }
    }
  ],
  "reasoning": "分析理由"
}

示例：
- 如果用户问"现在是几点？"，应该返回：{"needsTool": true, "toolCalls": [{"toolName": "timestamp", "parameters": {"operation": "now", "format": "local"}}], "reasoning": "需要获取当前时间"}
- 如果用户问"你好吗？"，应该返回：{"needsTool": false, "toolCalls": [], "reasoning": "这是普通问候，无需工具"}
- 如果用户说"查看现在的变更，生成commit信息并提交"，应该返回：{"needsTool": true, "toolCalls": [{"toolName": "git_smart_commit", "parameters": {"autoAdd": true}}], "reasoning": "需要智能分析Git变更并提交"}
- 如果用户说"查看git状态"，应该返回：{"needsTool": true, "toolCalls": [{"toolName": "git_status", "parameters": {}}], "reasoning": "需要查看Git仓库状态"}
- 如果用户说"审查这个文件的代码"或"检查代码质量"，应该返回：{"needsTool": true, "toolCalls": [{"toolName": "smart_code_review", "parameters": {"path": "待指定文件路径"}}], "reasoning": "需要使用智能代码审查工具"}
- 如果用户说"生成这个项目的文档"或"写个README"，应该返回：{"needsTool": true, "toolCalls": [{"toolName": "smart_doc_generator", "parameters": {"sourcePath": "待指定路径"}}], "reasoning": "需要使用智能文档生成工具"}
`;

    try {
      const response = await this.llmManager.chat(analysisPrompt);

      // 尝试解析JSON响应
      const cleanResponse = response.replace(/```json\n?|\n?```/g, '').trim();
      const analysis = JSON.parse(cleanResponse);

      this.log(`工具需求分析: ${analysis.reasoning}`);
      return analysis;
    } catch (error) {
      this.log(`工具需求分析失败: ${error}`);
      return { needsTool: false, toolCalls: [], reasoning: '分析失败' };
    }
  }

  /**
   * 智能调用工具
   */
  private async callToolSmart(toolCall: {
    toolName: string;
    parameters: Record<string, any>;
  }): Promise<ToolCallResult> {
    const toolComponent = this.getComponent<ToolComponent>('tools');
    if (!toolComponent) {
      throw new Error('工具组件未启用');
    }

    const startTime = Date.now();

    try {
      const request: ToolCallRequest = {
        toolName: toolCall.toolName,
        parameters: toolCall.parameters,
      };

      const response = await toolComponent.callTool(request);

      // 特殊处理：如果工具需要LLM分析
      if (response.result.error === 'need_llm_analysis' && response.result.data?.needsLLMAnalysis) {
        this.log(`${toolCall.toolName} 需要LLM分析...`);

        // 使用LLM分析变更内容
        const analysisPrompt = response.result.data.analysisPrompt;
        const llmAnalysis = await this.llmManager.chat(analysisPrompt);

        this.log(`LLM分析完成`);

        // 处理不同工具的分析结果
        let processedAnalysis = llmAnalysis;
        if (toolCall.toolName === 'git_smart_commit') {
          // Git智能提交：提取commit信息
          processedAnalysis = llmAnalysis
            .replace(/```\w*\n?|\n?```/g, '')
            .split('\n')[0]
            .trim();
        }
        // smart_code_review 和 smart_doc_generator 直接使用原始分析结果

        // 使用LLM分析结果重新调用工具
        const retryRequest: ToolCallRequest = {
          toolName: toolCall.toolName,
          parameters: {
            ...toolCall.parameters,
            llmAnalysis: processedAnalysis,
          },
        };

        const retryResponse = await toolComponent.callTool(retryRequest);
        const duration = Date.now() - startTime;

        return {
          toolName: toolCall.toolName,
          success: retryResponse.result.success,
          result: retryResponse.result.data,
          error: retryResponse.result.error,
          duration,
        };
      }

      const duration = Date.now() - startTime;

      return {
        toolName: toolCall.toolName,
        success: response.result.success,
        result: response.result.data,
        error: response.result.error,
        duration,
      };
    } catch (error) {
      return {
        toolName: toolCall.toolName,
        success: false,
        result: null,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 基于工具结果生成最终回答
   */
  private async generateAnswerWithToolResults(
    originalMessage: string,
    toolResults: ToolCallResult[]
  ): Promise<string> {
    // 构造包含工具结果的上下文
    const toolResultsText = toolResults
      .map(result => {
        if (result.success) {
          return `工具 ${result.toolName} 执行成功，结果: ${JSON.stringify(result.result)}`;
        } else {
          return `工具 ${result.toolName} 执行失败，错误: ${result.error}`;
        }
      })
      .join('\n');

    const contextPrompt = `
用户问题: "${originalMessage}"

我已经使用以下工具获取了信息：
${toolResultsText}

请基于这些工具返回的数据，给用户一个完整、准确且友好的回答。
回答应该：
1. 直接回答用户的问题
2. 整合工具返回的数据
3. 使用自然的语言表达
4. 不要提及技术细节（如工具名称、JSON格式等）

回答:`;

    const finalAnswer = await this.llmManager.chat(contextPrompt);
    return finalAnswer;
  }

  // ======================== 专用组件访问方法 ========================

  /**
   * 获取工具组件
   */
  public getToolComponent(): ToolComponent | undefined {
    return this.getComponent<ToolComponent>('tools');
  }

  /**
   * 获取上下文组件
   */
  public getContextComponent(): ContextComponent | undefined {
    return this.getComponent<ContextComponent>('context');
  }

  // ======================== 上下文管理协调方法 ========================

  /**
   * 创建新的上下文会话
   */
  public async createContextSession(
    userId?: string,
    preferences: Record<string, any> = {},
    configuration: Record<string, any> = {},
    customSessionId?: string
  ): Promise<string> {
    const contextComponent = this.getContextComponent();
    if (!contextComponent) {
      throw new Error('上下文组件未启用');
    }
    return await contextComponent.createSession(
      userId,
      preferences,
      configuration,
      customSessionId
    );
  }

  /**
   * 加载现有的上下文会话
   */
  public async loadContextSession(sessionId: string): Promise<boolean> {
    const contextComponent = this.getContextComponent();
    if (!contextComponent) {
      throw new Error('上下文组件未启用');
    }
    return await contextComponent.loadSession(sessionId);
  }

  /**
   * 获取当前上下文会话ID
   */
  public getCurrentSessionId(): string | undefined {
    const contextComponent = this.getContextComponent();
    return contextComponent?.getCurrentSessionId();
  }

  /**
   * 搜索历史会话
   */
  public async searchContextSessions(
    query: string,
    limit: number = 10
  ): Promise<
    Array<{
      sessionId: string;
      summary: string;
      lastActivity: number;
      relevanceScore: number;
    }>
  > {
    const contextComponent = this.getContextComponent();
    if (!contextComponent) {
      return [];
    }
    return await contextComponent.searchSessions(query, limit);
  }

  /**
   * 带上下文的智能聊天
   */
  public async chatWithContext(
    message: string,
    systemPrompt?: string,
    options?: ContextFilter
  ): Promise<string> {
    const contextComponent = this.getContextComponent();

    if (!contextComponent || !contextComponent.isContextReady()) {
      // 如果没有上下文组件或未就绪，降级到普通聊天
      this.log('上下文组件未就绪，使用普通聊天模式');
      return systemPrompt
        ? await this.llmManager.chatWithSystem(systemPrompt, message)
        : await this.llmManager.chat(message);
    }

    try {
      // 构建包含上下文的消息列表
      const messages = await contextComponent.buildMessagesWithContext(
        message,
        systemPrompt,
        options
      );

      // 转换为LLM消息格式
      const llmMessages: LLMMessage[] = messages.map(msg => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      }));

      // 进行对话
      const response = await this.llmManager.conversation(llmMessages);

      // 将助手回复添加到上下文
      await contextComponent.addAssistantMessage(response);

      return response;
    } catch (error) {
      this.log(`上下文聊天失败，降级到普通聊天: ${error}`);
      // 降级到普通聊天
      return systemPrompt
        ? await this.llmManager.chatWithSystem(systemPrompt, message)
        : await this.llmManager.chat(message);
    }
  }

  /**
   * 带上下文的智能工具调用聊天
   */
  public async smartChatWithContext(message: string): Promise<AgentResponse> {
    const contextComponent = this.getContextComponent();

    if (!contextComponent || !contextComponent.isContextReady()) {
      // 如果没有上下文组件或未就绪，降级到普通智能聊天
      this.log('上下文组件未就绪，使用普通智能聊天模式');
      return await this.smartChat(message);
    }

    try {
      // 构建包含上下文的消息列表
      const messages = await contextComponent.buildMessagesWithContext(message);

      // 转换为LLM消息格式
      const llmMessages: LLMMessage[] = messages.map(msg => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      }));

      // 分析是否需要工具调用（基于包含上下文的消息）
      const toolAnalysis = await this.analyzeToolNeed(message);

      if (!toolAnalysis.needsTool) {
        // 不需要工具，使用上下文进行对话
        const response = await this.llmManager.conversation(llmMessages);

        // 将助手回复添加到上下文
        await contextComponent.addAssistantMessage(response);

        return {
          content: response,
          reasoning: '基于上下文的对话，无需工具调用',
        };
      }

      // 需要工具调用，执行工具
      const toolResults: ToolCallResult[] = [];

      for (const toolCall of toolAnalysis.toolCalls) {
        try {
          this.log(`调用工具: ${toolCall.toolName}`);
          const result = await this.callToolSmart(toolCall);
          toolResults.push(result);
        } catch (error) {
          const errorResult: ToolCallResult = {
            toolName: toolCall.toolName,
            success: false,
            result: null,
            error: (error as Error).message,
          };
          toolResults.push(errorResult);
        }
      }

      // 基于工具结果和上下文生成最终回答
      const finalAnswer = await this.generateAnswerWithToolResults(message, toolResults);

      // 将助手回复添加到上下文
      await contextComponent.addAssistantMessage(finalAnswer);

      // 记录工具调用到上下文
      if (toolResults.length > 0) {
        for (const toolCallResult of toolResults) {
          const toolCall: ContextToolCall = {
            id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: toolCallResult.toolName,
            input: {}, // 这里可以从toolCallResult获取输入参数
            output: toolCallResult.result,
            timestamp: Date.now(),
            status: toolCallResult.success ? 'success' : 'error',
            error: toolCallResult.error,
          };

          await contextComponent.addToolCall(toolCall);
        }
      }

      return {
        content: finalAnswer,
        toolCalls: toolResults,
        reasoning: `基于上下文对话，使用了 ${toolResults.length} 个工具协助回答`,
      };
    } catch (error) {
      this.log(`上下文智能聊天失败，降级到普通智能聊天: ${error}`);
      // 降级到普通智能聊天
      return await this.smartChat(message);
    }
  }

  /**
   * 获取上下文统计信息
   */
  public async getContextStats(): Promise<{
    currentSession: string | null;
    memory: any;
    cache: any;
    storage: any;
  } | null> {
    const contextComponent = this.getContextComponent();
    if (!contextComponent) {
      return null;
    }
    return await contextComponent.getStats();
  }

  // ======================== 工具管理协调方法 ========================

  /**
   * 手动调用工具
   */
  public async callTool(
    toolName: string,
    parameters: Record<string, any>
  ): Promise<ToolCallResult> {
    const toolComponent = this.getToolComponent();
    if (!toolComponent) {
      throw new Error('工具组件未启用');
    }

    return await this.callToolSmart({ toolName, parameters });
  }

  /**
   * 获取可用工具列表
   */
  public getAvailableTools(): ToolDefinition[] {
    const toolComponent = this.getToolComponent();
    if (!toolComponent) {
      return [];
    }
    return toolComponent.getTools();
  }

  /**
   * 搜索工具
   */
  public searchTools(query: string): ToolDefinition[] {
    const toolComponent = this.getToolComponent();
    if (!toolComponent) {
      return [];
    }
    return toolComponent.searchTools(query);
  }

  // ======================== 状态和工具方法 ========================

  /**
   * 获取 Agent 状态
   */
  public getStatus() {
    return {
      initialized: this.isInitialized,
      destroyed: this.isDestroyed,
      llm: this.llmManager.getStatus(),
      components: this.componentManager.getStatus(),
      hasLLM: this.hasLLM(),
      llmProvider: this.getLLMProvider(),
    };
  }

  /**
   * 获取健康状态
   */
  public async getHealthStatus() {
    const componentHealth = await this.componentManager.getHealthStatus();
    const llmStatus = this.llmManager.getStatus();

    return {
      healthy:
        this.isInitialized && !this.isDestroyed && componentHealth.healthy && llmStatus.isAvailable,
      agent: {
        initialized: this.isInitialized,
        destroyed: this.isDestroyed,
      },
      llm: llmStatus,
      components: componentHealth,
    };
  }

  // ======================== 私有方法 ========================

  /**
   * 自动注册默认组件
   */
  private autoRegisterComponents(): void {
    // 如果启用了上下文管理，自动注册上下文组件
    if (this.config.context?.enabled !== false) {
      const contextComponent = new ContextComponent('context', this.config.context);
      this.componentManager.registerComponent(contextComponent);
      this.log('上下文组件已自动注册');
    }

    // 如果启用了工具，自动注册工具组件
    if (this.config.tools?.enabled) {
      const toolComponent = new ToolComponent('tools', {
        debug: this.config.debug,
        includeBuiltinTools: this.config.tools.includeBuiltinTools,
        excludeTools: this.config.tools.excludeTools,
        includeCategories: this.config.tools.includeCategories,
      });

      this.componentManager.registerComponent(toolComponent);
      this.log('工具组件已自动注册');
    }
  }

  /**
   * 设置管理器事件转发
   */
  private setupManagerEventForwarding(): void {
    // 转发 LLM 管理器事件
    // 这里可以根据需要转发特定事件

    // 转发组件管理器事件
    this.componentManager.on('componentRegistered', event => {
      this.emit('componentRegistered', event);
    });

    this.componentManager.on('componentRemoved', event => {
      this.emit('componentRemoved', event);
    });

    this.componentManager.on('componentInitialized', event => {
      this.emit('componentInitialized', event);
    });

    this.componentManager.on('componentDestroyed', event => {
      this.emit('componentDestroyed', event);
    });
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
