/**
 * 内置 API Key 服务
 *
 * 从 Cloudflare Worker 代理服务获取真实的 API Key
 */

import { createLogger, LogCategory } from '../logging/Logger.js';
import { proxyFetch } from '../utils/proxyFetch.js';

const logger = createLogger(LogCategory.SERVICE);

const PROXY_URL = 'https://blade-api-proxy.137844255.workers.dev/v1/get-zhipu-key';
const BUILTIN_TOKEN = 'blade-free-tier';

interface ZhipuKeyResponse {
  apiKey: string;
  baseUrl: string;
  provider: string;
  model: string;
  message?: string;
}

let cachedApiKey: string | null = null;
let cachedBaseUrl: string | null = null;

/**
 * 从代理服务获取真实的智谱 API Key
 */
export async function resolveBuiltinApiKey(apiKey: string): Promise<string> {
  // 如果不是内置 token，直接返回
  if (apiKey !== BUILTIN_TOKEN) {
    return apiKey;
  }

  // 使用缓存
  if (cachedApiKey) {
    logger.debug('使用缓存的内置 API Key');
    return cachedApiKey;
  }

  try {
    logger.info('🔑 正在从代理服务获取内置 API Key...');

    const response = await proxyFetch(PROXY_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BUILTIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`获取 API Key 失败: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as ZhipuKeyResponse;

    if (!data.apiKey) {
      throw new Error('代理服务返回的数据中没有 apiKey');
    }

    cachedApiKey = data.apiKey;
    cachedBaseUrl = data.baseUrl;

    logger.info('✅ 成功获取内置 API Key');
    if (data.message) {
      logger.debug(`提示: ${data.message}`);
    }

    return cachedApiKey;
  } catch (error) {
    logger.error('❌ 获取内置 API Key 失败:', error);
    throw new Error(
      `无法获取内置模型的 API Key: ${error instanceof Error ? error.message : '未知错误'}\n` +
      '请检查网络连接或使用自己的 API Key (/config)'
    );
  }
}

/**
 * 获取缓存的 baseUrl（用于更新模型配置）
 */
export function getCachedBaseUrl(): string | null {
  return cachedBaseUrl;
}

/**
 * 清除缓存（用于测试或重新获取）
 */
export function clearBuiltinKeyCache(): void {
  cachedApiKey = null;
  cachedBaseUrl = null;
}

