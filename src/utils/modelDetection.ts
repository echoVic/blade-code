/**
 * 模型能力检测工具
 * 用于自动检测模型是否支持特定功能（如 thinking/reasoning）
 */

import type { ModelConfig } from '../config/types.js';

/**
 * 支持 thinking/reasoning 的模型名称模式
 */
const THINKING_MODEL_PATTERNS = [
  // DeepSeek
  /deepseek.*r1/i, // DeepSeek R1
  /deepseek.*reasoner/i, // DeepSeek Reasoner
  // OpenAI
  /o1-preview/i, // OpenAI o1-preview
  /o1-mini/i, // OpenAI o1-mini
  /o1/i, // OpenAI o1
  // 通义千问
  /qwen.*qwq/i, // 通义千问 QwQ (thinking model)
  /qwen.*think/i, // 通义千问 thinking 系列
  // Kimi (月之暗面)
  /kimi.*k1/i, // Kimi k1
  /moonshot.*think/i, // Moonshot thinking 系列
  /k1-32k/i, // k1-32k-preview 等
  // 豆包 (Doubao)
  /doubao.*think/i, // 豆包 thinking 系列
  /doubao.*pro.*think/i, // doubao-pro-thinking
  // Claude
  /claude.*opus.*4/i, // Claude Opus 4 支持 extended thinking
  // 智谱 GLM
  /glm-4\.7/i, // GLM-4.7 (thinking model)
];

/**
 * 根据模型名称自动检测是否支持 thinking
 *
 * @param modelName 模型名称（如 "deepseek-r1", "o1-preview"）
 * @returns 是否支持 thinking
 */
export function detectThinkingSupport(modelName: string): boolean {
  return THINKING_MODEL_PATTERNS.some((pattern) => pattern.test(modelName));
}

/**
 * 获取模型的 thinking 配置
 * 优先使用用户手动配置，其次使用自动检测结果
 *
 * @param model ModelConfig 配置
 * @returns thinking 配置
 */
export function getThinkingConfig(model: ModelConfig): {
  supportsThinking: boolean;
  thinkingBudget?: number;
} {
  // 用户显式配置优先
  if (model.supportsThinking !== undefined) {
    return {
      supportsThinking: model.supportsThinking,
      thinkingBudget: model.thinkingBudget,
    };
  }

  // 自动检测
  return {
    supportsThinking: detectThinkingSupport(model.model),
    thinkingBudget: undefined,
  };
}

/**
 * 检查当前模型是否为 thinking 模型
 *
 * @param model ModelConfig 配置
 * @returns 是否为 thinking 模型
 */
export function isThinkingModel(model: ModelConfig): boolean {
  return getThinkingConfig(model).supportsThinking;
}
