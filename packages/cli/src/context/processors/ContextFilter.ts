import {
  ContextData,
  ContextMessage,
  ContextFilter as FilterOptions,
} from '../types.js';

/**
 * 上下文过滤器 - 根据配置过滤和筛选上下文内容
 */
export class ContextFilter {
  private readonly defaultOptions: Required<FilterOptions>;

  constructor(defaultOptions?: FilterOptions) {
    this.defaultOptions = {
      maxTokens: 32000,
      maxMessages: 50,
      timeWindow: 24 * 60 * 60 * 1000, // 24小时
      priority: 1,
      includeTools: true,
      includeWorkspace: true,
      ...defaultOptions,
    };
  }

  /**
   * 过滤上下文数据
   */
  filter(contextData: ContextData, options?: FilterOptions): ContextData {
    const filterOptions = { ...this.defaultOptions, ...options };

    const filteredData: ContextData = {
      layers: {
        system: contextData.layers.system,
        session: contextData.layers.session,
        conversation: this.filterConversation(
          contextData.layers.conversation,
          filterOptions
        ),
        tool: filterOptions.includeTools
          ? this.filterTools(contextData.layers.tool, filterOptions)
          : { recentCalls: [], toolStates: {}, dependencies: {} },
        workspace: filterOptions.includeWorkspace
          ? contextData.layers.workspace
          : { currentFiles: [], recentFiles: [], environment: {} },
      },
      metadata: {
        ...contextData.metadata,
        lastUpdated: Date.now(),
      },
    };

    // 重新计算 token 数量
    filteredData.metadata.totalTokens = this.estimateTokens(filteredData);

    return filteredData;
  }

  /**
   * 过滤对话上下文
   */
  private filterConversation(
    conversation: ContextData['layers']['conversation'],
    options: Required<FilterOptions>
  ): ContextData['layers']['conversation'] {
    let filteredMessages = [...conversation.messages];

    // 时间窗口过滤
    if (options.timeWindow > 0) {
      const cutoffTime = Date.now() - options.timeWindow;
      filteredMessages = filteredMessages.filter(
        (msg) => msg.timestamp >= cutoffTime || msg.role === 'system'
      );
    }

    // 优先级过滤
    if (options.priority > 1) {
      filteredMessages = this.filterByPriority(filteredMessages, options.priority);
    }

    // 消息数量限制
    if (options.maxMessages > 0) {
      filteredMessages = this.limitMessages(filteredMessages, options.maxMessages);
    }

    // Token 数量限制
    if (options.maxTokens > 0) {
      filteredMessages = this.limitByTokens(filteredMessages, options.maxTokens);
    }

    return {
      messages: filteredMessages,
      summary: conversation.summary,
      topics: this.updateTopics(filteredMessages, conversation.topics),
      lastActivity: conversation.lastActivity,
    };
  }

  /**
   * 过滤工具上下文
   */
  private filterTools(
    toolContext: ContextData['layers']['tool'],
    options: Required<FilterOptions>
  ): ContextData['layers']['tool'] {
    let filteredCalls = [...toolContext.recentCalls];

    // 时间窗口过滤
    if (options.timeWindow > 0) {
      const cutoffTime = Date.now() - options.timeWindow;
      filteredCalls = filteredCalls.filter((call) => call.timestamp >= cutoffTime);
    }

    // 保留最近的成功调用和失败调用（用于学习）
    const successCalls = filteredCalls.filter((call) => call.status === 'success');
    const failedCalls = filteredCalls.filter((call) => call.status === 'error');

    // 限制每种状态的调用数量
    const maxSuccessfulCalls = Math.min(20, successCalls.length);
    const maxFailedCalls = Math.min(10, failedCalls.length);

    const limitedCalls = [
      ...successCalls.slice(-maxSuccessfulCalls),
      ...failedCalls.slice(-maxFailedCalls),
    ].sort((a, b) => a.timestamp - b.timestamp);

    return {
      recentCalls: limitedCalls,
      toolStates: toolContext.toolStates,
      dependencies: toolContext.dependencies,
    };
  }

  /**
   * 按优先级过滤消息
   */
  private filterByPriority(
    messages: ContextMessage[],
    minPriority: number
  ): ContextMessage[] {
    return messages.filter((msg) => {
      // 系统消息始终保留
      if (msg.role === 'system') return true;

      // 计算消息优先级
      const priority = this.calculateMessagePriority(msg);
      return priority >= minPriority;
    });
  }

  /**
   * 计算消息优先级
   */
  private calculateMessagePriority(message: ContextMessage): number {
    let priority = 1;

    // 基于角色的基础分数
    if (message.role === 'system') priority += 3;
    else if (message.role === 'assistant') priority += 1;

    // 基于内容的分数
    const content = message.content.toLowerCase();

    // 包含重要关键词
    const importantKeywords = ['错误', '警告', '重要', '关键', '问题', '解决'];
    if (importantKeywords.some((keyword) => content.includes(keyword))) {
      priority += 2;
    }

    // 包含代码或技术内容
    if (
      content.includes('```') ||
      content.includes('function') ||
      content.includes('class')
    ) {
      priority += 1;
    }

    // 基于时间的衰减（最近的消息优先级更高）
    const ageInHours = (Date.now() - message.timestamp) / (60 * 60 * 1000);
    if (ageInHours < 1) priority += 2;
    else if (ageInHours < 6) priority += 1;

    return priority;
  }

