/**
 * Hook Manager
 *
 * 管理 Hook 配置和执行
 */

import { nanoid } from 'nanoid';
import {
  HookEvent,
  type HookConfig,
  type HookInput,
  type HookExecutionContext,
  type PreToolHookResult,
  type PostToolHookResult,
  type MatchContext,
  type Hook,
  type PreToolUseInput,
  type PostToolUseInput,
} from './types/HookTypes.js';
import type { PermissionMode } from '../config/types.js';
import { DEFAULT_HOOK_CONFIG, mergeHookConfig, parseEnvConfig } from './HookConfig.js';
import { HookExecutor } from './HookExecutor.js';
import { HookExecutionGuard } from './HookExecutionGuard.js';
import { Matcher } from './Matcher.js';

/**
 * Hook Manager
 *
 * 单例模式,管理整个应用的 Hook 系统
 */
export class HookManager {
  private static instance: HookManager | null = null;

  private config: HookConfig = DEFAULT_HOOK_CONFIG;
  private executor = new HookExecutor();
  private guard = new HookExecutionGuard();
  private matcher = new Matcher();
  private sessionDisabled = false;

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): HookManager {
    if (!HookManager.instance) {
      HookManager.instance = new HookManager();
    }
    return HookManager.instance;
  }

  /**
   * 加载配置
   */
  loadConfig(config: Partial<HookConfig>): void {
    // 合并配置: 默认 -> 用户配置 -> 环境变量
    let merged = mergeHookConfig(DEFAULT_HOOK_CONFIG, config);
    const envConfig = parseEnvConfig();
    merged = mergeHookConfig(merged, envConfig);

    this.config = merged;
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    // 1. 全局配置开关
    if (!this.config.enabled) {
      return false;
    }

    // 2. 会话级禁用
    if (this.sessionDisabled) {
      return false;
    }

    return true;
  }

  /**
   * 运行时禁用 (当前会话)
   */
  disable(): void {
    this.sessionDisabled = true;
    console.log('[HookManager] Hooks disabled for this session');
  }

  /**
   * 运行时启用 (当前会话)
   */
  enable(): void {
    this.sessionDisabled = false;
    console.log('[HookManager] Hooks enabled for this session');
  }

  /**
   * 执行 PreToolUse Hooks
   */
  async executePreToolHooks(
    toolName: string,
    toolUseId: string,
    toolInput: Record<string, unknown>,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<PreToolHookResult> {
    if (!this.isEnabled()) {
      return { decision: 'allow' };
    }

    // Plan 模式跳过 hooks
    if (context.permissionMode === 'plan') {
      return { decision: 'allow' };
    }

    // 检查是否已执行
    if (!this.guard.canExecute(toolUseId, HookEvent.PreToolUse)) {
      return { decision: 'allow' };
    }

    // 构建 Hook 输入
    const hookInput: PreToolUseInput = {
      hook_event_name: HookEvent.PreToolUse,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取匹配的 hooks
    const hooks = this.getMatchingHooks(HookEvent.PreToolUse, {
      toolName,
      filePath: this.extractFilePath(toolInput),
      command: this.extractCommand(toolName, toolInput),
    });

    if (hooks.length === 0) {
      return { decision: 'allow' };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    // 执行 hooks
    try {
      const result = await this.executor.executePreToolHooks(
        hooks,
        hookInput,
        execContext
      );

      // 标记已执行
      this.guard.markExecuted(toolUseId, HookEvent.PreToolUse);

      // YOLO 模式：保留 deny 和所有修改，但将 ask 转为 allow
      if (context.permissionMode === 'yolo') {
        if (result.decision === 'deny') {
          // 保留 deny 决策和所有其他字段
          return result;
        }
        // 将 ask 转为 allow，但保留 modifiedInput 和 warning
        return {
          decision: 'allow',
          modifiedInput: result.modifiedInput,
          warning: result.warning,
          reason: result.reason,
        };
      }

      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PreToolUse hooks:', err);
      return {
        decision: 'allow',
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PostToolUse Hooks
   */
  async executePostToolHooks(
    toolName: string,
    toolUseId: string,
    toolInput: Record<string, unknown>,
    toolResponse: unknown,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<PostToolHookResult> {
    if (!this.isEnabled()) {
      return {};
    }

    // Plan 模式跳过 hooks
    if (context.permissionMode === 'plan') {
      return {};
    }

    // 检查是否已执行
    if (!this.guard.canExecute(toolUseId, HookEvent.PostToolUse)) {
      return {};
    }

    // 构建 Hook 输入
    const hookInput: PostToolUseInput = {
      hook_event_name: HookEvent.PostToolUse,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      tool_response: toolResponse,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取匹配的 hooks
    const hooks = this.getMatchingHooks(HookEvent.PostToolUse, {
      toolName,
      filePath: this.extractFilePath(toolInput),
      command: this.extractCommand(toolName, toolInput),
    });

    if (hooks.length === 0) {
      return {};
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config: this.config,
      abortSignal: context.abortSignal,
    };

    // 执行 hooks
    try {
      const result = await this.executor.executePostToolHooks(
        hooks,
        hookInput,
        execContext
      );

      // 标记已执行
      this.guard.markExecuted(toolUseId, HookEvent.PostToolUse);

      return result;
    } catch (err) {
      console.error('[HookManager] Error executing PostToolUse hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      // 清理完成的工具
      this.guard.cleanup(toolUseId);
    }
  }

  /**
   * 获取匹配的 Hooks
   */
  private getMatchingHooks(
    event: HookEvent,
    context: MatchContext
  ): Hook[] {
    const matchers = this.config[event] || [];

    const matchedHooks: Hook[] = [];

    for (const matcher of matchers) {
      if (this.matcher.matches(matcher.matcher, context)) {
        matchedHooks.push(...matcher.hooks);
      }
    }

    return matchedHooks;
  }

  /**
   * 从工具输入提取文件路径
   */
  private extractFilePath(toolInput: Record<string, unknown>): string | undefined {
    // 常见的文件路径字段
    const pathFields = ['file_path', 'path', 'filePath', 'source', 'target'];

    for (const field of pathFields) {
      const value = toolInput[field];
      if (typeof value === 'string') {
        return value;
      }
    }

    return undefined;
  }

  /**
   * 从工具输入提取命令
   */
  private extractCommand(
    toolName: string,
    toolInput: Record<string, unknown>
  ): string | undefined {
    // Bash 工具的命令
    if (toolName === 'Bash' || toolName === 'BashTool') {
      const cmd = toolInput.command;
      if (typeof cmd === 'string') {
        return cmd;
      }
    }

    return undefined;
  }

  /**
   * 清理所有状态
   */
  cleanup(): void {
    this.guard.cleanupAll();
  }
}
