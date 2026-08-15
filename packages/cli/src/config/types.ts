/**
 * Blade 统一配置类型定义
 * 合并了 config.json 和 settings.json 的所有配置项
 */

export type ProviderType = string;

/**
 * 权限模式枚举
 *
 * ## DEFAULT 模式（默认）
 * - Auto-approve: ReadOnly 工具（Read/Glob/Grep/WebFetch/WebSearch/TaskOutput/TaskCreate/TaskGet/TaskUpdate/TaskList/Plan）
 * - Needs confirm: Write 工具（Edit/Write/NotebookEdit）、Execute 工具（Bash/Task/Skill/SlashCommand）
 *
 * ## AUTO_EDIT 模式
 * - Auto-approve: ReadOnly + Write 工具
 * - Needs confirm: Execute 工具（Bash/Task/Skill/SlashCommand）
 * - 适用场景：频繁修改代码的开发任务
 *
 * ## YOLO 模式（危险）
 * - Auto-approve: 所有工具（ReadOnly + Write + Execute）
 * - WARNING: 完全信任 AI，跳过所有确认
 * - 适用场景：高度可控的环境或演示场景
 *
 * ## PLAN 模式
 * - Auto-approve: ReadOnly 工具（只读操作，无副作用）
 * - Blocks all modifications: Write 和 Execute 工具
 * - Special tools: ExitPlanMode（用于提交方案）
 * - 适用场景：调研阶段，生成实现方案，用户批准后退出 Plan 模式
 */
export enum PermissionMode {
  DEFAULT = 'default',
  AUTO_EDIT = 'autoEdit',
  YOLO = 'yolo',
  PLAN = 'plan',
}

export interface ModelRef {
  provider: string;
  model: string;
}

export type ModelProviderWireApi = 'openai-completions' | 'anthropic-messages';

/**
 * A concrete model-provider channel.
 *
 * The map key in BladeConfig.modelProviders is the runtime provider id and
 * the credential key in auth.json. Keeping the channel separate from the
 * wire protocol allows multiple OpenAI/Anthropic-compatible gateways to
 * coexist without sharing credentials.
 */
export interface ModelProviderConfig {
  name: string;
  baseUrl: string;
  wireApi: ModelProviderWireApi;
  apiKeyEnv?: string;
}

export interface ModelOverrides {
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeout?: number;
  streamIdleTimeout?: number;
  apiVersion?: string;
  customHeaders?: Record<string, string>;
  maxRetries?: number;
  enablePromptCaching?: boolean;
}

export interface ModelConfig {
  id: string;
  displayName?: string;
  provider: ProviderType;
  model: string;
  overrides?: ModelOverrides;
  fallbackModels?: ModelRef[];
}

export type ReasoningEffortSelection =
  | 'auto'
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type ServiceTierSelection = 'auto' | 'standard' | 'fast' | 'flex';

export type ResponseVerbositySelection = 'auto' | 'low' | 'medium' | 'high';

export type BuiltInCommunicationStyleSelection =
  | 'auto'
  | 'pragmatic'
  | 'friendly'
  | 'explanatory';

export type CustomCommunicationStyleSelection =
  | `user:${string}`
  | `project:${string}`
  | `plugin:${string}:${string}`;

export type CommunicationStyleSelection =
  | BuiltInCommunicationStyleSelection
  | CustomCommunicationStyleSelection;

export interface PluginSourcePolicy {
  restrictToAllowedSources: boolean;
  requireGitCommitSha: boolean;
  allowedGitHosts: string[];
  allowedMarketplaces: string[];
  allowedLocalRoots: string[];
}

export interface LspServerConfig {
  command: string;
  args?: string[];
  extensionToLanguage: Record<string, string>;
  env?: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  enabled?: boolean;
  priority?: number;
  startupTimeout?: number;
  shutdownTimeout?: number;
  requestTimeout?: number;
  diagnosticWaitTimeout?: number;
  maxRestarts?: number;
}

import { UiTheme } from '@/api/schemas.js';
/**
 * Hooks 配置
 * 导入自 hooks 模块
 */
import type { HookConfig as HookConfigType } from '../hooks/types/HookTypes.js';
export type HookConfig = HookConfigType;

export interface BladeConfig {
  // =====================================
  // 基础配置 (来自 config.json - 扁平化)
  // =====================================

  // 多模型配置
  currentModelId: string; // 当前激活的模型 ID
  models: ModelConfig[]; // 所有模型配置
  modelProviders: Record<string, ModelProviderConfig>; // 自定义 Provider 渠道

  // 全局默认参数
  temperature: number;
  maxContextTokens?: number; // 已弃用；运行时使用 pi-ai model.contextWindow
  maxOutputTokens?: number; // 输出 token 限制（传给 API 的 max_tokens），undefined 表示让 API 使用默认值
  stream: boolean;
  topP: number;
  topK: number;
  timeout: number; // HTTP 请求超时时间（毫秒）
  bashForegroundHandoffMs?: number; // 0 禁用；否则长前台 Bash 自动交接到后台的预算

  // UI
  codeTheme: string;
  uiTheme: UiTheme;
  language: string;
  fontSize: number;

