/**
 * Blade 极简配置
 * 平铺式一体化默认配置
 */

import type { BladeConfig } from '@blade-ai/types';

export const DEFAULT_CONFIG: BladeConfig = {
  // 核心配置 (必须)
  apiKey: '',
  baseUrl: 'https://apis.iflow.cn/v1',
  modelName: 'Qwen3-Coder',

  // 推荐配置
  searchApiKey: '',
  theme: 'GitHub',
  sandbox: 'docker',

  // UI控制
  hideTips: false,
  hideBanner: false,
  
  // 会话控制
  maxSessionTurns: 10,
  
  // 工具配置
  toolDiscoveryCommand: 'bin/get_tools',
  toolCallCommand: 'bin/call_tool',
  
  // MCP服务器
  mcpServers: {
    main: {
      command: 'bin/mcp_server.py',
    }
  },
  
  // 输出控制
  summarizeToolOutput: {
    run_shell_command: { tokenBudget: 100 }
  },
  
  // 遥测和统计
  telemetry: {
    enabled: true,
    target: 'local',
    otlpEndpoint: 'http://localhost:4317',
    logPrompts: false
  },
  usageStatisticsEnabled: true,

  // 调试开关
  debug: false,
};

/**
 * 简化环境变量映射
 */
export const ENV_MAPPING = {
  BLADE_API_KEY: 'apiKey',
  BLADE_BASE_URL: 'baseUrl',
  BLADE_MODEL: 'modelName',
  BLADE_SEARCH_API_KEY: 'searchApiKey',
  BLADE_THEME: 'theme',
  BLADE_SANDBOX: 'sandbox',
  BLADE_MAX_TURNS: 'maxSessionTurns',
  BLADE_DEBUG: 'debug',
};

/**
 * 完全翻翻重写的默认提供商
 */
export const getProviderConfig = () => DEFAULT_CONFIG;
export const isProviderSupported = () => true;
export const validateApiKey = (key: string) => key || process.env.BLADE_API_KEY || '';
export const loadConfigFromEnv = () => ({
  apiKey: process.env.BLADE_API_KEY || '',
  baseUrl: process.env.BLADE_BASE_URL || 'https://apis.iflow.cn/v1',
  modelName: process.env.BLADE_MODEL || 'Qwen3-Coder',
});