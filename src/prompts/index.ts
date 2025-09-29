/**
 * Prompts 模块入口
 * 导出系统提示相关的核心功能
 */

export { SystemPrompt } from './SystemPrompt.js';
export { PromptBuilder, defaultPromptBuilder } from './builder.js';
export {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_CONFIG,
  type SystemPromptConfig,
} from './default.js';

export type {
  SystemPromptSource,
  SystemPromptOptions,
} from './SystemPrompt.js';

export type {
  PromptBuilderOptions,
} from './builder.js';