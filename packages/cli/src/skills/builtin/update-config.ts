/**
 * 内置 update-config Skill <p> 帮助 AI 配置 Blade 运行环境：settings、hooks、permissions 等。
 * 当用户请求自动化行为时自动激活。
 */

import type { SkillContent, SkillMetadata } from '../types.js';

/** update-config 的元数据 */
export const updateConfigMetadata: SkillMetadata = {
  name: 'update-config',
  description:
    '配置 Blade harness（settings/hooks/permissions）。' +
    '用户请求自动化行为时使用此 Skill。',
  allowedTools: ['ConfigTool', 'Read', 'Bash', 'AskUserQuestion'],
  version: '1.0.0',
  userInvocable: true,
  disableModelInvocation: false,
  whenToUse:
    '用户说"从现在起..."、"每次..."、"当...时..."、' +
    '需要改配置、安装 hooks、修改权限',
  path: 'builtin://update-config',
  basePath: '',
  source: 'builtin',
};

import updateConfigInstructions from './update-config.md?raw';

/** 获取 update-config 的完整内容 */
export function getUpdateConfigContent(): SkillContent {
  return {
    metadata: updateConfigMetadata,
    instructions: updateConfigInstructions,
  };
}
