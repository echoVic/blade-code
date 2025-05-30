import { EventEmitter } from 'events';
import { getProviderConfig } from '../config/defaults.js';
import type { LLMMessage, LLMRequest } from '../llm/BaseLLM.js';
import { QwenLLM } from '../llm/QwenLLM.js';
import { VolcEngineLLM } from '../llm/VolcEngineLLM.js';
import type { ToolCallRequest, ToolDefinition } from '../tools/index.js';
import { BaseComponent } from './BaseComponent.js';
import { ToolComponent } from './ToolComponent.js';

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
  tools?: {
    enabled?: boolean;
    includeBuiltinTools?: boolean;
    excludeTools?: string[];
    includeCategories?: string[];
  };
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
      tools: {
        enabled: true,
        includeBuiltinTools: true,
        ...config.tools,
      },
      ...config,
    };

    this.log('Agent 实例已创建');

    // 如果启用了工具，自动注册工具组件
    if (this.config.tools?.enabled) {
      const toolComponent = new ToolComponent('tools', {
        debug: this.config.debug,
        includeBuiltinTools: this.config.tools.includeBuiltinTools,
        excludeTools: this.config.tools.excludeTools,
        includeCategories: this.config.tools.includeCategories,
      });

      this.registerComponent(toolComponent);
      this.log('工具组件已自动注册');
    }
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

  // ======================== 智能工具调用 ========================

  /**
   * 智能聊天 - 支持工具调用的完整流程
   * 用户提问 -> 模型识别 -> 调用工具 -> 工具返回模型 -> 模型返回给用户
   */
  public async smartChat(message: string): Promise<AgentResponse> {
    if (!this.llm) {
      throw new Error('LLM 未配置');
    }

    this.log(`开始智能聊天: ${message.substring(0, 50)}...`);

    // 第一步：分析用户意图，判断是否需要工具调用
    const toolAnalysis = await this.analyzeToolNeed(message);

    if (!toolAnalysis.needsTool) {
      // 不需要工具，直接回答
      const content = await this.chat(message);
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
      const response = await this.chat(analysisPrompt);

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
        const llmAnalysis = await this.chat(analysisPrompt);

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

    const finalAnswer = await this.chat(contextPrompt);
    return finalAnswer;
  }

  /**
   * 获取工具组件
   */
  public getToolComponent(): ToolComponent | undefined {
    return this.getComponent<ToolComponent>('tools');
  }

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
      llmProvider: this.getLLMProvider(),
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
