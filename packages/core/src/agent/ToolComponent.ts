import { EventEmitter } from 'events';
import {
  ToolManager,
  createToolManager,
  type ToolCallRequest,
  type ToolCallResponse,
  type ToolDefinition,
  type ToolManagerConfig,
} from '../tools/index.js';
import { BaseComponent } from './BaseComponent.js';

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
      debug: false,
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
      this.toolManager = await createToolManager(this.config, this.config.includeBuiltinTools);

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
      tool =>
        tool.name.toLowerCase().includes(lowerQuery) ||
        tool.description.toLowerCase().includes(lowerQuery) ||
        (tool.tags && tool.tags.some(tag => tag.toLowerCase().includes(lowerQuery)))
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
  public getStats(): Record<string, any> {
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
  public on(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * 移除事件监听器
   */
  public off(event: string, listener: (...args: any[]) => void): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * 发送事件
   */
  public emit(event: string, ...args: any[]): boolean {
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

    this.toolManager.on('toolRegistered', event => {
      this.emit('toolRegistered', event);
    });

    this.toolManager.on('toolUnregistered', event => {
      this.emit('toolUnregistered', event);
    });

    this.toolManager.on('toolCallStarted', event => {
      this.emit('toolCallStarted', event);
    });

    this.toolManager.on('toolCallCompleted', event => {
      this.emit('toolCallCompleted', event);
    });

    this.toolManager.on('toolCallFailed', event => {
      this.emit('toolCallFailed', event);
    });

    this.toolManager.on('toolStateChanged', event => {
      this.emit('toolStateChanged', event);
    });
  }

  /**
   * 生成工具文档
   */
  public generateToolDocs(): string {
    const tools = this.getTools();
    const categories = this.getToolsByCategory();

    let docs = '# 工具文档\n\n';
    docs += `总计 ${tools.length} 个工具\n\n`;

    for (const [category, categoryTools] of Object.entries(categories)) {
      docs += `## ${category.toUpperCase()} (${categoryTools.length})\n\n`;

      for (const tool of categoryTools) {
        docs += `### ${tool.name}\n`;
        docs += `${tool.description}\n\n`;

        if (tool.version) {
          docs += `**版本:** ${tool.version}\n`;
        }

        if (tool.tags && tool.tags.length > 0) {
          docs += `**标签:** ${tool.tags.join(', ')}\n`;
        }

        docs += '\n**参数:**\n';
        docs += '```\n';

        for (const [paramName, paramSchema] of Object.entries(tool.parameters)) {
          const required = tool.required?.includes(paramName) ? ' (必需)' : '';
          const defaultValue =
            paramSchema.default !== undefined ? ` (默认: ${paramSchema.default})` : '';

          docs += `${paramName}: ${paramSchema.type}${required}${defaultValue}\n`;
          if (paramSchema.description) {
            docs += `  ${paramSchema.description}\n`;
          }
        }

        docs += '```\n\n';
        docs += '---\n\n';
      }
    }

    return docs;
  }

  /**
   * 记录日志
   */
  private log(message: string, data?: any): void {
    if (this.config.debug) {
      console.log(`[ToolComponent] ${message}`, data || '');
    }
  }

  /**
   * 记录错误
   */
  private error(message: string, error?: any): void {
    console.error(`[ToolComponent] ${message}`, error || '');
  }
}
