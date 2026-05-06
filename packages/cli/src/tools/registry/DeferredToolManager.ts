/**
 * DeferredToolManager — 工具延迟加载管理器
 *
 * 渐进式披露（Progressive Disclosure）：
 * - 核心工具立即加载完整 schema
 * - 非核心工具仅在系统提示中列出名称
 * - AI 通过 ToolSearch 按需加载完整 schema
 */

import type { PermissionMode } from '../../config/types.js';
import type { FunctionDeclaration, Tool } from '../types/index.js';

/** 始终立即加载的核心工具 */
const ALWAYS_LOADED_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash',
  'Task',
  'TaskOutput',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'AskUserQuestion',
  'Skill',
  'SlashCommand',
  'ToolSearch', // ToolSearch 自身必须立即加载
  'EnterPlanMode',
  'ExitPlanMode',
]);

export class DeferredToolManager {
  /** 已加载完整 schema 的工具 */
  private loadedTools = new Set<string>(ALWAYS_LOADED_TOOLS);

  /** 被标记为 deferred 的工具名称 */
  private deferredTools = new Set<string>();

  /**
   * 注册一个工具的延迟加载状态
   * 如果工具名在 ALWAYS_LOADED_TOOLS 中，自动标记为 loaded
   */
  register(toolName: string): void {
    if (ALWAYS_LOADED_TOOLS.has(toolName)) {
      this.loadedTools.add(toolName);
    } else {
      this.deferredTools.add(toolName);
    }
  }

  /**
   * 标记工具为已加载（ToolSearch 调用后）
   */
  markLoaded(toolName: string): void {
    this.loadedTools.add(toolName);
    this.deferredTools.delete(toolName);
  }

  /**
   * 检查工具是否已加载
   */
  isLoaded(toolName: string): boolean {
    return this.loadedTools.has(toolName);
  }

  /**
   * 获取用于 LLM 的函数声明
   * - loaded 工具：返回完整 schema
   * - deferred 工具：不返回（通过系统提示单独列出名称）
   */
  filterDeclarations(
    allTools: Tool[],
    _mode?: PermissionMode,
  ): FunctionDeclaration[] {
    return allTools
      .filter((tool) => this.isLoaded(tool.name))
      .map((tool) => tool.getFunctionDeclaration());
  }

  /**
   * 生成 deferred 工具的名称列表
   */
  getDeferredToolNames(): string[] {
    return Array.from(this.deferredTools);
  }

  /**
   * 生成 <available-deferred-tools> 标签内容
   */
  getDeferredToolsListing(): string {
    const names = this.getDeferredToolNames();
    if (names.length === 0) return '';
    return [
      '<available-deferred-tools>',
      ...names,
      '</available-deferred-tools>',
    ].join('\n');
  }

  /** 重置（用于测试） */
  reset(): void {
    this.loadedTools = new Set(ALWAYS_LOADED_TOOLS);
    this.deferredTools.clear();
  }
}
