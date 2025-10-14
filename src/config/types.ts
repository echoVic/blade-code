/**
 * Blade 统一配置类型定义
 * 合并了 config.json 和 settings.json 的所有配置项
 */

/**
 * LLM API 提供商类型
 */
export type ProviderType = 'openai-compatible' | 'anthropic';

/**
 * Blade 统一配置接口
 */
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
