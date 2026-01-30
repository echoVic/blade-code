import { EventEmitter } from 'events';
import { PermissionMode } from '../../config/types.js';
import type { FunctionDeclaration, Tool } from '../types/index.js';

/**
 * 工具注册表
 * 管理内置工具和MCP工具的注册、发现和查询
 */
export class ToolRegistry extends EventEmitter {
  private tools = new Map<string, Tool>();
  private mcpTools = new Map<string, Tool>();
  private categories = new Map<string, Set<string>>();
  private tags = new Map<string, Set<string>>();

  constructor() {
    super();
  }

  /**
   * 注册内置工具
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 '${tool.name}' 已注册`);
    }

    this.tools.set(tool.name, tool);
    this.updateIndexes(tool);

    this.emit('toolRegistered', {
      type: 'builtin',
      tool,
      timestamp: Date.now(),
    });
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: Tool[]): void {
    const errors: string[] = [];

    for (const tool of tools) {
      try {
        this.register(tool);
      } catch (error) {
        errors.push(`${tool.name}: ${(error as Error).message}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`批量注册失败: ${errors.join(', ')}`);
    }
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) {
      return false;
    }

    this.tools.delete(name);
    this.removeFromIndexes(tool);

    this.emit('toolUnregistered', {
      type: 'builtin',
      toolName: name,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name) || this.mcpTools.get(name);
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name) || this.mcpTools.has(name);
  }

  /**
   * 获取所有工具
   */
  getAll(): Tool[] {
    return [...Array.from(this.tools.values()), ...Array.from(this.mcpTools.values())];
  }

  /**
   * 获取内置工具
   */
  getBuiltinTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取MCP工具
   */
  getMcpTools(): Tool[] {
    return Array.from(this.mcpTools.values());
  }

  /**
   * 按分类获取工具
   */
  getByCategory(category: string): Tool[] {
    const toolNames = this.categories.get(category);
    if (!toolNames) {
      return [];
    }

    return Array.from(toolNames)
      .map((name) => this.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }

  /**
   * 按标签获取工具
   */
  getByTag(tag: string): Tool[] {
    const toolNames = this.tags.get(tag);
    if (!toolNames) {
      return [];
    }

    return Array.from(toolNames)
      .map((name) => this.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }

  /**
   * 搜索工具
   */
  search(query: string): Tool[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter((tool) => {
      const desc =
        typeof tool.description === 'string'
          ? tool.description
          : tool.description.short;
      return (
        tool.name.toLowerCase().includes(lowerQuery) ||
        desc.toLowerCase().includes(lowerQuery) ||
        tool.displayName.toLowerCase().includes(lowerQuery) ||
        (tool.category && tool.category.toLowerCase().includes(lowerQuery)) ||
        tool.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))
      );
    });
  }

