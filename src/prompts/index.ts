/**
 * Prompts 模块入口
 * 导出系统提示相关的核心功能
 */

export { defaultPromptBuilder, PromptBuilder } from './builder.js';
export type { PromptBuilderOptions } from './builder.js';
export {
  createPlanModeReminder,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_CONFIG,
  PLAN_MODE_SYSTEM_PROMPT,
  type SystemPromptConfig,
} from './default.js';
export { SystemPrompt } from './SystemPrompt.js';
export type {
  SystemPromptOptions,
  SystemPromptSource,
} from './SystemPrompt.js';
