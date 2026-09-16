import { EventEmitter } from 'events';
import { PermissionMode } from '../../config/types.js';
import { createMcpProviderServerPrefix } from '../../mcp/McpToolCatalog.js';
import type { FunctionDeclaration, Tool } from '../types/index.js';
import { isReadOnlyKind } from '../types/ToolTypes.js';
import { DeferredToolManager } from './DeferredToolManager.js';

export interface McpCatalogProjectionChange {
  revision: number;
  serverName: string;
  reason: string;
  added: string[];
  removed: string[];
  updated: string[];
}

export interface McpContentProjectionChange {
  revision: number;
  serverName: string;
  kind: 'resources' | 'resourceTemplates' | 'prompts';
  reason: string;
  added: string[];
  removed: string[];
  updated: string[];
}

export interface McpResourceUpdatedProjection {
  revision: number;
  serverName: string;
  uri: string;
}

export interface McpConnectionProjectionChange {
  revision: number;
  serverName: string;
  phase: 'reconnecting' | 'recovered' | 'failed';
  reason: string;
  attempt: number;
  maxAttempts: number;
  nextRetryAt?: number;
  error?: string;
}

export interface McpLogProjection {
  revision: number;
  serverName: string;
  level:
    | 'debug'
    | 'info'
    | 'notice'
    | 'warning'
    | 'error'
    | 'critical'
    | 'alert'
    | 'emergency';
  logger?: string;
  message: string;
  projectedBytes: number;
  dataSha256: string;
  truncated: boolean;
  detailsOmitted: boolean;
  timestamp: number;
  synthetic?: boolean;
}

export interface McpInstructionProjection {
  serverName: string;
  text?: string;
  sourceBytes: number;
  projectedBytes: number;
  sha256: string;
  truncated: boolean;
  detailsOmitted: boolean;
}

export interface McpInstructionsProjectionChange {
  revision: number;
  reason: 'snapshot' | 'connection' | 'disconnection';
  replace: boolean;
  instructions: McpInstructionProjection[];
  removed: string[];
}

export interface McpTaskProjectionChange {
  revision: number;
  taskId: string;
  serverName: string;
  toolName: string;
  status:
    | 'working'
    | 'input_required'
    | 'interrupted'
    | 'completed'
    | 'failed'
    | 'cancelled';
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  hasResult: boolean;
  error?: string;
}

/**
 * 工具注册表
 * 管理内置工具和MCP工具的注册、发现和查询
 */
export class ToolRegistry extends EventEmitter {
  private tools = new Map<string, Tool>();
  private mcpTools = new Map<string, Tool>();
  private _deferredManager = new DeferredToolManager();
  private pendingMcpCatalogChanges: McpCatalogProjectionChange[] = [];
  private pendingMcpContentChanges: McpContentProjectionChange[] = [];
  private pendingMcpResourceUpdates: McpResourceUpdatedProjection[] = [];
  private pendingMcpConnectionChanges: McpConnectionProjectionChange[] = [];
  private pendingMcpLogs: McpLogProjection[] = [];
  private pendingMcpInstructionChanges: McpInstructionsProjectionChange[] = [];
  private pendingMcpTaskChanges: McpTaskProjectionChange[] = [];
  private mcpCatalogBarrier: () => Promise<void> = async () => undefined;

  constructor() {
    super();
  }

  /**
   * 获取延迟加载管理器
   */
  get deferredToolManager(): DeferredToolManager {
    return this._deferredManager;
  }

  setMcpCatalogBarrier(barrier: () => Promise<void>): void {
    this.mcpCatalogBarrier = barrier;
  }

