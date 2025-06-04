import * as crypto from 'crypto';
import { ContextCompressor } from './processors/ContextCompressor.js';
import { ContextFilter } from './processors/ContextFilter.js';
import { CacheStore } from './storage/CacheStore.js';
import { MemoryStore } from './storage/MemoryStore.js';
import { PersistentStore } from './storage/PersistentStore.js';
import {
  CompressedContext,
  ContextData,
  ContextManagerOptions,
  ContextMessage,
  ContextFilter as FilterOptions,
  SystemContext,
  ToolCall,
  WorkspaceContext,
} from './types.js';

/**
 * 上下文管理器 - 统一管理所有上下文相关操作
 */
export class ContextManager {
  private readonly memory: MemoryStore;
  private readonly persistent: PersistentStore;
  private readonly cache: CacheStore;
  private readonly compressor: ContextCompressor;
  private readonly filter: ContextFilter;
  private readonly options: ContextManagerOptions;

  private currentSessionId: string | null = null;
  private initialized = false;

  constructor(options: Partial<ContextManagerOptions> = {}) {
    this.options = {
      storage: {
        maxMemorySize: 1000,
        persistentPath: './blade-context',
        cacheSize: 100,
        compressionEnabled: true,
        ...options.storage,
      },
      defaultFilter: {
        maxTokens: 4000,
        maxMessages: 50,
        timeWindow: 24 * 60 * 60 * 1000,
        ...options.defaultFilter,
      },
      compressionThreshold: options.compressionThreshold || 6000,
      enableVectorSearch: options.enableVectorSearch || false,
    };

    // 初始化存储层
    this.memory = new MemoryStore(this.options.storage.maxMemorySize);
    this.persistent = new PersistentStore(this.options.storage.persistentPath, 100);
    this.cache = new CacheStore(
      this.options.storage.cacheSize,
      5 * 60 * 1000 // 5分钟默认TTL
    );

    // 初始化处理器
    this.compressor = new ContextCompressor();
    this.filter = new ContextFilter(this.options.defaultFilter);
  }

  /**
   * 初始化上下文管理器
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.persistent.initialize();

      // 检查存储健康状态
      const health = await this.persistent.checkStorageHealth();
      if (!health.isAvailable) {
        console.warn('警告：持久化存储不可用，将仅使用内存存储');
      }

      this.initialized = true;
      console.log('上下文管理器初始化完成');
    } catch (error) {
      console.error('上下文管理器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 创建新会话
   */
  async createSession(
    userId?: string,
    preferences: Record<string, any> = {},
    configuration: Record<string, any> = {}
  ): Promise<string> {
    // 优先使用配置中的sessionId，否则生成新的
    const sessionId = configuration.sessionId || this.generateSessionId();
    const now = Date.now();

    // 创建初始上下文数据
    const contextData: ContextData = {
      layers: {
        system: await this.createSystemContext(),
        session: {
          sessionId,
          userId,
          preferences,
          configuration,
          startTime: now,
        },
        conversation: {
          messages: [],
          topics: [],
          lastActivity: now,
        },
        tool: {
          recentCalls: [],
          toolStates: {},
          dependencies: {},
        },
        workspace: await this.createWorkspaceContext(),
      },
      metadata: {
        totalTokens: 0,
        priority: 1,
        lastUpdated: now,
      },
    };

    // 存储到内存和持久化存储
    this.memory.setContext(contextData);
    await this.persistent.saveContext(sessionId, contextData);

    this.currentSessionId = sessionId;

    console.log(`新会话已创建: ${sessionId}`);
    return sessionId;
  }

  /**
   * 加载现有会话
   */
  async loadSession(sessionId: string): Promise<boolean> {
    try {
      // 先尝试从内存加载
      let contextData = this.memory.getContext();

      if (!contextData || contextData.layers.session.sessionId !== sessionId) {
        // 从持久化存储加载
        const [session, conversation] = await Promise.all([
          this.persistent.loadSession(sessionId),
          this.persistent.loadConversation(sessionId),
        ]);

        if (!session || !conversation) {
          return false;
        }

        // 重建完整的上下文数据
        contextData = {
          layers: {
            system: await this.createSystemContext(),
            session,
            conversation,
            tool: {
              recentCalls: [],
              toolStates: {},
              dependencies: {},
            },
            workspace: await this.createWorkspaceContext(),
          },
          metadata: {
            totalTokens: 0,
            priority: 1,
            lastUpdated: Date.now(),
          },
        };

        this.memory.setContext(contextData);
      }

      this.currentSessionId = sessionId;
      console.log(`会话已加载: ${sessionId}`);
      return true;
    } catch (error) {
      console.error('加载会话失败:', error);
      return false;
    }
  }

  /**
   * 添加消息到当前会话
   */
  async addMessage(
    role: ContextMessage['role'],
    content: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    const message: ContextMessage = {
      id: this.generateMessageId(),
      role,
      content,
      timestamp: Date.now(),
      metadata,
    };

    this.memory.addMessage(message);

    // 如果需要压缩，执行压缩
    const contextData = this.memory.getContext();
    if (contextData && this.shouldCompress(contextData)) {
      await this.compressCurrentContext();
    }

    // 异步保存到持久化存储
    this.saveCurrentSessionAsync();
  }

  /**
   * 添加工具调用记录
   */
  async addToolCall(toolCall: ToolCall): Promise<void> {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    this.memory.addToolCall(toolCall);

    // 缓存成功的工具调用结果
    if (toolCall.status === 'success' && toolCall.output) {
      this.cache.cacheToolResult(toolCall.name, toolCall.input, toolCall.output);
    }

    // 异步保存
    this.saveCurrentSessionAsync();
  }

