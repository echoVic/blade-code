import { EventEmitter } from 'events';
import {
  createToolManager,
  type ToolResult,
} from '../tools/index.js';
import type { ToolManagerConfig } from '../tools/factory.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolDiscovery } from '../tools/registry/ToolDiscovery.js';
import { BaseComponent } from './BaseComponent.js';

/**
 * 工具定义接口
 */
export interface ToolDefinition {
  name: string;
  description: string;
  version?: string;
  category?: string;
  tags?: string[];
  parameters: Record<string, any>;
  required?: string[];
}

/**
 * 工具调用请求
 */
export interface ToolCallRequest {
  toolName: string;
  parameters: Record<string, any>;
}

/**
 * 工具调用响应
 */
export interface ToolCallResponse {
  result: ToolResult;
  metadata?: Record<string, any>;
}

/**
 * 工具管理器接口
 */
export interface ToolManager {
  getTools(): ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
  hasTool(name: string): boolean;
  registerTool(tool: ToolDefinition): Promise<void>;
  unregisterTool(name: string): void;
  callTool(request: ToolCallRequest): Promise<ToolCallResponse>;
  setToolEnabled(name: string, enabled: boolean): void;
  getStats(): Record<string, any>;
  getExecutionHistory(limit?: number): any[];
  clearHistory(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  removeAllListeners(): void;
}

/**
 * 工具组件配置
 */
export interface ToolComponentConfig extends ToolManagerConfig {
  /** 是否包含内置工具 */
  includeBuiltinTools?: boolean;
  /** 要排除的工具名称 */
  excludeTools?: string[];
  /** 要包含的工具分类 */
  includeCategories?: string[];
}

/**
 * 工具管理器适配器
 */
class ToolManagerAdapter implements ToolManager {
  constructor(
    private registry: ToolRegistry,
    private pipeline: ExecutionPipeline,
    private discovery: ToolDiscovery
  ) {}

  getTools(): ToolDefinition[] {
    return this.registry.getAll().map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      version: tool.version,
      category: tool.category,
      tags: tool.tags,
      parameters: tool.parameterSchema.properties || {},
      required: tool.parameterSchema.required
    }));
  }

  getTool(name: string): ToolDefinition | undefined {
    const tool = this.registry.get(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      version: tool.version,
      category: tool.category,
      tags: tool.tags,
      parameters: tool.parameterSchema.properties || {},
      required: tool.parameterSchema.required
    };
  }

  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  async registerTool(tool: ToolDefinition): Promise<void> {
    // 适配器暂不支持注册新工具
    console.warn('工具注册功能暂未实现');
  }

  unregisterTool(name: string): void {
    this.registry.unregister(name);
  }

  async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      throw new Error(`工具未找到: ${request.toolName}`);
    }

    const result = await this.pipeline.execute(
      request.toolName,
      request.parameters,
      {
        sessionId: 'tool-component',
        signal: new AbortController().signal
      }
    );

    return {
      result,
      metadata: { toolName: request.toolName }
    };
  }

  setToolEnabled(name: string, enabled: boolean): void {
    // 适配器暂不支持启用/禁用功能
    console.warn('工具启用/禁用功能暂未实现');
  }

  getStats(): Record<string, any> {
    return {
      totalTools: this.registry.getAll().length,
      registeredTools: this.registry.getAll().map((t: any) => t.name)
    };
  }

  getExecutionHistory(limit?: number): any[] {
    // ExecutionPipeline 没有 getHistory 方法，返回空数组
    return [];
  }

  clearHistory(): void {
    // ExecutionPipeline 没有 clearHistory 方法，暂不实现
  }

  on(event: string, listener: (...args: any[]) => void): void {
    // 事件处理暂未实现
  }

  removeAllListeners(): void {
    // 事件处理暂未实现
  }
}

/**
 * 工具组件 - 为 Agent 提供工具管理和调用能力
 */
