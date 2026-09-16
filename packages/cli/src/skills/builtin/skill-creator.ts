/**
 * 内置 skill-creator Skill <p> 帮助用户交互式创建新的 Blade Skills。 对齐 Claude Code 的 skill-creator
 * 实现。
 */

import type { SkillContent, SkillMetadata } from '../types.js';

/** skill-creator 的元数据 */
export const skillCreatorMetadata: SkillMetadata = {
  name: 'skill-creator',
  description:
    'Create new Skills interactively. Use when the user wants to create a new Skill, define a custom workflow, or add a specialized capability to Blade.',
  allowedTools: ['Read', 'Write', 'Glob', 'Bash', 'AskUserQuestion'],
  version: '1.0.0',
  argumentHint: undefined,
  userInvocable: true, // 允许用户通过 /skill-creator 调用
  disableModelInvocation: false, // AI 可以自动调用
  model: undefined,
  whenToUse:
    'User wants to create a new skill, define a custom workflow, or add a specialized capability.',
  path: 'builtin://skill-creator',
  basePath: '',
  source: 'builtin',
};

import skillCreatorInstructions from './skill-creator.md?raw';

/** 获取 skill-creator 的完整内容 */
export function getSkillCreatorContent(): SkillContent {
  return {
    metadata: skillCreatorMetadata,
    instructions: skillCreatorInstructions,
  };
}
