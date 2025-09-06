import {
  CompressedContext,
  ContextData,
  ContextFilter,
  ContextManagerOptions,
  ContextMessage,
  createContextManager,
  formatContextForPrompt,
  ContextManager as InternalContextManager,
  ToolCall,
  WorkspaceContext,
} from '../../context/index.js';

/**
 * 上下文管理器配置
 */
export interface ContextConfig {
  debug?: boolean;
  enabled?: boolean;
  storage?: {
    maxMemorySize?: number;
    persistentPath?: string;
    cacheSize?: number;
    compressionEnabled?: boolean;
  };
  defaultFilter?: {
    maxTokens?: number;
    maxMessages?: number;
    timeWindow?: number;
    includeTools?: boolean;
    includeWorkspace?: boolean;
  };
  compressionThreshold?: number;
  enableVectorSearch?: boolean;
}

/**
 * 上下文管理器 - 管理对话历史、工具调用记录和工作空间状态
 */
export class ContextManager {
  private internalContextManager?: InternalContextManager;
  private config: ContextConfig;
  private currentSessionId?: string;
  private isReady = false;

  constructor(config: ContextConfig = {}) {
    this.config = {
      debug: false,
      enabled: true,
      storage: {
        maxMemorySize: 1000,
        persistentPath: './blade-context',
        cacheSize: 100,
        compressionEnabled: true,
        ...config.storage,
      },
      defaultFilter: {
        maxTokens: 4000,
        maxMessages: 50,
        timeWindow: 24 * 60 * 60 * 1000, // 24小时
        includeTools: true,
        includeWorkspace: true,
        ...config.defaultFilter,
      },
      compressionThreshold: 6000,
      enableVectorSearch: false,
      ...config,
    };
  }

