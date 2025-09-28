/**
 * Agent工厂 - 统一Agent创建和管理
 */

import { ConfigService } from '../config/ConfigService.js';
import { Agent } from './Agent.js';
import type { AgentConfig } from './types.js';

export interface AgentOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export class AgentFactory {
  private static instance: AgentFactory;
  private agents = new Map<string, Agent>();
  private configService: ConfigService;

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): AgentFactory {
    if (!AgentFactory.instance) {
      AgentFactory.instance = new AgentFactory();
    }
    return AgentFactory.instance;
  }

  /**
   * 创建或获取Agent实例
   */
  public async createAgent(options: AgentOptions = {}): Promise<Agent> {
    // 构建Agent配置
    const config = await this.buildAgentConfig(options);

    // 使用配置的hash作为缓存键
    const cacheKey = this.getCacheKey(config);

    // 检查是否已有相同配置的Agent
    if (this.agents.has(cacheKey)) {
      return this.agents.get(cacheKey)!;
    }

    // 创建新的Agent
    const agent = new Agent(config);
    await agent.initialize();

    // 缓存Agent实例
    this.agents.set(cacheKey, agent);

    return agent;
  }

  /**
   * 构建Agent配置
   */
  private async buildAgentConfig(options: AgentOptions): Promise<AgentConfig> {
    // 获取全局配置
    let globalConfig;
    try {
      await this.configService.initialize();
      globalConfig = this.configService.getConfig();
    } catch (_error) {
      console.warn('获取全局配置失败，使用默认值');
      globalConfig = null;
    }

    // 优先级：选项参数 > 环境变量 > 全局配置 > 默认值
    const apiKey =
      options.apiKey || process.env.BLADE_API_KEY || globalConfig?.auth.apiKey || '';

    const baseUrl =
      options.baseUrl || process.env.BLADE_BASE_URL || globalConfig?.auth.baseUrl || '';

    const model =
      options.model ||
      process.env.BLADE_MODEL ||
      globalConfig?.auth.modelName ||
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
    };
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(config: AgentConfig): string {
    const key = `${config.chat.apiKey}_${config.chat.baseUrl}_${config.chat.model}`;
    return Buffer.from(key).toString('base64').slice(0, 16);
  }

  /**
   * 清理所有Agent实例
   */
  public async cleanup(): Promise<void> {
    for (const [key, agent] of this.agents.entries()) {
      try {
        // 如果Agent有cleanup方法，调用它
        if (
          'cleanup' in agent &&
          typeof (agent as { cleanup?: () => Promise<void> }).cleanup === 'function'
        ) {
          await (agent as { cleanup: () => Promise<void> }).cleanup();
        }
      } catch (error) {
        console.warn(`清理Agent失败: ${key}`, error);
      }
    }
    this.agents.clear();
  }

  /**
   * 获取Agent实例数量
   */
  public getAgentCount(): number {
    return this.agents.size;
  }
}
