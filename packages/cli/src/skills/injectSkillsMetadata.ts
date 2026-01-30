/**
 * Skills 元数据注入
 *
 * 在工具函数声明中动态替换 <available_skills> 占位符。
 * 使用 Progressive Disclosure：仅注入元数据（name + description），不注入完整内容。
 */

import type { FunctionDeclaration } from '../tools/types/index.js';
import { getSkillRegistry } from './SkillRegistry.js';

/** Skill 工具名称 */
const SKILL_TOOL_NAME = 'Skill';

/** available_skills 占位符的正则表达式 */
const AVAILABLE_SKILLS_REGEX = /<available_skills>\s*<\/available_skills>/;

/**
 * 在工具函数声明列表中注入 Skills 元数据
 *
 * 查找 Skill 工具的描述，将 <available_skills></available_skills> 占位符
 * 替换为已发现的 skills 列表。
 *
 * @param tools - 工具函数声明列表
 * @returns 注入后的工具函数声明列表（新数组，不修改原数组）
 */
export function injectSkillsMetadata(
  tools: FunctionDeclaration[]
): FunctionDeclaration[] {
  const registry = getSkillRegistry();
  const skillsList = registry.generateAvailableSkillsList();

  // 如果没有发现任何 skills，返回原数组
  if (!skillsList) {
    return tools;
  }

  return tools.map((tool) => {
    // 只处理 Skill 工具
    if (tool.name !== SKILL_TOOL_NAME) {
      return tool;
    }

    // 替换 available_skills 占位符
    const newDescription = tool.description.replace(
      AVAILABLE_SKILLS_REGEX,
      `<available_skills>\n${skillsList}\n</available_skills>`
    );

    // 如果描述没有变化，返回原对象
    if (newDescription === tool.description) {
      return tool;
    }

    // 返回新的工具声明对象
    return {
      ...tool,
      description: newDescription,
    };
  });
}
