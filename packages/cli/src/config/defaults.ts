/** Blade 默认配置 */

import defaultPermissions from './defaultPermissions.json';
import { DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS } from './foregroundCommandHandoff.js';
import { DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS } from './foregroundProviderRecovery.js';
import { DEFAULT_PROVIDER_CIRCUIT_OPEN_MS } from './providerCircuitBreaker.js';
import {
  DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  DEFAULT_PROVIDER_REQUEST_PENDING_BYTES,
} from './providerRequestAdmission.js';
import {
  DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS,
  DEFAULT_SESSION_PROJECTION_IDLE_MS,
} from './sessionProjectionResidency.js';
import {
  DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES,
  DEFAULT_SESSION_RUNTIME_IDLE_MS,
} from './sessionRuntimeResidency.js';
import { DEFAULT_MAX_QUEUED_TASK_BYTES } from './taskConcurrency.js';
import { BladeConfig, PermissionMode } from './types.js';

export const DEFAULT_CONFIG: BladeConfig = {
  // =====================================
  // 基础配置 (config.json)
  // =====================================

  // 多模型配置
  currentModelId: '',
  models: [],
  modelProviders: {},

  // 全局默认参数
  temperature: 0.0,
  maxOutputTokens: undefined, // 不设置默认值，让各 API 使用自己的默认限制
  stream: true,
  topP: 0.9,
  topK: 50,
  timeout: 180000, // 单次 Provider attempt 的 180 秒 hard total timeout
  bashForegroundHandoffMs: DEFAULT_FOREGROUND_COMMAND_HANDOFF_MS,
  providerForegroundRecoveryMs: DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS,
  providerCircuitBreakerOpenMs: DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
  providerRequestAdmissionMs: DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  agentTeamsEnabled: false,
  providerRequestPendingBytes: DEFAULT_PROVIDER_REQUEST_PENDING_BYTES,

  // UI
  codeTheme: 'dracula',
  uiTheme: 'system',
  language: 'zh-CN',
  fontSize: 14,

  // General Settings
  autoSaveSessions: true,
  notifyBuild: true,
  notifyErrors: false,
  notifySounds: false,
  privacyTelemetry: false,
  privacyCrash: true,

  // 核心
  debug: false,

  // MCP
  mcpEnabled: false,
  mcpServers: {}, // 空对象表示没有配置 MCP 服务器

  // LSP
  lspServers: {},

  // =====================================
  // 行为配置 (settings.json)
  // =====================================

  permissions: defaultPermissions,
  permissionMode: PermissionMode.DEFAULT,

  // Hooks (默认禁用)
  hooks: {
    enabled: false,
    defaultTimeout: 60,
    timeoutBehavior: 'ignore',
    failureBehavior: 'ignore',
    maxConcurrentHooks: 5,
    // 工具执行类
    PreToolUse: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    PermissionRequest: [],
    Elicitation: [],
    ElicitationResult: [],
    // 会话生命周期类
    UserPromptSubmit: [],
    SessionStart: [],
    SessionEnd: [],
    // 控制流类
    Stop: [],
    SubagentStop: [],
    // 其他
    Notification: [],
    Compaction: [],
  },

  // Plugins
  enabledPlugins: {},
  pluginSourcePolicy: {
    restrictToAllowedSources: false,
    requireGitCommitSha: false,
    allowedGitHosts: [],
    allowedMarketplaces: [],
    allowedLocalRoots: [],
  },

  // 环境变量
  env: {},

  // 其他
  disableAllHooks: false,

  // Agentic Loop 配置
  maxTurns: -1, // 默认无限制
  maxConcurrentTasks: 3,
  maxQueuedTasks: 100,
  maxQueuedTaskBytes: DEFAULT_MAX_QUEUED_TASK_BYTES,
  maxResidentSessionRuntimes: DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES,
  sessionRuntimeIdleMs: DEFAULT_SESSION_RUNTIME_IDLE_MS,
  maxResidentSessionProjections: DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS,
  sessionProjectionIdleMs: DEFAULT_SESSION_PROJECTION_IDLE_MS,
};
