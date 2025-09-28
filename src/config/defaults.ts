/**
 * Blade 极简配置
 * 使用从 types.ts 导入的 DEFAULT_CONFIG
 */

export { DEFAULT_CONFIG } from './types.js';

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
import { DEFAULT_CONFIG } from './types.js';

export const getProviderConfig = () => DEFAULT_CONFIG;
export const isProviderSupported = () => true;
export const validateApiKey = (key: string) => key || process.env.BLADE_API_KEY || '';
export const loadConfigFromEnv = () => ({
  apiKey: process.env.BLADE_API_KEY || '',
  baseUrl: process.env.BLADE_BASE_URL || 'https://apis.iflow.cn/v1',
  modelName: process.env.BLADE_MODEL || 'Qwen3-Coder',
});
