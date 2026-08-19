/**
 * Hook Manager
 *
 * 管理 Hook 配置和执行
 */

import path from 'node:path';
import { LRUCache } from 'lru-cache';
import { nanoid } from 'nanoid';
import type { SessionModelResources } from '../agent/resources/WorkspaceModelResources.js';
import type { PermissionMode } from '../config/types.js';
import type {
  McpElicitationDetails,
  McpElicitationResponse,
} from '../mcp/McpElicitation.js';
import { getCwd } from '../utils/cwd.js';
import { DEFAULT_HOOK_CONFIG, mergeHookConfig, parseEnvConfig } from './HookConfig.js';
import { HookExecutionGuard } from './HookExecutionGuard.js';
import { HookExecutor } from './HookExecutor.js';
import { HookTrustService, type HookTrustStatus } from './HookTrustService.js';
import { Matcher } from './Matcher.js';
import {
  type CompactionHookResult,
  type CompactionInput,
  type ElicitationHookResult,
  type ElicitationInput,
  type ElicitationResultInput,
  type FunctionHook,
  type Hook,
  type HookConfig,
  HookEvent,
  type HookExecutionContext,
  type HookMatcher,
  HookType,
  type MatchContext,
  type MatcherConfig,
  type NotificationHookResult,
  type NotificationInput,
  type PermissionRequestHookResult,
  type PermissionRequestInput,
  type PostToolHookResult,
  type PostToolUseFailureHookResult,
  type PostToolUseFailureInput,
  type PostToolUseInput,
  type PreToolHookResult,
  type PreToolUseInput,
  type SessionEndHookResult,
  type SessionEndInput,
  type SessionStartHookResult,
  type SessionStartInput,
  type StopHookResult,
  type StopInput,
  type SubagentStopHookResult,
  type SubagentStopInput,
  type UserPromptSubmitHookResult,
  type UserPromptSubmitInput,
} from './types/HookTypes.js';

