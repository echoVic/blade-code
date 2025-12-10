/**
 * Prompts 模块入口
 * 导出系统提示相关的核心功能
 */

export type {
  BuildSystemPromptOptions,
  BuildSystemPromptResult,
} from './builder.js';
// 统一入口
export { buildSystemPrompt } from './builder.js';

// 常量和工具函数
export {
  createPlanModeReminder,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_CONFIG,
  PLAN_MODE_SYSTEM_PROMPT,
  type SystemPromptConfig,
} from './default.js';