export class ToolComponent extends BaseComponent {
  private toolManager?: ToolManager;
  private config: ToolComponentConfig;
  private eventEmitter: EventEmitter;
  private isInitialized = false;

  constructor(id = 'tools', config: ToolComponentConfig = {}) {
    super(id);
    this.config = {
      includeBuiltinTools: true,
      ...config,
    };
    this.eventEmitter = new EventEmitter();
  }

  public async init(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化工具组件...');

      // 创建工具管理器
      const managerComponents = await createToolManager(
        this.config as ToolManagerConfig,
        this.config.includeBuiltinTools
      );

      this.toolManager = new ToolManagerAdapter(
        managerComponents.registry,
        managerComponents.pipeline,
        managerComponents.discovery
      );

      // 应用过滤器
      this.applyFilters();

      // 设置事件监听
      this.setupEventListeners();

      this.isInitialized = true;
      this.log('工具组件初始化完成', {
        totalTools: this.toolManager.getTools().length,
        stats: this.toolManager.getStats(),
      });
    } catch (error) {
      this.error('工具组件初始化失败', error);
      throw error;
    }
  }

  public async destroy(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      this.log('销毁工具组件...');

      if (this.toolManager) {
        this.toolManager.removeAllListeners();
      }

      this.eventEmitter.removeAllListeners();
      this.isInitialized = false;
      this.log('工具组件已销毁');
    } catch (error) {
      this.error('工具组件销毁失败', error);
      throw error;
    }
  }

  /**
   * 获取工具管理器
   */
  public getToolManager(): ToolManager {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }
    return this.toolManager;
  }

  /**
   * 注册工具
   */
  public async registerTool(tool: ToolDefinition): Promise<void> {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }

    await this.toolManager.registerTool(tool);
    this.log(`工具 "${tool.name}" 已注册`);
  }

  /**
   * 调用工具
   */
  public async callTool(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }

    const startTime = Date.now();

    try {
      const response = await this.toolManager.callTool(request);
      const duration = Date.now() - startTime;

      this.log(`工具调用完成: ${request.toolName}`, {
        success: response.result.success,
        duration,
      });

      return response;
    } catch (error) {
      this.error(`工具调用失败: ${request.toolName}`, error);
      throw error;
    }
  }

  /**
   * 获取所有工具
   */
  public getTools(): ToolDefinition[] {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }
    return this.toolManager.getTools();
  }

  /**
   * 按分类获取工具
   */
  public getToolsByCategory(): Record<string, ToolDefinition[]> {
    const tools = this.getTools();
    const categories: Record<string, ToolDefinition[]> = {};

    for (const tool of tools) {
      const category = tool.category || 'other';
      if (!categories[category]) {
        categories[category] = [];
      }
      categories[category].push(tool);
    }

    return categories;
  }

  /**
   * 搜索工具
   */
  public searchTools(query: string): ToolDefinition[] {
    const tools = this.getTools();
    const lowerQuery = query.toLowerCase();

    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(lowerQuery) ||
        tool.description.toLowerCase().includes(lowerQuery) ||
        (tool.tags && tool.tags.some((tag: string) => tag.toLowerCase().includes(lowerQuery)))
    );
  }

  /**
   * 获取工具信息
   */
  public getToolInfo(toolName: string): ToolDefinition | undefined {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }
    return this.toolManager.getTool(toolName);
  }

  /**
   * 启用/禁用工具
   */
  public setToolEnabled(toolName: string, enabled: boolean): void {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }
    this.toolManager.setToolEnabled(toolName, enabled);
  }

  /**
   * 获取工具统计信息
   */
  public getStats(): Record<string, unknown> {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }
    return this.toolManager.getStats();
  }

  /**
   * 获取执行历史
   */
  public getExecutionHistory(limit?: number) {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }
    return this.toolManager.getExecutionHistory(limit);
  }

  /**
   * 清空执行历史
   */
  public clearHistory(): void {
    if (!this.toolManager) {
      throw new Error('工具组件未初始化');
    }
    this.toolManager.clearHistory();
  }

  /**
   * 添加事件监听器
   */
  public on(event: string, listener: (...args: unknown[]) => void): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * 移除事件监听器
   */
  public off(event: string, listener: (...args: unknown[]) => void): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * 发送事件
   */
  public emit(event: string, ...args: unknown[]): boolean {
    return this.eventEmitter.emit(event, ...args);
  }

  /**
   * 应用过滤器
   */
  private applyFilters(): void {
    if (!this.toolManager) {
      return;
    }

    const { excludeTools, includeCategories } = this.config;

    // 排除指定工具
    if (excludeTools && excludeTools.length > 0) {
      for (const toolName of excludeTools) {
        if (this.toolManager.hasTool(toolName)) {
          this.toolManager.unregisterTool(toolName);
          this.log(`已排除工具: ${toolName}`);
        }
      }
    }

    // 仅包含指定分类
    if (includeCategories && includeCategories.length > 0) {
      const tools = this.toolManager.getTools();
      for (const tool of tools) {
        if (!includeCategories.includes(tool.category || 'other')) {
          this.toolManager.unregisterTool(tool.name);
          this.log(`已排除分类 "${tool.category}" 的工具: ${tool.name}`);
        }
      }
    }
  }

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    if (!this.toolManager) {
      return;
    }

    this.toolManager.on('toolRegistered', (event: unknown) => {
      this.emit('toolRegistered', event);
    });

    this.toolManager.on('toolUnregistered', (event: unknown) => {
      this.emit('toolUnregistered', event);
    });

    this.toolManager.on('toolCallStarted', (event: unknown) => {
      this.emit('toolCallStarted', event);
    });

    this.toolManager.on('toolCallCompleted', (event: unknown) => {
      this.emit('toolCallCompleted', event);
    });

    this.toolManager.on('toolCallFailed', (event: unknown) => {
      this.emit('toolCallFailed', event);
    });

    this.toolManager.on('toolStateChanged', (event: unknown) => {
      this.emit('toolStateChanged', event);
    });
  }

  /**
   * 生成工具文档
   */
  public generateToolDocs(): string {
    const tools = this.getTools();
    const categories = this.getToolsByCategory();

    let docs = '# 工具文档\\n\\n';
    docs += `总计 ${tools.length} 个工具\\n\\n`;

    for (const [category, categoryTools] of Object.entries(categories)) {
      docs += `## ${category.toUpperCase()} (${categoryTools.length})\\n\\n`;

      for (const tool of categoryTools) {
        docs += `### ${tool.name}\\n`;
        docs += `${tool.description}\\n\\n`;

        if (tool.version) {
          docs += `**版本:** ${tool.version}\\n`;
        }

        if (tool.tags && tool.tags.length > 0) {
          docs += `**标签:** ${tool.tags.join(', ')}\\n`;
        }

        docs += '\\n**参数:**\\n';
        docs += '```\\n';

        for (const [paramName, paramSchema] of Object.entries(tool.parameters)) {
          const schema = paramSchema as any;
          const required = tool.required?.includes(paramName) ? ' (必需)' : '';
          const defaultValue =
            schema.default !== undefined ? ` (默认: ${schema.default})` : '';

          docs += `${paramName}: ${schema.type || 'unknown'}${required}${defaultValue}\\n`;
          if (schema.description) {
            docs += `  ${schema.description}\\n`;
          }
        }

        docs += '```\\n\\n';
        docs += '---\\n\\n';
      }
    }

    return docs;
  }

  /**
   * 记录日志
   */
  private log(message: string, data?: unknown): void {
    if ((this.config as any).debug) {
      console.log(`[ToolComponent] ${message}`, data || '');
    }
  }

  /**
   * 记录错误
   */
  private error(message: string, error?: unknown): void {
    console.error(`[ToolComponent] ${message}`, error || '');
  }
}