export const MAX_RESIDENT_HOOK_PROJECT_CONFIGS = 64;

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
  private processDisabled = false;
  private disabledSessions = new Set<string>();
  private sessionStateAliases = new Map<string, string>();
  private projectConfigs = new LRUCache<string, HookConfig>({
    max: MAX_RESIDENT_HOOK_PROJECT_CONFIGS,
  });
  private sessionConfigs = new Map<string, HookConfig>();
  private managedFunctionMatchers: Partial<Record<HookEvent, HookMatcher[]>> = {};

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

  bindSessionModelResources(
    sessionId: string,
    projectDirs: readonly string[],
    resources: SessionModelResources
  ): void {
    this.executor.bindSessionModelResources(sessionId, projectDirs, resources);
  }

  bindSessionEnvironment(
    sessionId: string,
    projectDirs: readonly string[],
    environment: Readonly<Record<string, string>>
  ): void {
    this.executor.bindSessionEnvironment(sessionId, projectDirs, environment);
  }

  bindSessionConfig(
    sessionId: string,
    projectDirs: readonly string[],
    config: Readonly<HookConfig>
  ): void {
    const canonicalKey = this.sessionConfigKey(sessionId, projectDirs[0] ?? getCwd());
    let disabled = this.disabledSessions.has(canonicalKey);
    for (const projectDir of projectDirs) {
      const key = this.sessionConfigKey(sessionId, projectDir);
      disabled ||= this.disabledSessions.has(key);
      this.sessionStateAliases.set(key, canonicalKey);
      this.sessionConfigs.set(key, this.snapshotConfig(config));
      if (key !== canonicalKey) this.disabledSessions.delete(key);
    }
    if (disabled) this.disabledSessions.add(canonicalKey);
  }

  async unbindSessionModelResources(
    sessionId: string,
    projectDirs: readonly string[]
  ): Promise<void> {
    const prefix = `${sessionId}\0`;
    for (const key of this.sessionConfigs.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.sessionConfigs.delete(key);
    }
    for (const key of this.sessionStateAliases.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.sessionStateAliases.delete(key);
    }
    for (const key of this.disabledSessions) {
      if (!key.startsWith(prefix)) continue;
      this.disabledSessions.delete(key);
    }
    await this.executor.unbindSessionModelResources(sessionId, projectDirs);
  }

  static resetInstance(): void {
    HookManager.instance?.cleanup();
    HookManager.instance = null;
  }

  /**
   * 加载配置
   */
  loadConfig(config: Partial<HookConfig>, projectDir: string = getCwd()): void {
    // 合并配置: 默认 -> 用户配置 -> 环境变量
    let merged = mergeHookConfig(DEFAULT_HOOK_CONFIG, config);
    const envConfig = parseEnvConfig();
    merged = mergeHookConfig(merged, envConfig);

    this.storeProjectConfig(projectDir, merged);
  }

  /**
   * 检查是否启用
   */
  isEnabled(projectDir: string = getCwd(), sessionId?: string): boolean {
    const config = sessionId
      ? this.getExecutionConfig(sessionId, projectDir)
      : this.getConfig(projectDir);
    // 1. 全局配置开关
    if (!config.enabled) {
      return false;
    }

    // 2. 会话级禁用
    if (this.processDisabled) {
      return false;
    }
    if (
      sessionId &&
      this.disabledSessions.has(this.sessionStateKey(sessionId, projectDir))
    ) {
      return false;
    }

    return true;
  }

  /**
   * Disable all hooks process-wide. Kept for host policy and test compatibility.
   */
  disable(): void {
    this.processDisabled = true;
    console.log('[HookManager] Hooks disabled for this process');
  }

  /**
   * Re-enable process-wide hook execution.
   */
  enable(): void {
    this.processDisabled = false;
    console.log('[HookManager] Hooks enabled for this process');
  }

  disableSession(sessionId: string, projectDir: string): void {
    this.disabledSessions.add(this.sessionStateKey(sessionId, projectDir));
  }

  enableSession(sessionId: string, projectDir: string): void {
    this.disabledSessions.delete(this.sessionStateKey(sessionId, projectDir));
  }

  isSessionEnabled(sessionId: string, projectDir: string): boolean {
    return this.isEnabled(projectDir, sessionId);
  }

  isSessionPaused(sessionId: string, projectDir: string): boolean {
    return this.disabledSessions.has(this.sessionStateKey(sessionId, projectDir));
  }

  /**
   * 获取当前配置（只读）
   */
  getConfig(projectDir: string = getCwd()): Readonly<HookConfig> {
    const projectKey = path.resolve(projectDir);
    const projectConfig = this.projectConfigs.get(projectKey);
    if (projectConfig) return projectConfig;
    if (projectKey === path.resolve(getCwd())) return this.config;
    return { ...DEFAULT_HOOK_CONFIG, enabled: false };
  }

  private getExecutionConfig(
    sessionId: string,
    projectDir: string
  ): Readonly<HookConfig> {
    return (
      this.sessionConfigs.get(this.sessionConfigKey(sessionId, projectDir)) ??
      this.getConfig(projectDir)
    );
  }

  private isExecutionEnabled(
    config: Readonly<HookConfig>,
    sessionId: string,
    projectDir: string
  ): boolean {
    return (
      config.enabled === true &&
      !this.processDisabled &&
      !this.disabledSessions.has(this.sessionStateKey(sessionId, projectDir))
    );
  }

  private sessionStateKey(sessionId: string, projectDir: string): string {
    const key = this.sessionConfigKey(sessionId, projectDir);
    return this.sessionStateAliases.get(key) ?? key;
  }

  private sessionConfigKey(sessionId: string, projectDir: string): string {
    return `${sessionId}\0${path.resolve(projectDir)}`;
  }

  private snapshotConfig(config: Readonly<HookConfig>): HookConfig {
    const snapshot = mergeHookConfig(DEFAULT_HOOK_CONFIG, config);
    for (const event of Object.values(HookEvent)) {
      snapshot[event] = (config[event] ?? []).map((matcher) => ({
        ...matcher,
        matcher: matcher.matcher ? { ...matcher.matcher } : undefined,
        hooks: matcher.hooks.map((hook) => ({ ...hook })),
      }));
    }
    return snapshot;
  }

  private storeProjectConfig(projectDir: string, config: HookConfig): void {
    const projectKey = path.resolve(projectDir);
    if (projectKey === path.resolve(getCwd())) {
      this.config = config;
      this.projectConfigs.delete(projectKey);
      return;
    }
    this.projectConfigs.set(projectKey, config);
  }

  inheritProjectConfig(sourceDir: string, targetDir: string, sessionId?: string): void {
    const config = sessionId
      ? this.getExecutionConfig(sessionId, sourceDir)
      : this.getConfig(sourceDir);
    this.storeProjectConfig(targetDir, this.snapshotConfig(config));
    if (!sessionId) return;

    const sourceKey = this.sessionConfigKey(sessionId, sourceDir);
    const targetKey = this.sessionConfigKey(sessionId, targetDir);
    const canonicalKey = this.sessionStateAliases.get(sourceKey) ?? sourceKey;
    const disabled =
      this.disabledSessions.has(canonicalKey) || this.disabledSessions.has(targetKey);
    this.sessionConfigs.set(targetKey, this.snapshotConfig(config));
    this.sessionStateAliases.set(targetKey, canonicalKey);
    if (targetKey !== canonicalKey) this.disabledSessions.delete(targetKey);
    if (disabled) this.disabledSessions.add(canonicalKey);
  }

  getResidencyStats(): {
    projectCapacity: number;
    projectConfigs: number;
    sessionConfigs: number;
    sessionAliases: number;
  } {
    return {
      projectCapacity: MAX_RESIDENT_HOOK_PROJECT_CONFIGS,
      projectConfigs: this.projectConfigs.size,
      sessionConfigs: this.sessionConfigs.size,
      sessionAliases: this.sessionStateAliases.size,
    };
  }

  getTrustStatus(projectDir: string = getCwd()): Promise<HookTrustStatus> {
    return HookTrustService.getInstance().getStatus(
      projectDir,
      this.getConfig(projectDir)
    );
  }

  trustProject(
    projectDir: string = getCwd(),
    expectedDigest?: string
  ): Promise<HookTrustStatus> {
    return HookTrustService.getInstance().trust(
      projectDir,
      this.getConfig(projectDir),
      expectedDigest
    );
  }

  revokeProjectTrust(projectDir: string = getCwd()): Promise<HookTrustStatus> {
    return HookTrustService.getInstance().revoke(
      projectDir,
      this.getConfig(projectDir)
    );
  }

  /**
   * 注册一个内存 Function Hook
   *
   * 适用场景:
   * - SDK / 插件以代码方式注入 Hook (无需 shell 脚本)
   * - 单元测试中快速注入行为
   * - 进程内扩展 (如 lint 集成)
   *
   * @param event     Hook 事件 (PreToolUse / PostToolUse / ...)
   * @param matcher   可选 matcher 配置; 不传则匹配所有工具
   * @param handler   async 处理函数, 返回 HookOutput | undefined
   * @param options   name 用于日志; timeout 覆盖默认超时
   * @returns 取消注册函数
   *
   * @example
   * const off = HookManager.getInstance().registerFunction(
   *   HookEvent.PreToolUse,
   *   { tools: ['Edit', 'Write'] },
   *   async (input) => ({
   *     decision: { behavior: 'block' },
   *     systemMessage: 'Writes are disabled in read-only mode',
   *   })
   * );
   * // 后续: off();
   */
  registerFunction(
    event: HookEvent,
    matcher: MatcherConfig | undefined,
    handler: FunctionHook['handler'],
    options?: { name?: string; timeout?: number; projectDir?: string }
  ): () => void {
    const hookEntry: FunctionHook = {
      type: HookType.Function,
      handler,
      timeout: options?.timeout,
    };
    const matcherEntry: HookMatcher = {
      name: options?.name ?? `inline-${event}-${Date.now()}`,
      matcher,
      hooks: [hookEntry],
    };

    // 不要 push 进现有数组 — 它可能是 DEFAULT_HOOK_CONFIG 的共享引用
    // (mergeHookConfig 只做浅合并),push 会污染全局默认值。
    // 始终用新数组替换,保证 registerFunction 的修改局限在本 instance。
    if (options?.projectDir) {
      const projectKey = path.resolve(options.projectDir);
      const config = this.getConfig(projectKey) as HookConfig;
      const existing = (config[event] ?? []) as HookMatcher[];
      (config[event] as HookMatcher[]) = [...existing, matcherEntry];
      this.storeProjectConfig(projectKey, config);
      return () => {
        const current = config[event] as HookMatcher[] | undefined;
        if (!current) return;
        (config[event] as HookMatcher[]) = current.filter(
          (entry) => entry !== matcherEntry
        );
      };
    }

    const existing = this.managedFunctionMatchers[event] ?? [];
    this.managedFunctionMatchers[event] = [...existing, matcherEntry];
    return () => {
      const current = this.managedFunctionMatchers[event] ?? [];
      this.managedFunctionMatchers[event] = current.filter(
        (entry) => entry !== matcherEntry
      );
    };
  }

  /**
   * 重新加载配置（直接从配置文件读取）
   */
  async reloadConfig(projectDir: string = getCwd()): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    try {
      // 读取本地 settings 文件
      const localSettingsPath = path.join(projectDir, '.blade', 'settings.local.json');
      const content = await fs.readFile(localSettingsPath, 'utf-8');
      const settings = JSON.parse(content);

      if (settings.hooks) {
        this.loadConfig(settings.hooks, projectDir);
      }
    } catch {
      // 文件不存在或读取失败，保持当前配置
    }
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
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
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
    const hooks = this.getMatchingHooks(
      HookEvent.PreToolUse,
      {
        toolName,
        filePath: this.extractFilePaths(toolInput)[0],
        filePaths: this.extractFilePaths(toolInput),
        command: this.extractCommand(toolName, toolInput),
      },
      config
    );

    if (hooks.length === 0) {
      return { decision: 'allow' };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
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
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
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
    const hooks = this.getMatchingHooks(
      HookEvent.PostToolUse,
      {
        toolName,
        filePath: this.extractFilePaths(toolInput)[0],
        filePaths: this.extractFilePaths(toolInput),
        command: this.extractCommand(toolName, toolInput),
      },
      config
    );

    if (hooks.length === 0) {
      return {};
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
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
   * 执行 Stop Hooks
   */
  async executeStopHooks(context: {
    projectDir: string;
    sessionId: string;
    permissionMode: PermissionMode;
    reason?: string;
    abortSignal?: AbortSignal;
  }): Promise<StopHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return { shouldStop: true };
    }

    // 构建 Hook 输入
    const hookInput: StopInput = {
      hook_event_name: HookEvent.Stop,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      reason: context.reason,
    };

    // 获取 hooks (Stop hooks 通常没有匹配器)
    const hooks = this.getMatchingHooks(HookEvent.Stop, {}, config);

    if (hooks.length === 0) {
      return { shouldStop: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeStopHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing Stop hooks:', err);
      return {
        shouldStop: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 SubagentStop Hooks
   */
  async executeSubagentStopHooks(
    agentType: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      taskDescription?: string;
      success: boolean;
      resultSummary?: string;
      error?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<SubagentStopHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return { shouldStop: true };
    }

    // 构建 Hook 输入
    const hookInput: SubagentStopInput = {
      hook_event_name: HookEvent.SubagentStop,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      agent_type: agentType,
      task_description: context.taskDescription,
      success: context.success,
      result_summary: context.resultSummary,
      error: context.error,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.SubagentStop, {}, config);

    if (hooks.length === 0) {
      return { shouldStop: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeSubagentStopHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing SubagentStop hooks:', err);
      return {
        shouldStop: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PermissionRequest Hooks
   */
  async executePermissionRequestHooks(
    toolName: string,
    toolUseId: string,
    toolInput: Record<string, unknown>,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<PermissionRequestHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return { decision: 'ask' };
    }

    // 构建 Hook 输入
    const hookInput: PermissionRequestInput = {
      hook_event_name: HookEvent.PermissionRequest,
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
    const hooks = this.getMatchingHooks(
      HookEvent.PermissionRequest,
      {
        toolName,
        filePath: this.extractFilePaths(toolInput)[0],
        filePaths: this.extractFilePaths(toolInput),
        command: this.extractCommand(toolName, toolInput),
      },
      config
    );

    if (hooks.length === 0) {
      return { decision: 'ask' };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executePermissionRequestHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing PermissionRequest hooks:', err);
      return {
        decision: 'ask',
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 UserPromptSubmit Hooks
   */
  async executeUserPromptSubmitHooks(
    userPrompt: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      hasImages: boolean;
      imageCount: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<UserPromptSubmitHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return { proceed: true };
    }

    // 构建 Hook 输入
    const hookInput: UserPromptSubmitInput = {
      hook_event_name: HookEvent.UserPromptSubmit,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      user_prompt: userPrompt,
      has_images: context.hasImages,
      image_count: context.imageCount,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取 hooks (UserPromptSubmit 通常没有匹配器)
    const hooks = this.getMatchingHooks(HookEvent.UserPromptSubmit, {}, config);

    if (hooks.length === 0) {
      return { proceed: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeUserPromptSubmitHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing UserPromptSubmit hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 SessionStart Hooks
   */
  async executeSessionStartHooks(context: {
    projectDir: string;
    sessionId: string;
    permissionMode: PermissionMode;
    isResume: boolean;
    resumeSessionId?: string;
    abortSignal?: AbortSignal;
  }): Promise<SessionStartHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return { proceed: true };
    }

    // 构建 Hook 输入
    const hookInput: SessionStartInput = {
      hook_event_name: HookEvent.SessionStart,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      is_resume: context.isResume,
      resume_session_id: context.resumeSessionId,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.SessionStart, {}, config);

    if (hooks.length === 0) {
      return { proceed: true };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeSessionStartHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing SessionStart hooks:', err);
      return {
        proceed: true,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 SessionEnd Hooks
   */
  async executeSessionEndHooks(
    reason: SessionEndInput['reason'],
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<SessionEndHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return {};
    }

    // 构建 Hook 输入
    const hookInput: SessionEndInput = {
      hook_event_name: HookEvent.SessionEnd,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      reason,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.SessionEnd, {}, config);

    if (hooks.length === 0) {
      return {};
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      // SessionEnd hooks 不阻塞，异步执行
      await this.executor.executeSessionEndHooks(hooks, hookInput, execContext);
      return {};
    } catch (err) {
      console.error('[HookManager] Error executing SessionEnd hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 PostToolUseFailure Hooks
   */
  async executePostToolUseFailureHooks(
    toolName: string,
    toolUseId: string,
    toolInput: Record<string, unknown>,
    error: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      errorType?: string;
      isInterrupt: boolean;
      isTimeout: boolean;
      abortSignal?: AbortSignal;
    }
  ): Promise<PostToolUseFailureHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return {};
    }

    // 构建 Hook 输入
    const hookInput: PostToolUseFailureInput = {
      hook_event_name: HookEvent.PostToolUseFailure,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      error,
      error_type: context.errorType,
      is_interrupt: context.isInterrupt,
      is_timeout: context.isTimeout,
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
    };

    // 获取匹配的 hooks
    const hooks = this.getMatchingHooks(
      HookEvent.PostToolUseFailure,
      {
        toolName,
        filePath: this.extractFilePaths(toolInput)[0],
        filePaths: this.extractFilePaths(toolInput),
        command: this.extractCommand(toolName, toolInput),
      },
      config
    );

    if (hooks.length === 0) {
      return {};
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executePostToolUseFailureHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing PostToolUseFailure hooks:', err);
      return {
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 执行 Notification Hooks
   */
  async executeNotificationHooks(
    notificationType: NotificationInput['notification_type'],
    message: string,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      title?: string;
      abortSignal?: AbortSignal;
    }
  ): Promise<NotificationHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return { suppress: false, message };
    }

    // 构建 Hook 输入
    const hookInput: NotificationInput = {
      hook_event_name: HookEvent.Notification,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      notification_type: notificationType,
      title: context.title,
      message,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.Notification, {}, config);

    if (hooks.length === 0) {
      return { suppress: false, message };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeNotificationHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing Notification hooks:', err);
      return {
        suppress: false,
        message,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async executeElicitationHooks(
    details: McpElicitationDetails,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<ElicitationHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return {};
    }

    const hookInput: ElicitationInput = {
      hook_event_name: HookEvent.Elicitation,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      server_name: details.serverName,
      mode: details.mode,
      message: details.message,
      requested_schema: details.requestedSchema,
      url: details.url,
      elicitation_id: details.elicitationId,
    };
    return this.executeElicitationHookChain(
      HookEvent.Elicitation,
      hookInput,
      context,
      config
    );
  }

  async executeElicitationResultHooks(
    details: McpElicitationDetails,
    response: McpElicitationResponse,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    }
  ): Promise<ElicitationHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return {};
    }

    const hookInput: ElicitationResultInput = {
      hook_event_name: HookEvent.ElicitationResult,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      server_name: details.serverName,
      mode: details.mode,
      elicitation_id: details.elicitationId,
      action: response.action,
      content: response.content,
    };
    return this.executeElicitationHookChain(
      HookEvent.ElicitationResult,
      hookInput,
      context,
      config
    );
  }

  private async executeElicitationHookChain(
    event: HookEvent.Elicitation | HookEvent.ElicitationResult,
    input: ElicitationInput | ElicitationResultInput,
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      abortSignal?: AbortSignal;
    },
    config: Readonly<HookConfig>
  ): Promise<ElicitationHookResult> {
    const hooks = this.getMatchingHooks(event, {}, config);
    if (hooks.length === 0) return {};
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };
    try {
      return await this.executor.executeElicitationHooks(hooks, input, execContext);
    } catch (error) {
      return {
        warning: `Hook execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * 执行 Compaction Hooks
   */
  async executeCompactionHooks(
    trigger: 'manual' | 'auto',
    context: {
      projectDir: string;
      sessionId: string;
      permissionMode: PermissionMode;
      messagesBefore: number;
      tokensBefore: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<CompactionHookResult> {
    const config = this.getExecutionConfig(context.sessionId, context.projectDir);
    if (!this.isExecutionEnabled(config, context.sessionId, context.projectDir)) {
      return { blockCompaction: false };
    }

    // 构建 Hook 输入
    const hookInput: CompactionInput = {
      hook_event_name: HookEvent.Compaction,
      hook_execution_id: nanoid(),
      timestamp: new Date().toISOString(),
      project_dir: context.projectDir,
      session_id: context.sessionId,
      permission_mode: context.permissionMode,
      trigger,
      messages_before: context.messagesBefore,
      tokens_before: context.tokensBefore,
    };

    // 获取 hooks
    const hooks = this.getMatchingHooks(HookEvent.Compaction, {}, config);

    if (hooks.length === 0) {
      return { blockCompaction: false };
    }

    // 构建执行上下文
    const execContext: HookExecutionContext = {
      projectDir: context.projectDir,
      sessionId: context.sessionId,
      permissionMode: context.permissionMode,
      config,
      abortSignal: context.abortSignal,
    };

    try {
      const results = await this.executor.executeCompactionHooks(
        hooks,
        hookInput,
        execContext
      );
      return results;
    } catch (err) {
      console.error('[HookManager] Error executing Compaction hooks:', err);
      return {
        blockCompaction: false,
        warning: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 获取匹配的 Hooks
   */
  private getMatchingHooks(
    event: HookEvent,
    context: MatchContext,
    config: Readonly<HookConfig>
  ): Hook[] {
    const matchers = [
      ...(config[event] ?? []),
      ...(this.managedFunctionMatchers[event] ?? []),
    ];

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
  private extractFilePaths(toolInput: Record<string, unknown>): string[] {
    const paths: string[] = [];
    // 常见的文件路径字段
    const pathFields = ['file_path', 'path', 'filePath', 'source', 'target'];

    for (const field of pathFields) {
      const value = toolInput[field];
      if (typeof value === 'string') {
        paths.push(value);
      }
    }

    if (typeof toolInput.patch === 'string') {
      for (const match of toolInput.patch.matchAll(
        /^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm
      )) {
        if (match[1]) paths.push(match[1]);
      }
      for (const match of toolInput.patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
        if (match[1]) paths.push(match[1]);
      }
    }
    return [...new Set(paths)];
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
    this.config = DEFAULT_HOOK_CONFIG;
    this.processDisabled = false;
    this.disabledSessions.clear();
    this.sessionStateAliases.clear();
    this.projectConfigs.clear();
    this.sessionConfigs.clear();
    this.managedFunctionMatchers = {};
  }
}
