/**
 * 自定义命令注册表
 *
 * 管理所有自定义命令的发现、注册和执行
 * 单例模式
 */

import type { PluginCommand } from '../../plugins/types.js';
import { CustomCommandExecutor } from './CustomCommandExecutor.js';
import { CustomCommandLoader } from './CustomCommandLoader.js';
import type {
  CustomCommand,
  CustomCommandDiscoveryResult,
  CustomCommandExecutionContext,
} from './types.js';

export class CustomCommandRegistry {
  private static instance: CustomCommandRegistry;

  private commands: Map<string, CustomCommand> = new Map();
  /** Plugin commands stored separately with namespaced names */
  private pluginCommands: Map<string, PluginCommand> = new Map();
  private loader = new CustomCommandLoader();
  private executor = new CustomCommandExecutor();
  private initialized = false;
  private workspaceRoot = '';
  private lastDiscoveryResult: CustomCommandDiscoveryResult | null = null;

  /**
   * 获取单例实例
   */
  static getInstance(): CustomCommandRegistry {
    if (!CustomCommandRegistry.instance) {
      CustomCommandRegistry.instance = new CustomCommandRegistry();
    }
    return CustomCommandRegistry.instance;
  }

  /**
   * 重置实例（用于测试）
   */
  static resetInstance(): void {
    CustomCommandRegistry.instance = new CustomCommandRegistry();
  }

  private constructor() {
    // 私有构造函数，确保单例
  }

  /**
   * 初始化：发现并注册所有自定义命令
   *
   * @param workspaceRoot - 工作目录路径
   */
  async initialize(workspaceRoot: string): Promise<CustomCommandDiscoveryResult> {
    this.workspaceRoot = workspaceRoot;

    const result = await this.loader.discover(workspaceRoot);
    this.lastDiscoveryResult = result;

    // 清空现有命令
    this.commands.clear();

    // 按顺序注册（后面的覆盖前面的同名命令）
    for (const cmd of result.commands) {
      this.commands.set(cmd.name, cmd);
    }

    this.initialized = true;
    return result;
  }