  /**
   * 限制消息数量
   */
  private limitMessages(
    messages: ContextMessage[],
    maxMessages: number
  ): ContextMessage[] {
    if (messages.length <= maxMessages) {
      return messages;
    }

    // 分离系统消息和其他消息
    const systemMessages = messages.filter((msg) => msg.role === 'system');
    const otherMessages = messages.filter((msg) => msg.role !== 'system');

    // 保留系统消息和最近的其他消息
    const remainingSlots = maxMessages - systemMessages.length;
    const limitedOtherMessages =
      remainingSlots > 0 ? otherMessages.slice(-remainingSlots) : [];

    return [...systemMessages, ...limitedOtherMessages].sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }

  /**
   * 按 Token 数量限制消息
   */
  private limitByTokens(
    messages: ContextMessage[],
    maxTokens: number
  ): ContextMessage[] {
    if (maxTokens <= 0) return messages;

    let totalTokens = 0;
    const result: ContextMessage[] = [];

    // 从最新消息开始向前计算
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const messageTokens = this.estimateMessageTokens(message);

      if (message.role === 'system') {
        // 系统消息必须包含，如果空间不够则压缩
        if (totalTokens + messageTokens <= maxTokens) {
          result.unshift(message);
          totalTokens += messageTokens;
        } else {
          const compressedMessage = this.compressMessage(
            message,
            maxTokens - totalTokens
          );
          result.unshift(compressedMessage);
          totalTokens += this.estimateMessageTokens(compressedMessage);
        }
      } else if (totalTokens + messageTokens <= maxTokens) {
        result.unshift(message);
        totalTokens += messageTokens;
      } else {
        break;
      }
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 估算消息的 Token 数量
   */
  private estimateMessageTokens(message: ContextMessage): number {
    // 简单估算：4个字符约等于1个token（中文）
    return Math.ceil(message.content.length / 4);
  }

  /**
   * 压缩消息内容
   */
  private compressMessage(message: ContextMessage, maxTokens: number): ContextMessage {
    const maxLength = maxTokens * 4; // 粗略换算为字符数

    if (message.content.length <= maxLength) {
      return message;
    }

    const compressed = message.content.substring(0, maxLength - 3) + '...';

    return {
      ...message,
      content: compressed,
      metadata: {
        ...message.metadata,
        compressed: true,
        originalLength: message.content.length,
      },
    };
  }

  /**
   * 更新主题列表
   */
  private updateTopics(messages: ContextMessage[], originalTopics: string[]): string[] {
    const topics = new Set(originalTopics);

    // 从过滤后的消息中提取新主题
    for (const message of messages) {
      const extractedTopics = this.extractTopicsFromMessage(message);
      extractedTopics.forEach((topic) => topics.add(topic));
    }

    return Array.from(topics).slice(0, 10); // 最多保留10个主题
  }

  /**
   * 从消息中提取主题
   */
  private extractTopicsFromMessage(message: ContextMessage): string[] {
    const content = message.content.toLowerCase();
    const topics: string[] = [];

    // 简单的主题提取逻辑
    const topicKeywords = [
      '项目',
      '功能',
      '模块',
      '组件',
      '服务',
      '接口',
      '数据库',
      '前端',
      '后端',
      '算法',
      '架构',
      '设计',
    ];

    topicKeywords.forEach((keyword) => {
      if (content.includes(keyword)) {
        topics.push(keyword);
      }
    });

    return topics;
  }

  /**
   * 估算上下文数据的总 Token 数量
   */
  private estimateTokens(contextData: ContextData): number {
    let totalTokens = 0;

    // 对话消息
    for (const message of contextData.layers.conversation.messages) {
      totalTokens += this.estimateMessageTokens(message);
    }

    // 系统上下文
    const systemContent = JSON.stringify(contextData.layers.system);
    totalTokens += Math.ceil(systemContent.length / 4);

    // 工具上下文
    if (contextData.layers.tool.recentCalls.length > 0) {
      const toolContent = JSON.stringify(contextData.layers.tool);
      totalTokens += Math.ceil(toolContent.length / 8); // 工具调用数据通常更简洁
    }

    return totalTokens;
  }

  /**
   * 创建预设过滤器
   */
  static createPresets() {
    return {
      // 轻量级过滤器 - 适合快速响应
      lightweight: new ContextFilter({
        maxTokens: 1000,
        maxMessages: 10,
        timeWindow: 2 * 60 * 60 * 1000, // 2小时
        includeTools: false,
        includeWorkspace: false,
      }),

      // 标准过滤器 - 平衡性能和功能
      standard: new ContextFilter({
        maxTokens: 4000,
        maxMessages: 30,
        timeWindow: 12 * 60 * 60 * 1000, // 12小时
        includeTools: true,
        includeWorkspace: true,
      }),

      // 完整过滤器 - 包含所有上下文
      comprehensive: new ContextFilter({
        maxTokens: 8000,
        maxMessages: 100,
        timeWindow: 24 * 60 * 60 * 1000, // 24小时
        includeTools: true,
        includeWorkspace: true,
      }),

      // 调试过滤器 - 专注于错误和工具调用
      debug: new ContextFilter({
        maxTokens: 2000,
        maxMessages: 20,
        timeWindow: 6 * 60 * 60 * 1000, // 6小时
        priority: 2, // 只包含高优先级消息
        includeTools: true,
        includeWorkspace: false,
      }),
    };
  }
}
