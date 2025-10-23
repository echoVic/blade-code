/**
 * Blade 默认配置
 */

import { BladeConfig, PermissionMode } from './types.js';

export const DEFAULT_CONFIG: BladeConfig = {
  // =====================================
  // 基础配置 (config.json)
  // =====================================

  // 认证
  provider: 'openai-compatible',
  apiKey: '',
  baseUrl: 'https://apis.iflow.cn/v1',

  // 模型
  model: 'qwen3-coder-plus',
  temperature: 0.0,
  maxTokens: 200000, // 200k - 主流 Agent 模型的标准窗口大小
  stream: true,
  topP: 0.9,
  topK: 50,
  timeout: 30000, // 30秒超时

  // UI
  theme: 'GitHub',
  language: 'zh-CN',
  fontSize: 14,
  showStatusBar: true,

  // 核心
  debug: false,
  telemetry: true,
  autoUpdate: true,
  workingDirectory: process.cwd(),

  // 日志
  logLevel: 'info',
  logFormat: 'text',

  // MCP
  mcpEnabled: false,

  // =====================================
  // 行为配置 (settings.json)
  // =====================================

  // 权限
  permissions: {
    allow: [],
    ask: [],
    deny: ['Read(./.env)', 'Read(./.env.*)'],
  },
  permissionMode: PermissionMode.DEFAULT,

  // Hooks
  hooks: {},

  // 环境变量
  env: {},

  // 其他
  disableAllHooks: false,
  cleanupPeriodDays: 30,
  includeCoAuthoredBy: true,

  // Agentic Loop 配置
  maxTurns: -1, // 默认无限制（受安全上限 100 保护）
};

/**
 * 环境变量映射表
 */
export const ENV_VAR_MAPPING: Record<string, keyof BladeConfig> = {
  // 认证
  BLADE_PROVIDER: 'provider',
  BLADE_API_KEY: 'apiKey',
  BLADE_BASE_URL: 'baseUrl',

  // 模型
  BLADE_MODEL: 'model',
  BLADE_TEMPERATURE: 'temperature',
  BLADE_MAX_TOKENS: 'maxTokens',
  BLADE_TIMEOUT: 'timeout',

  // UI
  BLADE_THEME: 'theme',
  BLADE_LANGUAGE: 'language',

  // 核心
  BLADE_DEBUG: 'debug',
  BLADE_TELEMETRY: 'telemetry',

  // Agentic Loop
  BLADE_MAX_TURNS: 'maxTurns',
};