  /**
   * 刷新命令列表
   */
  async refresh(): Promise<CustomCommandDiscoveryResult> {
    if (!this.workspaceRoot) {
      throw new Error('Registry not initialized. Call initialize() first.');
    }
    return this.initialize(this.workspaceRoot);
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取命令
   */
  getCommand(name: string): CustomCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * 检查命令是否存在
   */
  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  /**
   * 获取所有命令
   */
  getAllCommands(): CustomCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * 获取命令数量
   */
  getCommandCount(): number {
    return this.commands.size;
  }

  /**
   * 获取可被 SlashCommand 工具调用的命令
   *
   * 条件:
   * - 必须有 description
   * - 不能设置 disable-model-invocation: true
   */
  getModelInvocableCommands(): CustomCommand[] {
    return this.getAllCommands().filter(
      (cmd) => cmd.config.description && !cmd.config.disableModelInvocation
    );
  }

  /**
   * 执行命令
   *
   * @param name - 命令名
   * @param context - 执行上下文
   * @returns 处理后的命令内容，或 null（命令不存在）
   */
  async executeCommand(
    name: string,
    context: CustomCommandExecutionContext
  ): Promise<string | null> {
    const cmd = this.getCommand(name);
    if (!cmd) {
      return null;
    }

    return this.executor.execute(cmd, context);
  }

  /**
   * 获取命令的显示标签
   *
   * 格式:
   * - 项目命令: "(project)" 或 "(project:namespace)"
   * - 用户命令: "(user)" 或 "(user:namespace)"
   */
  getCommandLabel(cmd: CustomCommand): string {
    const base = cmd.source === 'project' ? 'project' : 'user';
    if (cmd.namespace) {
      return `(${base}:${cmd.namespace})`;
    }
    return `(${base})`;
  }

  /**
   * 获取命令的完整显示名称
   *
   * 格式: /name [argument-hint] - description (label)
   */
  getCommandDisplayName(cmd: CustomCommand): string {
    const parts: string[] = [`/${cmd.name}`];

    if (cmd.config.argumentHint) {
      parts.push(cmd.config.argumentHint);
    }

    if (cmd.config.description) {
      parts.push('-', cmd.config.description);
    }

    parts.push(this.getCommandLabel(cmd));

    return parts.join(' ');
  }

  /**
   * 按来源分组获取命令
   */
  getCommandsBySource(): {
    project: CustomCommand[];
    user: CustomCommand[];
  } {
    const project: CustomCommand[] = [];
    const user: CustomCommand[] = [];

    for (const cmd of this.commands.values()) {
      if (cmd.source === 'project') {
        project.push(cmd);
      } else {
        user.push(cmd);
      }
    }

    return { project, user };
  }

  /**
   * 获取最近一次发现结果
   */
  getLastDiscoveryResult(): CustomCommandDiscoveryResult | null {
    return this.lastDiscoveryResult;
  }

  /**
   * 获取命令目录信息
   */
  getCommandDirs(): {
    projectBlade: string;
    projectClaude: string;
    userBlade: string;
    userClaude: string;
  } | null {
    if (!this.workspaceRoot) {
      return null;
    }
    return this.loader.getCommandDirs(this.workspaceRoot);
  }

  /**
   * 生成命令列表的描述文本（用于 SlashCommand 工具）
   *
   * @param charBudget - 字符预算
   * @returns { text: string; includedCount: number; totalCount: number }
   */
  generateCommandListDescription(charBudget = 15000): {
    text: string;
    includedCount: number;
    totalCount: number;
  } {
    const commands = this.getModelInvocableCommands();
    const totalCount = commands.length;

    if (totalCount === 0) {
      return {
        text: 'No custom commands available.',
        includedCount: 0,
        totalCount: 0,
      };
    }

    let text = 'Available custom commands:\n\n';
    let charCount = text.length;
    let includedCount = 0;

    for (const cmd of commands) {
      const label = this.getCommandLabel(cmd);
      const argHint = cmd.config.argumentHint ? ` ${cmd.config.argumentHint}` : '';
      const line = `- /${cmd.name}${argHint}: ${cmd.config.description} ${label}\n`;

      if (charCount + line.length > charBudget) {
        break;
      }

      text += line;
      charCount += line.length;
      includedCount++;
    }

    if (includedCount < totalCount) {
      text += `\n(${includedCount} of ${totalCount} commands shown due to character budget)`;
    }

    return { text, includedCount, totalCount };
  }

  // ============================================================
  // Plugin Command Methods
  // ============================================================

  /**
   * 注册插件命令
   *
   * Plugin commands are stored with their namespaced names (e.g., "plugin:command")
   * to prevent conflicts with other plugins or standalone commands.
   *
   * @param cmd - Plugin command to register
   */
  registerPluginCommand(cmd: PluginCommand): void {
    this.pluginCommands.set(cmd.namespacedName, cmd);
  }

  /**
   * 查找插件命令
   *
   * Supports both:
   * - Full namespaced name: "plugin:command"
   * - Short name if unique: "command"
   *
   * @param name - Command name to find
   * @returns Plugin command or undefined
   */
  findPluginCommand(name: string): PluginCommand | undefined {
    // Try exact namespaced match first
    const exact = this.pluginCommands.get(name);
    if (exact) return exact;

    // Try short name match (if unique)
    const matches: PluginCommand[] = [];
    for (const cmd of this.pluginCommands.values()) {
      if (cmd.originalName === name) {
        matches.push(cmd);
      }
    }

    // Only return if exactly one match
    if (matches.length === 1) {
      return matches[0];
    }

    return undefined;
  }

  /**
   * 检查插件命令是否存在
   */
  hasPluginCommand(name: string): boolean {
    return this.findPluginCommand(name) !== undefined;
  }

  /**
   * 获取所有插件命令
   */
  getAllPluginCommands(): PluginCommand[] {
    return Array.from(this.pluginCommands.values());
  }

  /**
   * 执行插件命令
   *
   * @param name - Command name (namespaced or short)
   * @param context - Execution context
   * @returns Processed command content, or null if not found
   */
  async executePluginCommand(
    name: string,
    context: CustomCommandExecutionContext
  ): Promise<string | null> {
    const cmd = this.findPluginCommand(name);
    if (!cmd) return null;

    // Convert PluginCommand to CustomCommand format for executor
    const customCmd: CustomCommand = {
      name: cmd.namespacedName,
      config: cmd.config,
      content: cmd.content,
      path: cmd.path,
      source: 'project', // Plugin commands are treated as project-level
      sourceDir: 'blade',
    };

    return this.executor.execute(customCmd, context);
  }

  /**
   * 清除所有插件命令
   * Called when refreshing plugins
   */
  clearPluginCommands(): void {
    this.pluginCommands.clear();
  }

  /**
   * 获取插件命令数量
   */
  getPluginCommandCount(): number {
    return this.pluginCommands.size;
  }

  /**
   * 检查命令名是否有多个插件提供（冲突）
   */
  hasPluginCommandConflict(shortName: string): boolean {
    let count = 0;
    for (const cmd of this.pluginCommands.values()) {
      if (cmd.originalName === shortName) {
        count++;
        if (count > 1) return true;
      }
    }
    return false;
  }

  /**
   * 获取提供指定命令的所有插件名称
   */
  getPluginCommandProviders(shortName: string): string[] {
    const providers: string[] = [];
    for (const cmd of this.pluginCommands.values()) {
      if (cmd.originalName === shortName) {
        providers.push(cmd.pluginName);
      }
    }
    return providers;
  }
}
