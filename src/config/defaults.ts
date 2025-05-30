/**
 * 默认配置模块
 * 管理 LLM 的默认配置参数
 */

export interface LLMProviderConfig {
  apiKey: string;
  defaultModel: string;
  baseURL?: string;
  supportedModels: string[];
}

export interface DefaultConfig {
  llm: {
    qwen: LLMProviderConfig;
    volcengine: LLMProviderConfig;
  };
}

/**
 * 默认配置
 * 基于测试成功的配置设定
 */
export const DEFAULT_CONFIG: DefaultConfig = {
  llm: {
    qwen: {
      apiKey: process.env.QWEN_API_KEY || 'sk-c23da72a37234d68af0b48fc6d685e8b',
      defaultModel: process.env.QWEN_DEFAULT_MODEL || 'qwen3-235b-a22b',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      supportedModels: [
        'qwen3-235b-a22b',
        'qwen-plus-latest',
        'qwen-turbo-latest',
        'qwen-max-latest',
        'qwen-max-longcontext',
        'qwen-72b-chat',
        'qwen-14b-chat',
        'qwen-7b-chat',
        'qwen-1.8b-chat',
        'qwen-32b-chat',
        'qwen-vl-plus',
        'qwen-vl-max',
        'qwen-audio-chat',
        'qwen-coder-plus',
      ],
    },
    volcengine: {
      apiKey: process.env.VOLCENGINE_API_KEY || '1ddfaee1-1350-46b0-ab87-2db988d24d4b',
      defaultModel: process.env.VOLCENGINE_DEFAULT_MODEL || 'ep-20250417144747-rgffm',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      supportedModels: [
        'ep-20250417144747-rgffm',
        'ep-20250530171307-rrcc5', // DeepSeek R1 250528
        'ep-20250530171222-q42h8', // DeepSeek V3
      ],
    },
  },
};

/**
 * 获取指定提供商的配置
 */
export function getProviderConfig(provider: 'qwen' | 'volcengine'): LLMProviderConfig {
  const config = DEFAULT_CONFIG.llm[provider];
  if (!config) {
    throw new Error(`不支持的 LLM 提供商: ${provider}`);
  }
  return config;
}

/**
 * 获取所有支持的提供商列表
 */
export function getSupportedProviders(): string[] {
  return Object.keys(DEFAULT_CONFIG.llm);
}

/**
 * 检查提供商是否受支持
 */
export function isProviderSupported(provider: string): provider is 'qwen' | 'volcengine' {
  return getSupportedProviders().includes(provider);
}

/**
 * 从环境变量加载配置
 */
export function loadConfigFromEnv(): Partial<DefaultConfig> {
  return {
    llm: {
      qwen: {
        apiKey: process.env.QWEN_API_KEY || DEFAULT_CONFIG.llm.qwen.apiKey,
        defaultModel: process.env.QWEN_DEFAULT_MODEL || DEFAULT_CONFIG.llm.qwen.defaultModel,
        baseURL: process.env.QWEN_BASE_URL || DEFAULT_CONFIG.llm.qwen.baseURL,
        supportedModels: DEFAULT_CONFIG.llm.qwen.supportedModels,
      },
      volcengine: {
        apiKey: process.env.VOLCENGINE_API_KEY || DEFAULT_CONFIG.llm.volcengine.apiKey,
        defaultModel:
          process.env.VOLCENGINE_DEFAULT_MODEL || DEFAULT_CONFIG.llm.volcengine.defaultModel,
        baseURL: process.env.VOLCENGINE_BASE_URL || DEFAULT_CONFIG.llm.volcengine.baseURL,
        supportedModels: DEFAULT_CONFIG.llm.volcengine.supportedModels,
      },
    },
  };
}