  // General Settings
  autoSaveSessions: boolean;
  notifyBuild: boolean;
  notifyErrors: boolean;
  notifySounds: boolean;
  privacyTelemetry: boolean;
  privacyCrash: boolean;
  // Default communication style selection applied to new turns (e.g. 'auto',
  // a built-in id, or a 'project:<id>' reference). Optional for backward compat.
  communicationStyle?: string;

  // 核心
  // debug 支持 boolean 或字符串过滤器（如 "agent,ui" 或 "!chat,!loop"）
  debug: string | boolean;

  // MCP
  mcpEnabled: boolean;
  mcpServers: Record<string, McpServerConfig>; // 启动项目投影；执行时按 Session 重解析

  // LSP
  lspServers: Record<string, LspServerConfig>; // Session 私有、按 source project 重解析

  // =====================================
  // 行为配置 (来自 settings.json)
  // =====================================

  // 权限
  permissions: PermissionConfig;
  permissionMode: PermissionMode;

  // Hooks
  hooks: HookConfig;

  // Plugins (later workspace layers override by plugin name)
  enabledPlugins: Record<string, boolean>;
  pluginSourcePolicy: PluginSourcePolicy;

  // 环境变量
  env: Record<string, string>;

  // 其他
  disableAllHooks: boolean;

  // Agentic Loop 配置
  maxTurns: number; // -1 = 无限制, 0 = 完全禁用对话, N > 0 = 限制轮次
  maxConcurrentTasks: number; // 同一进程内允许同时运行的顶层任务数
  maxQueuedTasks: number; // 等待 admission 的顶层任务上限
}

/**
 * 权限配置
 */
export interface PermissionConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

/**
 * 运行时配置类型
 * 继承 BladeConfig (持久化配置) + CLI 专属字段 (临时配置)
 *
 * CLI 专属字段只在当前会话有效，不会保存到配置文件
 */
export interface RuntimeConfig extends BladeConfig {
  // CLI 专属字段 - 系统提示
  systemPrompt?: string; // 替换默认系统提示
  appendSystemPrompt?: string; // 追加到默认系统提示

  // CLI 专属字段 - 会话管理
  initialMessage?: string; // 初始消息（用于自动发送）
  resumeSessionId?: string; // 恢复会话 ID
  forkSession?: boolean; // 创建新会话 ID（fork 模式）

  // CLI 专属字段 - 工具过滤
  allowedTools?: string[]; // 允许的工具列表（白名单）
  disallowedTools?: string[]; // 禁止的工具列表（黑名单）

  // CLI 专属字段 - MCP
  mcpConfigPaths?: string[]; // MCP 配置文件路径
  strictMcpConfig?: boolean; // 仅使用 CLI 指定的 MCP 服务器

  // CLI 专属字段 - 其他
  model?: string; // 当前运行覆盖模型（模型配置 ID）
  addDirs?: string[]; // 额外允许访问的目录
  outputFormat?: 'text' | 'json' | 'stream-json' | 'jsonl'; // 输出格式
  inputFormat?: 'text' | 'stream-json'; // 输入格式
  print?: boolean; // 打印响应后退出
  includePartialMessages?: boolean; // 包含部分消息
  replayUserMessages?: boolean; // 重放用户消息
  agentsConfig?: string; // 自定义 Agent 配置
  settingSources?: string; // 配置来源列表
}

/**
 * MCP 服务器配置
 */
export interface McpServerConfig {
  type: 'stdio' | 'sse' | 'http';

  // stdio 传输
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

  // http/sse 传输
  url?: string;
  headers?: Record<string, string>;

  // 通用配置
  timeout?: number;
  idleTimeout?: number;
  sampling?: {
    enabled: boolean;
    maxTokens?: number;
    maxRequestsPerToolCall?: number;
    maxInputBytes?: number;
  };
  logging?: {
    enabled?: boolean;
    level?:
      | 'debug'
      | 'info'
      | 'notice'
      | 'warning'
      | 'error'
      | 'critical'
      | 'alert'
      | 'emergency';
  };
  tasks?: {
    enabled: boolean;
    defaultTtlMs?: number;
    pollIntervalMs?: number;
    maxTasksPerSession?: number;
    maxLifetimeMs?: number;
  };

  // OAuth 配置
  oauth?: {
    enabled?: boolean;
    clientId?: string;
    scopes?: string[];
    callbackPort?: number;
  };

  // 健康监控配置
  healthCheck?: {
    enabled?: boolean;
    interval?: number; // 检查间隔（毫秒）
    timeout?: number; // 超时时间（毫秒）
    failureThreshold?: number; // 失败阈值
  };

  // 意外断连恢复配置
  recovery?: {
    enabled?: boolean;
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    terminalErrorThreshold?: number;
  };
}

/**
 * SetupWizard 保存的配置字段
 * （API 连接相关的核心配置）
 * 注意：这是用于创建第一个模型配置的数据
 */
export interface SetupConfig {
  displayName?: string;
  provider: ProviderType;
  model: string;
  apiKey?: string;
  overrides?: ModelOverrides;
  modelProvider?: ModelProviderConfig;
}
