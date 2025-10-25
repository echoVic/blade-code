/**
 * Prompts 模块入口
 * 导出系统提示相关的核心功能
 */

export type { PromptBuilderOptions } from './builder.js';
export { defaultPromptBuilder, PromptBuilder } from './builder.js';
export {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_CONFIG,
  PLAN_MODE_SYSTEM_PROMPT,
  createPlanModeReminder,
  type SystemPromptConfig,
} from './default.js';

export type {
  SystemPromptOptions,
  SystemPromptSource,
} from './SystemPrompt.js';
export { SystemPrompt } from './SystemPrompt.js';
