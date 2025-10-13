/**
 * Blade 默认配置
 */

import { BladeConfig } from './types.js';

export const DEFAULT_CONFIG: BladeConfig = {
  // =====================================
  // 基础配置 (config.json)
  // =====================================

  // 认证
  apiKey: '',
  baseURL: 'https://apis.iflow.cn/v1',

  // 模型
  model: 'qwen3-coder-plus',
  temperature: 0.0,
  maxTokens: 32000,
  stream: true,
  topP: 0.9,
  topK: 50,

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

  // Hooks
  hooks: {},

  // 环境变量
  env: {},

  // 其他
  disableAllHooks: false,
  cleanupPeriodDays: 30,
  includeCoAuthoredBy: true,
};

/**
 * 环境变量映射表
 */
export const ENV_VAR_MAPPING: Record<string, keyof BladeConfig> = {
  // 认证
  BLADE_API_KEY: 'apiKey',
  BLADE_API_SECRET: 'apiSecret',
  BLADE_BASE_URL: 'baseURL',

  // 模型
  BLADE_MODEL: 'model',
  BLADE_TEMPERATURE: 'temperature',
  BLADE_MAX_TOKENS: 'maxTokens',

  // UI
  BLADE_THEME: 'theme',
  BLADE_LANGUAGE: 'language',

  // 核心
  BLADE_DEBUG: 'debug',
  BLADE_TELEMETRY: 'telemetry',
};
