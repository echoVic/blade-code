/**
 * Blade 统一配置类型定义
 * 合并了 config.json 和 settings.json 的所有配置项
 */

/**
 * LLM API 提供商类型
 */
export type ProviderType = 'openai-compatible' | 'anthropic';

/**
 * 权限模式枚举
 *
 * ## DEFAULT 模式（默认）
 * - ✅ 自动批准: Read, Search (只读操作，安全)
 * - ❌ 需要确认: Edit, Write, Bash, Delete, Move 等
 *
 * ## AUTO_EDIT 模式
 * - ✅ 自动批准: Read, Search, Edit
 * - ❌ 需要确认: Write, Bash, Delete, Move 等
 * - 适用场景：频繁修改代码的开发任务
 *
 * ## YOLO 模式（危险）
 * - ✅ 自动批准: 所有工具
 * - ⚠️  警告：完全信任 AI，跳过所有确认
 * - 适用场景：高度可控的环境或演示场景
 *
 * ## PLAN 模式（计划中）
 * - 保留占位，暂未实现
 */
export enum PermissionMode {
  DEFAULT = 'default',
  AUTO_EDIT = 'autoEdit',
  YOLO = 'yolo',
  PLAN = 'plan', // TODO: 暂未实现，仅占位
}

export interface BladeConfig {
  // =====================================
  // 基础配置 (来自 config.json - 扁平化)
  // =====================================

  // 认证
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;

  // 模型
  model: string;
  temperature: number;
  maxTokens: number;
  stream: boolean;
  topP: number;
  topK: number;
  timeout: number; // HTTP 请求超时时间（毫秒）

  // UI
  theme: string;
  language: string;
  fontSize: number;
  showStatusBar: boolean;

  // 核心
  debug: boolean;
  telemetry: boolean;
  telemetryEndpoint?: string; // 遥测数据上报端点
  autoUpdate: boolean;
  workingDirectory: string;

  // 日志
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'text';

  // MCP
  mcpEnabled: boolean;

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
  cleanupPeriodDays: number;
  includeCoAuthoredBy: boolean;
  apiKeyHelper?: string;
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
 * Hooks 配置
 */
export interface HookConfig {
  PreToolUse?: Record<string, string>;
  PostToolUse?: Record<string, string>;
}

/**
 * MCP 服务器配置
 */
export interface MCPServer {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}
