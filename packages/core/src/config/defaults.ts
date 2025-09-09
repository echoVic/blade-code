/**
 * Blade 极简配置
 * 平铺式一体化默认配置
 */

import type { BladeConfig } from './types/index.js';

export const DEFAULT_CONFIG: BladeConfig = {
  // 认证配置
  apiKey: '',
  baseUrl: 'https://apis.iflow.cn/v1',
  modelName: 'qwen3-max-preview',

  // UI 配置
  theme: 'GitHub',
  hideTips: false,
  hideBanner: false,

  // 使用配置
  maxSessionTurns: 10,

  // 工具配置
  toolDiscoveryCommand: 'bin/get_tools',
  toolCallCommand: 'bin/call_tool',

  // 遥测配置
  telemetryEnabled: true,
  telemetryTarget: 'local',
  otlpEndpoint: 'http://localhost:4317',
  logPrompts: false,
  usageStatisticsEnabled: true,

  // 调试配置
  debug: false,
};

/**
 * 简化环境变量映射
 */
export const ENV_MAPPING = {
  BLADE_API_KEY: 'apiKey',
  BLADE_BASE_URL: 'baseUrl',
  BLADE_MODEL: 'modelName',
  BLADE_THEME: 'theme',
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
