/**
 * Agent 创建器
 * 提供简单的 Agent 实例创建函数
 */

import { ConfigManager } from '../config/config-manager.js';
import { Agent } from './Agent.js';
import type { AgentConfig } from './types.js';

export interface AgentOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
}

/**
 * 创建新的Agent实例
 */
export async function createAgent(options: AgentOptions = {}): Promise<Agent> {
  // 构建Agent配置
  const config = await buildAgentConfig(options);

  // 创建新的Agent实例
  const agent = new Agent(config);
  await agent.initialize();

  return agent;
}

/**
 * 构建Agent配置
 */
async function buildAgentConfig(options: AgentOptions): Promise<AgentConfig> {
    // 获取全局配置
    let globalConfig;
    try {
      const configManager = new ConfigManager();
      await configManager.initialize();
      globalConfig = configManager.getConfig();
    } catch (_error) {
      console.warn('获取全局配置失败，使用默认值');
      globalConfig = null;
    }

    // 优先级：选项参数 > 环境变量 > 全局配置 > 默认值
    const apiKey =
      options.apiKey || process.env.BLADE_API_KEY || globalConfig?.auth?.apiKey || '';

    const baseUrl =
      options.baseUrl || process.env.BLADE_BASE_URL || globalConfig?.auth?.baseUrl || '';

    const model =
      options.model ||
      process.env.BLADE_MODEL ||
      globalConfig?.auth?.modelName ||
      'Qwen3-Coder';

    // 验证必需配置
    if (!apiKey) {
      throw new Error('缺少 API 密钥。请通过参数、环境变量或配置文件提供。');
    }

    if (!baseUrl) {
      throw new Error('缺少 API 基础 URL。请通过参数、环境变量或配置文件提供。');
    }

    return {
      chat: {
        apiKey,
        baseUrl,
        model,
      },
      systemPrompt: options.systemPrompt,
    };
}