  /**
   * 初始化上下文管理器
   */
  public async init(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (this.isReady) {
      throw new Error('上下文管理器已经初始化');
    }

    try {
      // 创建上下文管理器配置
      const managerOptions: Partial<ContextManagerOptions> = {
        storage: this.config.storage && {
          maxMemorySize: this.config.storage.maxMemorySize || 1000,
          persistentPath: this.config.storage.persistentPath,
          cacheSize: this.config.storage.cacheSize || 100,
          compressionEnabled: this.config.storage.compressionEnabled || true,
        },
        defaultFilter: this.config.defaultFilter,
        compressionThreshold: this.config.compressionThreshold,
        enableVectorSearch: this.config.enableVectorSearch,
      };

      // 创建并初始化内部上下文管理器
      this.internalContextManager = createContextManager(managerOptions);
      await this.internalContextManager.initialize();

      this.isReady = true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 销毁上下文管理器
   */
  public async destroy(): Promise<void> {
    if (!this.isReady) {
      return;
    }

    try {
      if (this.internalContextManager) {
        await this.internalContextManager.cleanup();
        this.internalContextManager = undefined;
      }

      this.currentSessionId = undefined;
      this.isReady = false;
    } catch (error) {
      // 静默处理错误
    }
  }

  /**
   * 创建新会话
   */
  public async createSession(
    userId?: string,
    preferences: Record<string, any> = {},
    configuration: Record<string, any> = {},
    customSessionId?: string
  ): Promise<string> {
    if (!this.isReady || !this.internalContextManager) {
      throw new Error('上下文管理器未初始化');
    }

    // 如果提供了自定义会话ID，先尝试加载
    if (customSessionId) {
      const loadSuccess = await this.loadSession(customSessionId);
      if (loadSuccess) {
        return customSessionId;
      }
    }

    // 创建新会话，如果提供了自定义ID则使用
    if (customSessionId) {
      configuration.sessionId = customSessionId;
    }

    this.currentSessionId = await this.internalContextManager.createSession(
      userId,
      preferences,
      configuration
    );

    if (customSessionId && this.currentSessionId !== customSessionId) {
      this.currentSessionId = customSessionId;
    }

    return this.currentSessionId;
  }

  /**
   * 加载现有会话
   */
  public async loadSession(sessionId: string): Promise<boolean> {
    if (!this.isReady || !this.internalContextManager) {
      throw new Error('上下文管理器未初始化');
    }

    const success = await this.internalContextManager.loadSession(sessionId);
    if (success) {
      this.currentSessionId = sessionId;
    }

    return success;
  }

  /**
   * 获取当前会话ID
   */
  public getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  /**
   * 添加用户消息
   */
  public async addUserMessage(content: string, metadata?: Record<string, any>): Promise<void> {
    this.ensureReady();
    await this.internalContextManager!.addMessage('user', content, metadata);
    this.log(`添加用户消息: ${content.substring(0, 50)}...`);
  }

  /**
   * 添加助手消息
   */
  public async addAssistantMessage(content: string, metadata?: Record<string, any>): Promise<void> {
    this.ensureReady();
    await this.internalContextManager!.addMessage('assistant', content, metadata);
    this.log(`添加助手消息: ${content.substring(0, 50)}...`);
  }

  /**
   * 添加系统消息
   */
  public async addSystemMessage(content: string, metadata?: Record<string, any>): Promise<void> {
    this.ensureReady();
    await this.internalContextManager!.addMessage('system', content, metadata);
    this.log(`添加系统消息: ${content.substring(0, 50)}...`);
  }

  /**
   * 添加工具调用记录
   */
  public async addToolCall(toolCall: ToolCall): Promise<void> {
    this.ensureReady();
    await this.internalContextManager!.addToolCall(toolCall);
    this.log(`添加工具调用: ${toolCall.name} (${toolCall.status})`);
  }

  /**
   * 更新工具状态
   */
  public updateToolState(toolName: string, state: any): void {
    this.ensureReady();
    this.internalContextManager!.updateToolState(toolName, state);
    this.log(`更新工具状态: ${toolName}`);
  }

  /**
   * 更新工作空间信息
   */
  public updateWorkspace(updates: Partial<WorkspaceContext>): void {
    this.ensureReady();
    this.internalContextManager!.updateWorkspace(updates);
    this.log('工作空间信息已更新');
  }

  /**
   * 获取格式化的上下文
   */
  public async getFormattedContext(filterOptions?: ContextFilter): Promise<{
    context: ContextData;
    compressed?: CompressedContext;
    tokenCount: number;
  }> {
    this.ensureReady();
    return await this.internalContextManager!.getFormattedContext(filterOptions);
  }

  /**
   * 获取上下文为Prompt字符串
   */
  public async getContextForPrompt(
    filterOptions?: ContextFilter,
    formatOptions?: {
      includeSystemInfo?: boolean;
      includeToolHistory?: boolean;
      includeWorkspaceInfo?: boolean;
      maxRecentMessages?: number;
    }
  ): Promise<string> {
    this.ensureReady();

    const { context, compressed } = await this.getFormattedContext(filterOptions);
    return formatContextForPrompt(context, compressed, formatOptions);
  }

  /**
   * 搜索历史会话
   */
  public async searchSessions(
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
    this.ensureReady();
    return await this.internalContextManager!.searchSessions(query, limit);
  }

  /**
   * 获取缓存的工具调用结果
   */
  public getCachedToolResult(toolName: string, input: any): any {
    this.ensureReady();
    return this.internalContextManager!.getCachedToolResult(toolName, input);
  }

  /**
   * 获取统计信息
   */
  public async getStats(): Promise<{
    currentSession: string | null;
    memory: any;
    cache: any;
    storage: any;
  }> {
    this.ensureReady();
    return await this.internalContextManager!.getStats();
  }

  /**
   * 构建包含上下文的消息列表
   */
  public async buildMessagesWithContext(
    userMessage: string,
    systemPrompt?: string,
    filterOptions?: ContextFilter
  ): Promise<ContextMessage[]> {
    this.ensureReady();

    const messages: ContextMessage[] = [];

    // 添加系统提示词
    if (systemPrompt) {
      messages.push({
        id: `sys_${Date.now()}`,
        role: 'system',
        content: systemPrompt,
        timestamp: Date.now(),
      });
    }

    // 获取并添加历史上下文
    const { context, compressed } = await this.getFormattedContext(filterOptions);

    if (compressed) {
      // 使用压缩后的上下文
      messages.push(...compressed.recentMessages);
    } else {
      // 使用完整的上下文
      messages.push(...context.layers.conversation.messages);
    }

    // 添加当前用户消息
    const currentMessage: ContextMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    };
    messages.push(currentMessage);

    // 将用户消息添加到上下文中
    await this.addUserMessage(userMessage);

    return messages;
  }

  /**
   * 检查上下文组件是否已准备就绪
   */
  public isContextReady(): boolean {
    return this.isReady && !!this.internalContextManager && !!this.currentSessionId;
  }

  /**
   * 获取上下文管理器实例（用于高级操作）
   */
  public getInternalContextManager(): InternalContextManager | undefined {
    return this.internalContextManager;
  }

  /**
   * 确保组件已准备就绪
   */
  private ensureReady(): void {
    if (!this.isReady || !this.internalContextManager) {
      throw new Error('上下文组件未初始化或已被禁用');
    }

    if (!this.currentSessionId) {
      throw new Error('没有活动会话，请先创建或加载会话');
    }
  }

  /**
   * 记录日志
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[ContextComponent] ${message}`);
    }
  }
}