  /**
   * 获取函数声明（用于LLM）
   */
  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll().map((tool) => tool.getFunctionDeclaration());
  }

  /**
   * 获取只读工具的函数声明（用于 Plan 模式）
   * Plan 模式下只允许使用只读工具：Read, Glob, Grep, WebFetch, WebSearch, Task, EnterPlanMode, ExitPlanMode, TodoWrite
   */
  getReadOnlyFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll()
      .filter((tool) => tool.isReadOnly)
      .map((tool) => tool.getFunctionDeclaration());
  }

  /**
   * 根据权限模式获取函数声明（单一信息源）
   *
   * 工具暴露策略：
   * - PLAN 模式：仅暴露只读工具（防止 LLM 尝试调用被拒工具）
   * - DEFAULT/AUTO_EDIT/YOLO 模式：暴露全量工具（执行阶段由 PermissionStage 控制）
   *
   * 这确保了工具暴露策略和执行阶段权限检查使用相同的模式值，
   * 避免了 LLM 看到工具但执行被拒的循环问题。
   *
   * @param mode - 权限模式
   * @returns 对应模式下可用的函数声明列表
   */
  getFunctionDeclarationsByMode(mode?: PermissionMode): FunctionDeclaration[] {
    // Plan 模式：仅暴露只读工具
    if (mode === PermissionMode.PLAN) {
      return this.getReadOnlyFunctionDeclarations();
    }

    // Spec 模式：暴露只读工具 + Spec 专用工具
    // Spec 工具（EnterSpecMode, UpdateSpec, GetSpecContext, TransitionSpecPhase, ValidateSpec, ExitSpecMode）
    // 可以执行写操作但在 Spec 模式下自动批准
    if (mode === PermissionMode.SPEC) {
      return this.getSpecModeFunctionDeclarations();
    }

    // 其他模式（default/autoEdit/yolo）：暴露全量工具
    // 执行阶段由 PermissionStage 根据 permissionMode 进行细粒度控制
    return this.getFunctionDeclarations();
  }

  /**
   * Spec 模式专用工具列表
   */
  private static readonly SPEC_TOOLS = [
    'EnterSpecMode',
    'UpdateSpec',
    'GetSpecContext',
    'TransitionSpecPhase',
    'AddTask',
    'UpdateTaskStatus',
    'ValidateSpec',
    'ExitSpecMode',
  ];

  /**
   * 获取 Spec 模式可用工具
   *
   * Spec 模式暴露全量工具，因为：
   * 1. 实现阶段需要 Edit/Write/Bash 来写代码
   * 2. Spec 专用工具在 Spec 模式下自动批准
   * 3. 权限控制由执行阶段的 PermissionStage 处理
   */
  getSpecModeFunctionDeclarations(): FunctionDeclaration[] {
    // Spec 模式暴露全量工具
    return this.getFunctionDeclarations();
  }

  /**
   * 检查是否为 Spec 专用工具
   */
  isSpecTool(toolName: string): boolean {
    return ToolRegistry.SPEC_TOOLS.includes(toolName);
  }

  /**
   * 获取只读工具
   */
  getReadOnlyTools(): Tool[] {
    return this.getAll().filter((tool) => tool.isReadOnly);
  }

  /**
   * 获取所有分类
   */
  getCategories(): string[] {
    return Array.from(this.categories.keys());
  }

  /**
   * 获取所有标签
   */
  getTags(): string[] {
    return Array.from(this.tags.keys());
  }

  /**
   * 获取统计信息
   */
  getStats(): RegistryStats {
    return {
      totalTools: this.tools.size + this.mcpTools.size,
      builtinTools: this.tools.size,
      mcpTools: this.mcpTools.size,
      categories: this.categories.size,
      tags: this.tags.size,
      toolsByCategory: Object.fromEntries(
        Array.from(this.categories.entries()).map(([cat, tools]) => [cat, tools.size])
      ),
    };
  }

  /**
   * 注册MCP工具
   */
  registerMcpTool(tool: Tool): void {
    if (this.mcpTools.has(tool.name)) {
      // MCP工具可以覆盖（支持热更新）
      this.mcpTools.delete(tool.name);
    }

    this.mcpTools.set(tool.name, tool);
    this.updateIndexes(tool);

    this.emit('toolRegistered', {
      type: 'mcp',
      tool,
      timestamp: Date.now(),
    });
  }

  /**
   * 移除MCP工具（通过名称前缀匹配）
   */
  removeMcpTools(serverName: string): number {
    let removedCount = 0;
    const prefix = `mcp__${serverName}__`;

    for (const [name, tool] of this.mcpTools.entries()) {
      if (name.startsWith(prefix)) {
        this.mcpTools.delete(name);
        this.removeFromIndexes(tool);
        removedCount++;

        this.emit('toolUnregistered', {
          type: 'mcp',
          toolName: name,
          serverName,
          timestamp: Date.now(),
        });
      }
    }

    return removedCount;
  }

  /**
   * 更新索引
   */
  private updateIndexes(tool: Tool): void {
    // 更新分类索引
    if (tool.category) {
      if (!this.categories.has(tool.category)) {
        this.categories.set(tool.category, new Set());
      }
      this.categories.get(tool.category)!.add(tool.name);
    }

    // 更新标签索引
    for (const tag of tool.tags) {
      if (!this.tags.has(tag)) {
        this.tags.set(tag, new Set());
      }
      this.tags.get(tag)!.add(tool.name);
    }
  }

  /**
   * 从索引中移除
   */
  private removeFromIndexes(tool: Tool): void {
    // 从分类索引移除
    if (tool.category) {
      const categorySet = this.categories.get(tool.category);
      if (categorySet) {
        categorySet.delete(tool.name);
        if (categorySet.size === 0) {
          this.categories.delete(tool.category);
        }
      }
    }

    // 从标签索引移除
    for (const tag of tool.tags) {
      const tagSet = this.tags.get(tag);
      if (tagSet) {
        tagSet.delete(tool.name);
        if (tagSet.size === 0) {
          this.tags.delete(tag);
        }
      }
    }
  }
}

/**
 * 注册表统计信息
 */
export interface RegistryStats {
  totalTools: number;
  builtinTools: number;
  mcpTools: number;
  categories: number;
  tags: number;
  toolsByCategory: Record<string, number>;
}
