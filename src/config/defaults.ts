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

  // 核心
  debug: false,
  telemetry: true,

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

  // Agentic Loop 配置
  maxTurns: -1, // 默认无限制（受安全上限 100 保护）
};