  /**
   * 更新工具状态
   */
  updateToolState(toolName: string, state: any): void {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    this.memory.updateToolState(toolName, state);
  }

  /**
   * 更新工作空间信息
   */
  updateWorkspace(updates: Partial<WorkspaceContext>): void {
    if (!this.currentSessionId) {
      throw new Error('没有活动会话');
    }

    this.memory.updateWorkspace(updates);
  }

  /**
   * 获取格式化的上下文用于 Prompt 构建
   */
  async getFormattedContext(filterOptions?: FilterOptions): Promise<{
    context: ContextData;
    compressed?: CompressedContext;
    tokenCount: number;
  }> {
    const contextData = this.memory.getContext();
    if (!contextData) {
      throw new Error('没有可用的上下文数据');
    }

    // 应用过滤器
    const filteredContext = this.filter.filter(contextData, filterOptions);

    // 检查是否需要压缩
    const shouldCompress = this.shouldCompress(filteredContext);
    let compressed: CompressedContext | undefined;

    if (shouldCompress) {
      // 尝试从缓存获取压缩结果
      const contextHash = this.hashContext(filteredContext);
      compressed = this.cache.getCompressedContext(contextHash);

      if (!compressed) {
        compressed = await this.compressor.compress(filteredContext);
        this.cache.cacheCompressedContext(contextHash, compressed);
      }
    }

    return {
      context: filteredContext,
      compressed,
      tokenCount: compressed ? compressed.tokenCount : filteredContext.metadata.totalTokens,
    };
  }

  /**
   * 搜索历史会话
   */
  async searchSessions(
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
    const sessions = await this.persistent.listSessions();
    const results: Array<{
      sessionId: string;
      summary: string;
      lastActivity: number;
      relevanceScore: number;
    }> = [];

    for (const sessionId of sessions) {
      const summary = await this.persistent.getSessionSummary(sessionId);
      if (summary) {
        const relevanceScore = this.calculateRelevance(query, summary.topics);
        if (relevanceScore > 0) {
          results.push({
            sessionId,
            summary: `${summary.messageCount}条消息，主题：${summary.topics.join('、')}`,
            lastActivity: summary.lastActivity,
            relevanceScore,
          });
        }
      }
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  /**
   * 获取缓存的工具调用结果
   */
  getCachedToolResult(toolName: string, input: any): any {
    return this.cache.getToolResult(toolName, input);
  }

  /**
   * 获取管理器统计信息
   */
  async getStats(): Promise<{
    currentSession: string | null;
    memory: any;
    cache: any;
    storage: any;
  }> {
    const [memoryInfo, cacheStats, storageStats] = await Promise.all([
      Promise.resolve(this.memory.getMemoryInfo()),
      Promise.resolve(this.cache.getStats()),
      this.persistent.getStorageStats(),
    ]);

    return {
      currentSession: this.currentSessionId,
      memory: memoryInfo,
      cache: cacheStats,
      storage: storageStats,
    };
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    if (this.currentSessionId) {
      await this.saveCurrentSession();
    }

    this.memory.clear();
    this.cache.clear();
    await this.persistent.cleanupOldSessions();

    this.currentSessionId = null;
    console.log('上下文管理器资源清理完成');
  }

  // 私有方法

  private generateSessionId(): string {
    return `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  }

  private async createSystemContext(): Promise<SystemContext> {
    return {
      role: 'AI助手',
      capabilities: ['对话', '工具调用', '代码生成', '文档分析'],
      tools: ['文件操作', 'Git操作', '代码分析'],
      version: '1.0.0',
    };
  }

  private async createWorkspaceContext(): Promise<WorkspaceContext> {
    try {
      const cwd = process.cwd();
      return {
        projectPath: cwd,
        currentFiles: [],
        recentFiles: [],
        environment: {
          nodeVersion: process.version,
          platform: process.platform,
          cwd,
        },
      };
    } catch (error) {
      return {
        currentFiles: [],
        recentFiles: [],
        environment: {},
      };
    }
  }

  private shouldCompress(contextData: ContextData): boolean {
    return contextData.metadata.totalTokens > this.options.compressionThreshold;
  }

  private async compressCurrentContext(): Promise<void> {
    const contextData = this.memory.getContext();
    if (!contextData) return;

    const compressed = await this.compressor.compress(contextData);

    // 更新对话摘要
    contextData.layers.conversation.summary = compressed.summary;

    this.memory.setContext(contextData);
  }

  private async saveCurrentSession(): Promise<void> {
    if (!this.currentSessionId) return;

    const contextData = this.memory.getContext();
    if (contextData) {
      await this.persistent.saveContext(this.currentSessionId, contextData);
    }
  }

  private saveCurrentSessionAsync(): void {
    // 异步保存，不阻塞主流程
    this.saveCurrentSession().catch(error => {
      console.warn('异步保存会话失败:', error);
    });
  }

  private hashContext(contextData: ContextData): string {
    const content = JSON.stringify({
      messageCount: contextData.layers.conversation.messages.length,
      lastMessage:
        contextData.layers.conversation.messages[
          contextData.layers.conversation.messages.length - 1
        ]?.id,
      toolCallCount: contextData.layers.tool.recentCalls.length,
    });

    return crypto.createHash('md5').update(content).digest('hex');
  }

  private calculateRelevance(query: string, topics: string[]): number {
    const queryLower = query.toLowerCase();
    let score = 0;

    for (const topic of topics) {
      if (queryLower.includes(topic.toLowerCase()) || topic.toLowerCase().includes(queryLower)) {
        score += 1;
      }
    }

    return score;
  }
}
