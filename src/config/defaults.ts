/**
 * 默认配置模块
 * 管理 LLM 的默认配置参数
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// 获取当前模块的目录路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载config.env文件
function loadConfigFile(): void {
  // 尝试多个可能的配置文件路径
  const possiblePaths = [
    join(process.cwd(), 'config.env'), // 当前工作目录
    join(__dirname, '..', '..', 'config.env'), // 源码结构
    join(__dirname, '..', '..', '..', 'config.env'), // 构建后结构
  ];

  for (const configPath of possiblePaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine && !trimmedLine.startsWith('#')) {
            const [key, ...valueParts] = trimmedLine.split('=');
            if (key && valueParts.length > 0) {
              const value = valueParts.join('=').trim();
              // 只设置还没有的环境变量
              if (!process.env[key.trim()]) {
                process.env[key.trim()] = value;
              }
            }
          }
        }
        console.log(`✅ 已加载配置文件: ${configPath}`);
        break; // 找到第一个存在的配置文件后就停止搜索
      } catch (error) {
        console.warn(`Warning: Failed to load config file ${configPath}`);
      }
    }
  }
}

// 在模块加载时自动加载配置文件
loadConfigFile();

export interface LLMProviderConfig {
  apiKey: string;
  defaultModel: string;
  baseURL?: string;
  supportedModels: string[];
  modelDescriptions?: Record<string, string>;
}

export interface DefaultConfig {
  llm: {
    qwen: LLMProviderConfig;
    volcengine: LLMProviderConfig;
  };
}

/**
 * 默认配置
 * 注意：API密钥必须通过环境变量或--api-key参数提供
 */
export const DEFAULT_CONFIG: DefaultConfig = {
  llm: {
    qwen: {
      apiKey: process.env.QWEN_API_KEY || '',
      defaultModel: process.env.QWEN_DEFAULT_MODEL || 'qwen-plus-2025-04-28',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      supportedModels: [
        'qwen3-235b-a22b',
        'qwen-plus-latest',
        'qwen-turbo-latest',
        'qwen-turbo-2025-04-28',
        'qwen-plus-2025-04-28',
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
      apiKey: process.env.VOLCENGINE_API_KEY || '',
      defaultModel: process.env.VOLCENGINE_DEFAULT_MODEL || 'ep-20250612135125-br9k7',
      baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
      supportedModels: [
        'ep-20250417144747-rgffm', // Doubao-1.5-thinking-pro
        'ep-20250530171307-rrcc5', // DeepSeek R1 250528
        'ep-20250530171222-q42h8', // DeepSeek V3
        'ep-20250612135125-br9k7', // Doubao-Seed-1.6-thinking
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
        apiKey: process.env.QWEN_API_KEY || '',
        defaultModel: process.env.QWEN_DEFAULT_MODEL || DEFAULT_CONFIG.llm.qwen.defaultModel,
        baseURL: process.env.QWEN_BASE_URL || DEFAULT_CONFIG.llm.qwen.baseURL,
        supportedModels: DEFAULT_CONFIG.llm.qwen.supportedModels,
      },
      volcengine: {
        apiKey: process.env.VOLCENGINE_API_KEY || '',
        defaultModel:
          process.env.VOLCENGINE_DEFAULT_MODEL || DEFAULT_CONFIG.llm.volcengine.defaultModel,
        baseURL: process.env.VOLCENGINE_BASE_URL || DEFAULT_CONFIG.llm.volcengine.baseURL,
        supportedModels: DEFAULT_CONFIG.llm.volcengine.supportedModels,
      },
    },
  };
}

/**
 * 验证API密钥是否存在
 */
export function validateApiKey(provider: 'qwen' | 'volcengine', apiKey?: string): string {
  // 优先使用传入的apiKey
  if (apiKey) {
    return apiKey;
  }

  // 然后检查环境变量
  const config = getProviderConfig(provider);
  if (config.apiKey) {
    return config.apiKey;
  }

  // 如果都没有，抛出错误
  throw new Error(
    `${provider} API密钥未配置。请通过以下方式之一提供API密钥：\n` +
      `1. 使用 --api-key 参数\n` +
      `2. 设置环境变量 ${provider.toUpperCase()}_API_KEY\n` +
      `3. 在 .env 文件中配置`
  );
}

/**
 * 模型说明映射
 */
export const MODEL_DESCRIPTIONS = {
  // Qwen 模型说明
  qwen: {
    'qwen3-235b-a22b': '通义千问3-235B-A22B',
    'qwen-plus-latest': '通义千问-Plus-Latest (Qwen3)',
    'qwen-turbo-latest': '通义千问-Turbo-Latest (Qwen3)',
    'qwen-turbo-2025-04-28': '通义千问-Turbo-2025-04-28 (1M上下文)',
    'qwen-plus-2025-04-28': '通义千问-Plus-2025-04-28 (128K上下文) (默认)',
    'qwen-max-latest': '通义千问-Max-Latest (Qwen3)',
    'qwen-max-longcontext': '通义千问-Max-长上下文',
    'qwen-72b-chat': '通义千问-72B-Chat',
    'qwen-14b-chat': '通义千问-14B-Chat',
    'qwen-7b-chat': '通义千问-7B-Chat',
    'qwen-1.8b-chat': '通义千问-1.8B-Chat',
    'qwen-32b-chat': '通义千问-32B-Chat',
    'qwen-vl-plus': '通义千问-VL-Plus (视觉)',
    'qwen-vl-max': '通义千问-VL-Max (视觉)',
    'qwen-audio-chat': '通义千问-Audio-Chat (音频)',
    'qwen-coder-plus': '通义千问-Coder-Plus (代码)',
  },
  // VolcEngine 模型说明
  volcengine: {
    'ep-20250417144747-rgffm': 'Doubao-1.5-thinking-pro',
    'ep-20250530171307-rrcc5': 'DeepSeek R1 250528',
    'ep-20250530171222-q42h8': 'DeepSeek V3',
    'ep-20250612135125-br9k7': 'Doubao-Seed-1.6-thinking',
  },
} as const;

/**
 * 获取模型说明
 */
export function getModelDescription(provider: 'qwen' | 'volcengine', modelId: string): string {
  const descriptions = MODEL_DESCRIPTIONS[provider];
  return descriptions[modelId as keyof typeof descriptions] || modelId;
}

/**
 * 获取所有模型及其说明
 */
export function getModelsWithDescriptions(
  provider: 'qwen' | 'volcengine'
): Array<{ id: string; description: string }> {
  const config = getProviderConfig(provider);
  return config.supportedModels.map(modelId => ({
    id: modelId,
    description: getModelDescription(provider, modelId),
  }));
}
