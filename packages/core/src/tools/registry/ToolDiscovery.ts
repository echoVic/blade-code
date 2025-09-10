import type { DeclarativeTool } from '../base/index.js';
import type { ToolKind } from '../types/index.js';

/**
 * 工具发现服务
 * 负责自动发现和加载工具
 */
export class ToolDiscovery {
  private discoveredTools = new Map<string, DeclarativeTool>();
  private discoveryPaths: string[] = [];
  private enabledKinds = new Set<ToolKind>();

  constructor(config: ToolDiscoveryConfig = {}) {
    this.discoveryPaths = config.discoveryPaths || [];
    this.enabledKinds = new Set(config.enabledKinds || Object.values(ToolKind));
  }

  /**
   * 发现所有可用工具
   */
  async discoverAll(): Promise<DeclarativeTool[]> {
    const tools: DeclarativeTool[] = [];

    // 发现内置工具
    const builtinTools = await this.discoverBuiltinTools();
    tools.push(...builtinTools);

    // 发现路径中的工具
    for (const path of this.discoveryPaths) {
      const pathTools = await this.discoverFromPath(path);
      tools.push(...pathTools);
    }

    // 过滤启用的工具类型
    const filteredTools = tools.filter(tool => this.enabledKinds.has(tool.kind));

    // 缓存发现的工具
    for (const tool of filteredTools) {
      this.discoveredTools.set(tool.name, tool);
    }

    return filteredTools;
  }

  /**
   * 发现内置工具
   */
  async discoverBuiltinTools(): Promise<DeclarativeTool[]> {
    const tools: DeclarativeTool[] = [];

    try {
      // 动态导入内置工具模块
      const { getBuiltinTools } = await import('../builtin/index.js');
      const builtinTools = await getBuiltinTools();
      tools.push(...builtinTools);
    } catch (error) {
      console.warn('发现内置工具失败:', (error as Error).message);
    }

    return tools;
  }

  /**
   * 从指定路径发现工具
   */
  async discoverFromPath(path: string): Promise<DeclarativeTool[]> {
    const tools: DeclarativeTool[] = [];

    try {
      // 这里可以实现动态加载外部工具的逻辑
      // 目前暂时返回空数组
      console.log(`从路径发现工具: ${path} (暂未实现)`);
    } catch (error) {
      console.warn(`从路径 ${path} 发现工具失败:`, (error as Error).message);
    }

    return tools;
  }

  /**
   * 按类型发现工具
   */
  async discoverByKind(kind: ToolKind): Promise<DeclarativeTool[]> {
    const allTools = await this.discoverAll();
    return allTools.filter(tool => tool.kind === kind);
  }

  /**
   * 按分类发现工具
   */
  async discoverByCategory(category: string): Promise<DeclarativeTool[]> {
    const allTools = await this.discoverAll();
    return allTools.filter(tool => tool.category === category);
  }

  /**
   * 获取已发现的工具
   */
  getDiscoveredTools(): DeclarativeTool[] {
    return Array.from(this.discoveredTools.values());
  }

  /**
   * 重新发现工具
   */
  async rediscover(): Promise<DeclarativeTool[]> {
    this.discoveredTools.clear();
    return this.discoverAll();
  }

  /**
   * 添加发现路径
   */
  addDiscoveryPath(path: string): void {
    if (!this.discoveryPaths.includes(path)) {
      this.discoveryPaths.push(path);
    }
  }

  /**
   * 移除发现路径
   */
  removeDiscoveryPath(path: string): void {
    const index = this.discoveryPaths.indexOf(path);
    if (index > -1) {
      this.discoveryPaths.splice(index, 1);
    }
  }

  /**
   * 启用工具类型
   */
  enableKind(kind: ToolKind): void {
    this.enabledKinds.add(kind);
  }

  /**
   * 禁用工具类型
   */
  disableKind(kind: ToolKind): void {
    this.enabledKinds.delete(kind);
  }

  /**
   * 检查工具类型是否启用
   */
  isKindEnabled(kind: ToolKind): boolean {
    return this.enabledKinds.has(kind);
  }

  /**
   * 获取发现统计
   */
  getStats(): DiscoveryStats {
    const toolsByKind = new Map<ToolKind, number>();
    const toolsByCategory = new Map<string, number>();

    for (const tool of this.discoveredTools.values()) {
      // 按类型统计
      toolsByKind.set(tool.kind, (toolsByKind.get(tool.kind) || 0) + 1);

      // 按分类统计
      if (tool.category) {
        toolsByCategory.set(tool.category, (toolsByCategory.get(tool.category) || 0) + 1);
      }
    }

    return {
      totalDiscovered: this.discoveredTools.size,
      discoveryPaths: this.discoveryPaths.length,
      enabledKinds: this.enabledKinds.size,
      toolsByKind: Object.fromEntries(toolsByKind),
      toolsByCategory: Object.fromEntries(toolsByCategory),
    };
  }
}

/**
 * 工具发现配置
 */
export interface ToolDiscoveryConfig {
  discoveryPaths?: string[];
  enabledKinds?: ToolKind[];
  excludePatterns?: string[];
  includePatterns?: string[];
}

/**
 * 发现统计信息
 */
export interface DiscoveryStats {
  totalDiscovered: number;
  discoveryPaths: number;
  enabledKinds: number;
  toolsByKind: Record<string, number>;
  toolsByCategory: Record<string, number>;
}
