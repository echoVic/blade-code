import { ContextData, ContextMessage, ToolCall, WorkspaceContext } from '../types.js';

/**
 * 内存存储实现 - 用于当前会话的快速数据访问
 */
export class MemoryStore {
  private contextData: ContextData | null = null;
  private readonly maxSize: number;
  private readonly accessLog: Map<string, number> = new Map();

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * 存储上下文数据
   */
  setContext(data: ContextData): void {
    this.contextData = { ...data };
    this.contextData.metadata.lastUpdated = Date.now();
    this.recordAccess('context');
  }

  /**
   * 获取完整上下文数据
   */
  getContext(): ContextData | null {
    if (this.contextData) {
      this.recordAccess('context');
    }
    return this.contextData;
  }

  /**
   * 添加消息到对话上下文
   */
  addMessage(message: ContextMessage): void {
    if (!this.contextData) {
      throw new Error('上下文数据未初始化');
    }

    this.contextData.layers.conversation.messages.push(message);
    this.contextData.layers.conversation.lastActivity = Date.now();
    this.contextData.metadata.lastUpdated = Date.now();

    // 检查是否超过大小限制
    this.enforceMemoryLimit();
    this.recordAccess('messages');
  }

  /**
   * 获取最近的消息
   */
  getRecentMessages(count: number = 10): ContextMessage[] {
    if (!this.contextData) {
      return [];
    }

    const messages = this.contextData.layers.conversation.messages;
    this.recordAccess('messages');
    return messages.slice(-count);
  }

  /**
   * 添加工具调用记录
   */
  addToolCall(toolCall: ToolCall): void {
    if (!this.contextData) {
      throw new Error('上下文数据未初始化');
    }

    this.contextData.layers.tool.recentCalls.push(toolCall);
    this.contextData.metadata.lastUpdated = Date.now();

    // 保持工具调用历史在合理范围内
    if (this.contextData.layers.tool.recentCalls.length > 50) {
      this.contextData.layers.tool.recentCalls =
        this.contextData.layers.tool.recentCalls.slice(-25);
    }

    this.recordAccess('tools');
  }

  /**
   * 更新工具状态
   */
  updateToolState(toolName: string, state: any): void {
    if (!this.contextData) {
      throw new Error('上下文数据未初始化');
    }

    this.contextData.layers.tool.toolStates[toolName] = state;
    this.contextData.metadata.lastUpdated = Date.now();
    this.recordAccess('tools');
  }

  /**
   * 获取工具状态
   */
  getToolState(toolName: string): any {
    if (!this.contextData) {
      return null;
    }

    this.recordAccess('tools');
    return this.contextData.layers.tool.toolStates[toolName];
  }

  /**
   * 更新工作空间信息
   */
  updateWorkspace(updates: Partial<WorkspaceContext>): void {
    if (!this.contextData) {
      throw new Error('上下文数据未初始化');
    }

    Object.assign(this.contextData.layers.workspace, updates);
    this.contextData.metadata.lastUpdated = Date.now();
    this.recordAccess('workspace');
  }

  /**
   * 清除内存数据
   */
  clear(): void {
    this.contextData = null;
    this.accessLog.clear();
  }

  /**
   * 获取内存使用情况
   */
  getMemoryInfo(): {
    hasData: boolean;
    messageCount: number;
    toolCallCount: number;
    lastUpdated: number | null;
  } {
    if (!this.contextData) {
      return {
        hasData: false,
        messageCount: 0,
        toolCallCount: 0,
        lastUpdated: null,
      };
    }

    return {
      hasData: true,
      messageCount: this.contextData.layers.conversation.messages.length,
      toolCallCount: this.contextData.layers.tool.recentCalls.length,
      lastUpdated: this.contextData.metadata.lastUpdated,
    };
  }

  /**
   * 记录访问日志
   */
  private recordAccess(key: string): void {
    this.accessLog.set(key, Date.now());
  }

  /**
   * 强制执行内存限制
   */
  private enforceMemoryLimit(): void {
    if (!this.contextData) return;

    const messages = this.contextData.layers.conversation.messages;
    if (messages.length > this.maxSize) {
      // 保留最近的消息，删除较旧的
      const keepCount = Math.floor(this.maxSize * 0.8); // 保留80%的空间
      this.contextData.layers.conversation.messages = messages.slice(-keepCount);
    }
  }

  /**
   * 估算内存使用量（以字符数为简单估算）
   */
  getMemoryUsage(): number {
    if (!this.contextData) return 0;

    const contextString = JSON.stringify(this.contextData);
    return contextString.length;
  }
}
