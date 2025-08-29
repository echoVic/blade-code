import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  ToolExecutionError,
  ToolRegistrationError,
  type ToolCallRequest,
  type ToolCallResponse,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionHistory,
  type ToolExecutionResult,
  type ToolManagerConfig,
  type ToolRegistrationOptions,
} from './types.js';
import { ToolValidator } from './validator.js';

/**
 * 工具管理器 - 负责工具的注册、管理和调用
 */
export class ToolManager extends EventEmitter {
  private tools = new Map<string, ToolDefinition>();
  private toolStates = new Map<string, { enabled: boolean; permissions: string[] }>();
  private executionHistory: ToolExecutionHistory[] = [];
  private runningExecutions = new Map<string, Promise<ToolExecutionResult>>();
  private config: Required<ToolManagerConfig>;

  constructor(config: ToolManagerConfig = {}) {
    super();

    this.config = {
      debug: false,
      maxConcurrency: 10,
      executionTimeout: 30000, // 30秒
      logHistory: true,
      maxHistorySize: 1000,
      ...config,
    };

    this.log('工具管理器已初始化', { config: this.config });
  }

  /**
   * 注册工具
   */
  public async registerTool(
    tool: ToolDefinition,
    options: ToolRegistrationOptions = {}
  ): Promise<void> {
    try {
      // 验证工具定义
      this.validateToolDefinition(tool);

      // 检查是否已存在
      if (this.tools.has(tool.name) && !options.override) {
        throw new ToolRegistrationError(
          `工具 "${tool.name}" 已存在，使用 override: true 强制覆盖`,
          tool.name
        );
      }

      // 注册工具
      this.tools.set(tool.name, tool);
      this.toolStates.set(tool.name, {
        enabled: options.enabled ?? true,
        permissions: options.permissions ?? [],
      });

      this.log(`工具 "${tool.name}" 注册成功`, {
        version: tool.version,
        category: tool.category,
        enabled: options.enabled ?? true,
      });

      this.emit('toolRegistered', {
        toolName: tool.name,
        tool,
        options,
      });
    } catch (error) {
      this.log(`工具 "${tool.name}" 注册失败`, { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 注销工具
   */
  public unregisterTool(toolName: string): boolean {
    const existed = this.tools.has(toolName);

    if (existed) {
      this.tools.delete(toolName);
      this.toolStates.delete(toolName);

      this.log(`工具 "${toolName}" 已注销`);
      this.emit('toolUnregistered', { toolName });
    }

    return existed;
  }

  /**
   * 获取所有已注册的工具
   */
  public getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取特定工具
   */
  public getTool(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  /**
   * 检查工具是否存在
   */
  public hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * 启用/禁用工具
   */
  public setToolEnabled(toolName: string, enabled: boolean): void {
    const state = this.toolStates.get(toolName);
    if (!state) {
      throw new ToolRegistrationError(`工具 "${toolName}" 不存在`, toolName);
    }

    state.enabled = enabled;
    this.log(`工具 "${toolName}" ${enabled ? '已启用' : '已禁用'}`);

    this.emit('toolStateChanged', { toolName, enabled });
  }

  /**
   * 检查工具是否启用
   */
  public isToolEnabled(toolName: string): boolean {
    const state = this.toolStates.get(toolName);
    return state?.enabled ?? false;
  }

  /**
   * 调用工具
   */
  public async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    const requestId = randomUUID();
    const startTime = Date.now();

    try {
      // 检查并发限制
      if (this.runningExecutions.size >= this.config.maxConcurrency) {
        throw new ToolExecutionError('达到最大并发执行限制', request.toolName);
      }

      // 获取工具
      const tool = this.tools.get(request.toolName);
      if (!tool) {
        throw new ToolExecutionError(`工具 "${request.toolName}" 不存在`, request.toolName);
      }

      // 检查工具状态
      if (!this.isToolEnabled(request.toolName)) {
        throw new ToolExecutionError(`工具 "${request.toolName}" 已禁用`, request.toolName);
      }

      // 生成执行上下文
      const context: ToolExecutionContext = {
        executionId: requestId,
        timestamp: startTime,
        ...request.context,
      };

      // 验证和处理参数
      let processedParams = ToolValidator.applyDefaults(request.parameters, tool.parameters);

      processedParams = ToolValidator.sanitizeParameters(processedParams, tool.parameters);

      ToolValidator.validateParameters(processedParams, tool.parameters, tool.required);

      this.log(`开始执行工具 "${request.toolName}"`, {
        requestId,
        parameters: processedParams,
      });

      this.emit('toolCallStarted', {
        requestId,
        toolName: request.toolName,
        parameters: processedParams,
        context,
      });

      // 执行工具
      const executionPromise = this.executeToolWithTimeout(tool, processedParams);

      this.runningExecutions.set(requestId, executionPromise);

      const result = await executionPromise;

      // 记录执行时间
      result.duration = Date.now() - startTime;

      this.log(`工具 "${request.toolName}" 执行完成`, {
        requestId,
        duration: result.duration,
        success: result.success,
      });

      // 构建响应
      const response: ToolCallResponse = {
        requestId,
        toolName: request.toolName,
        result,
        context,
      };

      // 记录历史
      if (this.config.logHistory) {
        this.addToHistory({
          executionId: requestId,
          toolName: request.toolName,
          parameters: processedParams,
          result,
          context,
          createdAt: new Date(),
        });
      }

      this.emit('toolCallCompleted', response);

      return response;
    } catch (error) {
      const result: ToolExecutionResult = {
        success: false,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };

      const response: ToolCallResponse = {
        requestId,
        toolName: request.toolName,
        result,
        context: {
          executionId: requestId,
          timestamp: startTime,
          ...request.context,
        },
      };

      this.log(`工具 "${request.toolName}" 执行失败`, {
        requestId,
        error: (error as Error).message,
      });

      this.emit('toolCallFailed', { ...response, error });

      return response;
    } finally {
      this.runningExecutions.delete(requestId);
    }
  }

  /**
   * 获取执行历史
   */
  public getExecutionHistory(limit?: number): ToolExecutionHistory[] {
    const history = [...this.executionHistory];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * 清空执行历史
   */
  public clearHistory(): void {
    this.executionHistory = [];
    this.log('执行历史已清空');
  }

  /**
   * 获取工具统计信息
   */
  public getStats(): Record<string, any> {
    const stats = {
      totalTools: this.tools.size,
      enabledTools: 0,
      runningExecutions: this.runningExecutions.size,
      totalExecutions: this.executionHistory.length,
      successfulExecutions: 0,
      failedExecutions: 0,
    };

    // 统计启用的工具
    for (const state of this.toolStates.values()) {
      if (state.enabled) {
        stats.enabledTools++;
      }
    }

    // 统计执行结果
    for (const history of this.executionHistory) {
      if (history.result.success) {
        stats.successfulExecutions++;
      } else {
        stats.failedExecutions++;
      }
    }

    return stats;
  }

  /**
   * 验证工具定义
   */
  private validateToolDefinition(tool: ToolDefinition): void {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new ToolRegistrationError('工具名称必须是非空字符串');
    }

    if (!tool.description || typeof tool.description !== 'string') {
      throw new ToolRegistrationError('工具描述必须是非空字符串');
    }

    if (!tool.parameters || typeof tool.parameters !== 'object') {
      throw new ToolRegistrationError('工具参数定义必须是对象');
    }

    if (typeof tool.execute !== 'function') {
      throw new ToolRegistrationError('工具执行函数必须是函数');
    }
  }

  /**
   * 执行工具并设置超时
   */
  private async executeToolWithTimeout(
    tool: ToolDefinition,
    parameters: Record<string, any>
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new ToolExecutionError(`工具执行超时 (${this.config.executionTimeout}ms)`, tool.name)
        );
      }, this.config.executionTimeout);

      Promise.resolve(tool.execute(parameters))
        .then(result => {
          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;

          // 如果工具返回的已经是 ToolExecutionResult 格式，直接使用
          if (result && typeof result === 'object' && 'success' in result) {
            resolve({
              ...result,
              duration: result.duration || duration,
            });
          } else {
            // 否则包装成标准格式
            resolve({
              success: true,
              data: result,
              duration,
            });
          }
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(new ToolExecutionError(`工具执行错误: ${error.message}`, tool.name, error));
        });
    });
  }

  /**
   * 添加到历史记录
   */
  private addToHistory(history: ToolExecutionHistory): void {
    this.executionHistory.push(history);

    // 限制历史记录大小
    if (this.executionHistory.length > this.config.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-this.config.maxHistorySize);
    }
  }

  /**
   * 日志记录
   */
  private log(message: string, data?: any): void {
    if (this.config.debug) {
      console.log(`[ToolManager] ${message}`, data || '');
    }
  }
}
