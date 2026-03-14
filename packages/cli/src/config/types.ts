/**
 * Blade 统一配置类型定义
 * 合并了 config.json 和 settings.json 的所有配置项
 */

export type ProviderType =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini'
  | 'azure-openai'
  | 'antigravity'
  | 'copilot';

/**
 * 权限模式枚举
 *
 * ## DEFAULT 模式（默认）
 * - ✅ 自动批准: ReadOnly 工具（Read/Glob/Grep/WebFetch/WebSearch/TaskOutput/TodoWrite/Plan）
 * - ❌ 需要确认: Write 工具（Edit/Write/NotebookEdit）、Execute 工具（Bash/Task/Skill/SlashCommand）
 *
 * ## AUTO_EDIT 模式
 * - ✅ 自动批准: ReadOnly + Write 工具
 * - ❌ 需要确认: Execute 工具（Bash/Task/Skill/SlashCommand）
 * - 适用场景：频繁修改代码的开发任务
 *
 * ## YOLO 模式（危险）
 * - ✅ 自动批准: 所有工具（ReadOnly + Write + Execute）
 * - ⚠️  警告：完全信任 AI，跳过所有确认
 * - 适用场景：高度可控的环境或演示场景
 *
 * ## PLAN 模式
 * - ✅ 自动批准: ReadOnly 工具（只读操作，无副作用）
 * - ❌ 拦截所有修改: Write 和 Execute 工具
 * - 🔵 特殊工具: ExitPlanMode（用于提交方案）
 * - 适用场景：调研阶段，生成实现方案，用户批准后退出 Plan 模式
 *
 * ## SPEC 模式（Spec-Driven Development）
 * - ✅ 自动批准: ReadOnly 工具 + Spec 专用工具
 * - ❌ 需要确认: Write 和 Execute 工具（除 Spec 工具外）
 * - 🔵 特殊工具: InitSpec, UpdateSpec, ValidateSpec, GetSpecContext, ExitSpecMode
 * - 📁 持久化: Spec 文件自动保存到 `.blade/specs/<feature>/` 或 `.blade/changes/<feature>/`
 * - 适用场景：复杂功能开发，需要结构化的 Requirements → Design → Tasks → Implementation 工作流
 * - 与 Plan Mode 共存：Plan Mode 用于简单任务，Spec Mode 用于复杂功能开发
 */
export enum PermissionMode {
  DEFAULT = 'default',
  AUTO_EDIT = 'autoEdit',
  YOLO = 'yolo',
  PLAN = 'plan',
  SPEC = 'spec',
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  apiVersion?: string;
  projectId?: string;
  providerId?: string;
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

  // 全局默认参数
  temperature: number;
  maxContextTokens: number; // 上下文窗口大小（用于压缩判断）
  maxOutputTokens?: number; // 输出 token 限制（传给 API 的 max_tokens），undefined 表示让 API 使用默认值
  stream: boolean;
  topP: number;
  topK: number;
  timeout: number; // HTTP 请求超时时间（毫秒）

  // UI
  theme: string;
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

  // 核心
  // debug 支持 boolean 或字符串过滤器（如 "agent,ui" 或 "!chat,!loop"）
  debug: string | boolean;

  // MCP
  mcpEnabled: boolean;
  mcpServers: Record<string, McpServerConfig>; // MCP 服务器配置（全局）

  // =====================================
  // 行为配置 (来自 settings.json)
  // =====================================

  // 权限
  permissions: PermissionConfig;
  permissionMode: PermissionMode;

  // Hooks
  hooks: HookConfig;

  // 环境变量
  env: Record<string, string>;

  // 其他
  disableAllHooks: boolean;

  // Agentic Loop 配置
  maxTurns: number; // -1 = 无限制, 0 = 完全禁用对话, N > 0 = 限制轮次
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
  addDirs?: string[]; // 额外允许访问的目录
  outputFormat?: 'text' | 'json' | 'stream-json'; // 输出格式
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

  // http/sse 传输
  url?: string;
  headers?: Record<string, string>;

  // 通用配置
  timeout?: number;

  // OAuth 配置
  oauth?: {
    enabled?: boolean;
    clientId?: string;
    clientSecret?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    redirectUri?: string;
  };

  // 健康监控配置
  healthCheck?: {
    enabled?: boolean;
    interval?: number; // 检查间隔（毫秒）
    timeout?: number; // 超时时间（毫秒）
    failureThreshold?: number; // 失败阈值
  };
}

/**
 * SetupWizard 保存的配置字段
 * （API 连接相关的核心配置）
 * 注意：这是用于创建第一个模型配置的数据
 */
export interface SetupConfig {
  name: string;
  provider: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  providerId?: string;
}
