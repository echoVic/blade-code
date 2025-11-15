/**
 * Blade Subagent System - Registry
 *
 * 管理 Subagent 的注册、查找和加载
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SubagentDefinition } from './types.js';
import { SubagentConfigParser } from './parser.js';

/**
 * Subagent 注册表
 *
 * 单例模式，管理所有可用的 subagent
 */
export class SubagentRegistry {
  private static instance: SubagentRegistry | null = null;

  /** 已注册的 subagents (name -> definition) */
  private agents = new Map<string, SubagentDefinition>();

  /** 配置解析器 */
  private parser = new SubagentConfigParser();

  /** 是否已初始化 */
  private initialized = false;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): SubagentRegistry {
    if (!SubagentRegistry.instance) {
      SubagentRegistry.instance = new SubagentRegistry();
    }
    return SubagentRegistry.instance;
  }

  /**
   * 重置实例（主要用于测试）
   */
  static reset(): void {
    SubagentRegistry.instance = null;
  }

  /**
   * 初始化注册表
   *
   * 按优先级加载 subagents:
   * 1. 内置 subagents (src/agents/builtin/)
   * 2. 用户级 subagents (~/.blade/agents/)
   * 3. 项目级 subagents (.blade/agents/)
   *
   * 后加载的会覆盖先加载的（项目级优先级最高）
   *
   * @param options.cwd 项目根目录（默认为 process.cwd()）
   * @param options.userDir 用户配置目录（默认为 ~/.blade/）
   */
  async initialize(options: {
    cwd?: string;
    userDir?: string;
  } = {}): Promise<void> {
    if (this.initialized) {
      return;
    }

    const cwd = options.cwd || process.cwd();
    const userDir = options.userDir || path.join(os.homedir(), '.blade');

    // 1. 加载内置 subagents
    this.loadBuiltInAgents();

    // 2. 加载用户级 subagents
    const userAgentsDir = path.join(userDir, 'agents');
    await this.loadFromDirectory(userAgentsDir, 'user');

    // 3. 加载项目级 subagents（优先级最高）
    const projectAgentsDir = path.join(cwd, '.blade', 'agents');
    await this.loadFromDirectory(projectAgentsDir, 'project');

    this.initialized = true;

    console.log(`Loaded ${this.agents.size} subagent(s)`);
  }

  /**
   * 加载内置 subagents
   */
  private loadBuiltInAgents(): void {
    // 获取 builtin 目录的绝对路径
    // 注意: 在打包后，__dirname 可能指向 dist 目录
    const builtInDir = path.join(__dirname, 'builtin');

    this.loadFromDirectorySync(builtInDir, 'builtin');
  }

  /**
   * 从目录加载 subagents（同步）
   */
  private loadFromDirectorySync(dirPath: string, source: string): void {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    try {
      const definitions = this.parser.parseDirectory(dirPath);

      for (const definition of definitions) {
        // 覆盖已有的定义（优先级处理）
        this.agents.set(definition.name, definition);
      }

      if (definitions.length > 0) {
        console.log(`Loaded ${definitions.length} ${source} subagent(s) from ${dirPath}`);
      }
    } catch (error) {
      console.warn(`Failed to load subagents from ${dirPath}:`, (error as Error).message);
    }
  }

  /**
   * 从目录加载 subagents（异步）
   */
  private async loadFromDirectory(dirPath: string, source: string): Promise<void> {
    // 当前实现为同步，未来可以改为异步
    this.loadFromDirectorySync(dirPath, source);
  }

  /**
   * 手动注册一个 subagent
   *
   * @param definition Subagent 定义
   * @param overwrite 是否覆盖已有的定义（默认 false）
   * @throws Error 如果 name 已存在且 overwrite 为 false
   */
  register(definition: SubagentDefinition, overwrite = false): void {
    if (!overwrite && this.agents.has(definition.name)) {
      throw new Error(`Subagent '${definition.name}' is already registered`);
    }

    this.agents.set(definition.name, definition);
  }

  /**
   * 注销一个 subagent
   *
   * @param name Subagent 名称
   * @returns 是否成功注销
   */
  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  /**
   * 获取 subagent 定义
   *
   * @param name Subagent 名称
   * @returns SubagentDefinition 或 undefined
   */
  get(name: string): SubagentDefinition | undefined {
    return this.agents.get(name);
  }

  /**
   * 检查 subagent 是否存在
   *
   * @param name Subagent 名称
   */
  has(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * 列出所有 subagents
   *
   * @returns SubagentDefinition 数组
   */
  list(): SubagentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * 列出所有 subagent 名称
   *
   * @returns 名称数组
   */
  listNames(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * 获取 subagent 数量
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * 清空所有 subagents（主要用于测试）
   */
  clear(): void {
    this.agents.clear();
    this.initialized = false;
  }

  /**
   * 搜索 subagents
   *
   * @param query 搜索关键词（匹配 name 或 description）
   * @returns 匹配的 SubagentDefinition 数组
   */
  search(query: string): SubagentDefinition[] {
    const lowerQuery = query.toLowerCase();

    return this.list().filter((agent) => {
      return (
        agent.name.toLowerCase().includes(lowerQuery) ||
        agent.description.toLowerCase().includes(lowerQuery)
      );
    });
  }

  /**
   * 按工具筛选 subagents
   *
   * @param toolName 工具名称
   * @returns 使用该工具的 SubagentDefinition 数组
   */
  filterByTool(toolName: string): SubagentDefinition[] {
    return this.list().filter((agent) => {
      // undefined tools 表示继承所有工具
      if (!agent.tools) {
        return true;
      }

      return agent.tools.includes(toolName);
    });
  }

  /**
   * 按模型筛选 subagents
   *
   * @param model 模型名称
   * @returns 使用该模型的 SubagentDefinition 数组
   */
  filterByModel(model: 'haiku' | 'sonnet' | 'opus'): SubagentDefinition[] {
    return this.list().filter((agent) => {
      return agent.model === model || (!agent.model && model === 'sonnet');
    });
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byModel: Record<string, number>;
    byToolCount: Record<string, number>;
  } {
    const stats = {
      total: this.agents.size,
      byModel: {} as Record<string, number>,
      byToolCount: {} as Record<string, number>,
    };

    for (const agent of this.agents.values()) {
      // 按模型统计
      const model = agent.model || 'sonnet';
      stats.byModel[model] = (stats.byModel[model] || 0) + 1;

      // 按工具数量统计
      const toolCount = agent.tools ? agent.tools.length : 'all';
      const key = String(toolCount);
      stats.byToolCount[key] = (stats.byToolCount[key] || 0) + 1;
    }

    return stats;
  }
}

/**
 * 获取全局注册表实例
 */
export function getRegistry(): SubagentRegistry {
  return SubagentRegistry.getInstance();
}

/**
 * 初始化全局注册表
 */
export async function initializeRegistry(options?: {
  cwd?: string;
  userDir?: string;
}): Promise<SubagentRegistry> {
  const registry = SubagentRegistry.getInstance();
  await registry.initialize(options);
  return registry;
}
