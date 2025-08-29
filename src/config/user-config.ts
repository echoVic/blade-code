/**
 * 用户配置管理模块
 * 用于保存和读取用户的首选设置
 */

import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { LoggerComponent } from '../agent/LoggerComponent.js';

/**
 * 用户配置接口
 */
export interface UserConfig {
  currentProvider?: 'qwen' | 'volcengine';
  currentModel?: string;
  lastUpdated?: string;
}

/**
 * 配置文件路径
 */
const CONFIG_FILE_PATH = join(homedir(), '.blade-config.json');

/**
 * 全局日志实例
 */
const logger = new LoggerComponent('user-config');

/**
 * 默认用户配置
 */
const DEFAULT_USER_CONFIG: UserConfig = {
  currentProvider: 'qwen',
  currentModel: undefined,
  lastUpdated: new Date().toISOString(),
};

/**
 * 读取用户配置
 */
export function getUserConfig(): UserConfig {
  try {
    if (!existsSync(CONFIG_FILE_PATH)) {
      return DEFAULT_USER_CONFIG;
    }

    const configContent = readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const config = JSON.parse(configContent) as UserConfig;

    // 确保配置完整
    return {
      ...DEFAULT_USER_CONFIG,
      ...config,
    };
  } catch (error) {
    logger.warn('读取用户配置失败，使用默认配置', { error: (error as Error).message });
    return DEFAULT_USER_CONFIG;
  }
}

/**
 * 保存用户配置
 */
export function saveUserConfig(config: Partial<UserConfig>): void {
  try {
    const currentConfig = getUserConfig();
    const newConfig: UserConfig = {
      ...currentConfig,
      ...config,
      lastUpdated: new Date().toISOString(),
    };

    writeFileSync(CONFIG_FILE_PATH, JSON.stringify(newConfig, null, 2));
  } catch (error) {
    throw new Error(`保存用户配置失败: ${error}`);
  }
}

/**
 * 设置当前 provider
 */
export function setCurrentProvider(provider: 'qwen' | 'volcengine'): void {
  // 导入默认配置以获取默认模型
  const { getProviderConfig } = require('./defaults.js');
  const providerConfig = getProviderConfig(provider);

  saveUserConfig({
    currentProvider: provider,
    currentModel: providerConfig.defaultModel,
  });
  logger.info(`已设置当前 LLM 提供商为: ${provider}`, { component: 'user-config', action: 'setCurrentProvider' });
  logger.info(`已自动设置模型为: ${providerConfig.defaultModel}`, { component: 'user-config', action: 'setCurrentProvider' });
}

/**
 * 设置当前模型
 */
export function setCurrentModel(provider: 'qwen' | 'volcengine', model: string): void {
  saveUserConfig({
    currentProvider: provider,
    currentModel: model,
  });
  logger.info(`已设置当前模型为: ${model} (${provider})`, { component: 'user-config', action: 'setCurrentModel' });
}

/**
 * 获取当前 provider（优先级：用户配置 > 默认值）
 */
export function getCurrentProvider(): 'qwen' | 'volcengine' {
  const config = getUserConfig();
  return config.currentProvider || 'qwen';
}

/**
 * 获取当前模型
 */
export function getCurrentModel(provider?: 'qwen' | 'volcengine'): string | undefined {
  const config = getUserConfig();
  const targetProvider = provider || config.currentProvider;

  // 如果指定了模型且provider匹配，返回该模型
  if (config.currentModel && config.currentProvider === targetProvider) {
    return config.currentModel;
  }

  return undefined;
}

/**
 * 重置用户配置
 */
export function resetUserConfig(): void {
  saveUserConfig(DEFAULT_USER_CONFIG);
  logger.info('已重置用户配置为默认值', { component: 'user-config', action: 'resetUserConfig' });
}

/**
 * 显示当前配置
 */
export function showCurrentConfig(): void {
  const config = getUserConfig();

  logger.info('当前配置:', { 
    component: 'user-config', 
    action: 'showCurrentConfig',
    provider: config.currentProvider || '未设置',
    model: config.currentModel || '使用默认模型',
    lastUpdated: config.lastUpdated || '未知',
    configFilePath: CONFIG_FILE_PATH
  });
}