  async waitForMcpCatalogIdle(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('MCP catalog wait aborted', 'AbortError');
    }
    const barrier = this.mcpCatalogBarrier();
    if (!signal) return barrier;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('MCP catalog wait aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void barrier.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  /**
   * 注册内置工具
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 '${tool.name}' 已注册`);
    }

    this.tools.set(tool.name, tool);
    this._deferredManager.register(tool.name);

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
    const tool = this.tools.get(name) ?? this.mcpTools.get(name);
    if (!tool) {
      return false;
    }

    const type = this.tools.delete(name) ? 'builtin' : 'mcp';
    this.mcpTools.delete(name);
    this._deferredManager.unregister(name);

    this.emit('toolUnregistered', {
      type,
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
   * 获取只读工具的函数声明（用于 Plan 模式）
   * Plan 模式下只允许使用只读工具：Read, Glob, Grep, WebFetch, WebSearch, Task, TaskCreate/TaskGet/TaskUpdate/TaskList, EnterPlanMode, ExitPlanMode
   */
  getReadOnlyFunctionDeclarations(): FunctionDeclaration[] {
    return this._deferredManager.filterDeclarations(this.getReadOnlyTools());
  }

  /**
   * 根据权限模式获取函数声明（单一信息源）
   *
   * 工具暴露策略：
   * - PLAN 模式：仅暴露只读工具（防止 LLM 尝试调用被拒工具）
   * - DEFAULT/AUTO_EDIT/YOLO 模式：暴露全量工具（由 ToolExecutor 控制执行权限）
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

    // 其他模式（default/autoEdit/yolo）：使用 DeferredToolManager 过滤
    // 已加载的工具返回完整 schema，deferred 工具通过系统提示列出名称
    return this._deferredManager.filterDeclarations(this.getAll(), mode);
  }

  /**
   * 获取只读工具
   */
  getReadOnlyTools(): Tool[] {
    return this.getAll().filter((tool) => isReadOnlyKind(tool.kind));
  }

  /**
   * 获取 deferred tools 的系统提示列表
   */
  getDeferredToolsListing(): string {
    if (!this.get('ToolSearch')) return '';
    return this._deferredManager.getDeferredToolsListing();
  }

  /**
   * 注册MCP工具
   */
  registerMcpTool(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`MCP 工具 '${tool.name}' 与内置工具冲突`);
    }
    if (this.mcpTools.has(tool.name)) {
      this.mcpTools.delete(tool.name);
    }

    this.mcpTools.set(tool.name, tool);
    this._deferredManager.register(tool.name);

    this.emit('toolRegistered', {
      type: 'mcp',
      tool,
      timestamp: Date.now(),
    });
  }

  replaceMcpTools(tools: readonly Tool[], change?: McpCatalogProjectionChange): void {
    const next = new Map<string, Tool>();
    for (const tool of tools) {
      if (next.has(tool.name)) {
        throw new Error(`MCP catalog contains duplicate tool '${tool.name}'`);
      }
      if (this.tools.has(tool.name)) {
        throw new Error(`MCP tool '${tool.name}' conflicts with a builtin tool`);
      }
      next.set(tool.name, tool);
    }

    const previousNames = [...this.mcpTools.keys()];
    this.mcpTools = next;
    this._deferredManager.syncDynamicTools(previousNames, [...next.keys()]);

    if (change) {
      this.pendingMcpCatalogChanges.push(structuredClone(change));
      if (this.pendingMcpCatalogChanges.length > 32) {
        this.pendingMcpCatalogChanges.shift();
      }
    }
    this.emit('mcpCatalogReplaced', {
      toolCount: next.size,
      change,
      timestamp: Date.now(),
    });
  }

  drainMcpCatalogChanges(): McpCatalogProjectionChange[] {
    const changes = this.pendingMcpCatalogChanges;
    this.pendingMcpCatalogChanges = [];
    return changes;
  }

  queueMcpContentChange(change: McpContentProjectionChange): void {
    this.pendingMcpContentChanges.push(structuredClone(change));
    if (this.pendingMcpContentChanges.length > 32) {
      this.pendingMcpContentChanges.shift();
    }
  }

  drainMcpContentChanges(): McpContentProjectionChange[] {
    const changes = this.pendingMcpContentChanges;
    this.pendingMcpContentChanges = [];
    return changes;
  }

  queueMcpResourceUpdated(update: McpResourceUpdatedProjection): void {
    const duplicate = this.pendingMcpResourceUpdates.some(
      (current) =>
        current.serverName === update.serverName && current.uri === update.uri
    );
    if (!duplicate) this.pendingMcpResourceUpdates.push(structuredClone(update));
    if (this.pendingMcpResourceUpdates.length > 32) {
      this.pendingMcpResourceUpdates.shift();
    }
  }

  drainMcpResourceUpdates(): McpResourceUpdatedProjection[] {
    const updates = this.pendingMcpResourceUpdates;
    this.pendingMcpResourceUpdates = [];
    return updates;
  }

  queueMcpConnectionChange(change: McpConnectionProjectionChange): void {
    this.pendingMcpConnectionChanges.push(structuredClone(change));
    if (this.pendingMcpConnectionChanges.length > 32) {
      this.pendingMcpConnectionChanges.shift();
    }
  }

  drainMcpConnectionChanges(): McpConnectionProjectionChange[] {
    const changes = this.pendingMcpConnectionChanges;
    this.pendingMcpConnectionChanges = [];
    return changes;
  }

  queueMcpLog(entry: McpLogProjection): void {
    this.pendingMcpLogs.push(structuredClone(entry));
    if (this.pendingMcpLogs.length > 64) {
      this.pendingMcpLogs.shift();
    }
  }

  drainMcpLogs(): McpLogProjection[] {
    const entries = this.pendingMcpLogs;
    this.pendingMcpLogs = [];
    return entries;
  }

  queueMcpInstructionsChange(change: McpInstructionsProjectionChange): void {
    this.pendingMcpInstructionChanges.push(structuredClone(change));
    if (this.pendingMcpInstructionChanges.length > 32) {
      this.pendingMcpInstructionChanges.shift();
    }
  }

  drainMcpInstructionsChanges(): McpInstructionsProjectionChange[] {
    const changes = this.pendingMcpInstructionChanges;
    this.pendingMcpInstructionChanges = [];
    return changes;
  }

  queueMcpTaskChange(change: McpTaskProjectionChange): void {
    this.pendingMcpTaskChanges.push(structuredClone(change));
    if (this.pendingMcpTaskChanges.length > 64) {
      this.pendingMcpTaskChanges.shift();
    }
  }

  drainMcpTaskChanges(): McpTaskProjectionChange[] {
    const changes = this.pendingMcpTaskChanges;
    this.pendingMcpTaskChanges = [];
    return changes;
  }

  /**
   * 移除MCP工具（通过名称前缀匹配）
   */
  removeMcpTools(serverName: string): number {
    let removedCount = 0;
    const prefix = createMcpProviderServerPrefix(serverName);

    for (const name of this.mcpTools.keys()) {
      if (name.startsWith(prefix)) {
        this.mcpTools.delete(name);
        this._deferredManager.unregister(name);
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
}
