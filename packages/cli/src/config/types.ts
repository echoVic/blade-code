export type ProviderType = string;

/** DEFAULT asks before writes/executes; AUTO_EDIT permits writes; YOLO permits
 * every tool; PLAN permits read-only tools until ExitPlanMode. */
export enum PermissionMode {
  DEFAULT = 'default',
  AUTO_EDIT = 'autoEdit',
  YOLO = 'yolo',
  PLAN = 'plan',
}

export interface ModelRef {
  provider: string;
  model: string;
  configId?: string;
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
import type { HookConfig as HookConfigType } from '../hooks/types/HookTypes.js';
export type HookConfig = HookConfigType;
export interface BladeConfig {
  currentModelId: string; // 当前激活的模型 ID
  models: ModelConfig[]; // 所有模型配置
  modelProviders: Record<string, ModelProviderConfig>; // 自定义 Provider 渠道

  temperature: number;
  maxContextTokens?: number; // 已弃用；运行时使用 pi-ai model.contextWindow
  maxOutputTokens?: number; // 输出 token 限制（传给 API 的 max_tokens），undefined 表示让 API 使用默认值
  stream: boolean;
  topP: number;
  topK: number;
  timeout: number; // 单次 Provider physical attempt 的 hard total timeout（毫秒）
  bashForegroundHandoffMs?: number; // 0 禁用；否则长前台 Bash 自动交接到后台的预算
  providerForegroundRecoveryMs?: number; // 0 禁用；否则 root turn 的有界 Provider 恢复预算
  providerCircuitBreakerOpenMs?: number; // 0 禁用；否则共享 Provider circuit 的 open 时间
  providerRequestConcurrency?: number; // 同一敏感 Provider failure-domain 的 active stream 上限
  providerGlobalConcurrency?: number; // 显式启用的进程级 Provider active stream 上限
  providerOwnerConcurrency?: number; // 显式启用的 owner 级 Provider active stream 上限
  providerRequestAdmissionMs?: number; // 0 fail-fast；否则等待 Provider stream capacity 的上限
  providerRequestPendingBytes?: number; // 进程级 Provider admission pending request footprint 上限
  agentTeamsEnabled?: boolean; // 启用正式 Agent Teams 协作能力

  codeTheme: string;
  uiTheme: UiTheme;
  language: string;
  fontSize: number;
  autoSaveSessions: boolean;
  notifyBuild: boolean;
  notifyErrors: boolean;
  notifySounds: boolean;
  privacyTelemetry: boolean;
  privacyCrash: boolean;
  // Default for new turns: built-in id or project:<id>; optional for compatibility.
  communicationStyle?: string;

  // 核心 debug 支持 boolean 或字符串过滤器（如 "agent,ui" 或 "!chat,!loop"）
  debug: string | boolean;
  mcpEnabled: boolean;
  mcpServers: Record<string, McpServerConfig>; // 启动项目投影；执行时按 Session 重解析

  lspServers: Record<string, LspServerConfig>; // Session 私有、按 source project 重解析

  permissions: PermissionConfig;
  permissionMode: PermissionMode;
  hooks: HookConfig;

  // Plugins (later workspace layers override by plugin name)
  enabledPlugins: Record<string, boolean>;
  pluginSourcePolicy: PluginSourcePolicy;
  env: Record<string, string>;
  disableAllHooks: boolean;
  maxTurns: number; // -1 = 无限制, 0 = 完全禁用对话, N > 0 = 限制轮次
  maxConcurrentTasks: number; // 同一进程内允许同时运行的顶层任务数
  maxQueuedTasks: number; // 等待 admission 的顶层任务上限
  maxQueuedTaskBytes: number; // 等待 admission 的顶层任务 retained-byte 上限
  maxResidentSessionRuntimes: number; // 长运行进程内 fully initialized Session Runtime 上限
  sessionRuntimeIdleMs: number; // Web Session Runtime idle eviction TTL
  maxResidentSessionProjections: number; // 长运行进程内 resident Session projection 上限
  sessionProjectionIdleMs: number; // Session projection idle eviction TTL
}

export interface PermissionConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface RuntimeConfig extends BladeConfig {
  systemPrompt?: string; // 替换默认系统提示
  appendSystemPrompt?: string; // 追加到默认系统提示

  initialMessage?: string; // 初始消息（用于自动发送）
  resumeSessionId?: string; // 恢复会话 ID
  forkSession?: boolean; // 创建新会话 ID（fork 模式）

  allowedTools?: string[]; // 允许的工具列表（白名单）
  disallowedTools?: string[]; // 禁止的工具列表（黑名单）

  mcpConfigPaths?: string[]; // MCP 配置文件路径
  strictMcpConfig?: boolean; // 仅使用 CLI 指定的 MCP 服务器

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

export interface McpServerConfig {
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
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
  oauth?: {
    enabled?: boolean;
    clientId?: string;
    scopes?: string[];
    callbackPort?: number;
  };
  healthCheck?: {
    enabled?: boolean;
    interval?: number; // 检查间隔（毫秒）
    timeout?: number; // 超时时间（毫秒）
    failureThreshold?: number; // 失败阈值
  };
  recovery?: {
    enabled?: boolean;
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    terminalErrorThreshold?: number;
  };
}

export interface SetupConfig {
  displayName?: string;
  provider: ProviderType;
  model: string;
  apiKey?: string;
  overrides?: ModelOverrides;
  modelProvider?: ModelProviderConfig;
}
