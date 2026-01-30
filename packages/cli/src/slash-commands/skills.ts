/**
 * /skills 命令 - 查看所有可用的 Skills
 */

import { getSkillRegistry } from '../skills/index.js';
import { sessionActions } from '../store/vanilla.js';
import type { SlashCommand, SlashCommandResult } from './types.js';

const skillsCommand: SlashCommand = {
  name: 'skills',
  description: '查看所有可用的 Skills',
  fullDescription:
    '显示所有已发现的 Skills 及其详细信息，包括名称、描述、来源和允许的工具。',
  usage: '/skills',
  category: 'system',
  examples: ['/skills'],

  handler: async (_args, _context): Promise<SlashCommandResult> => {
    try {
      // 刷新 SkillRegistry，重新扫描所有 skills 目录
      // 这样新创建的 Skill 会被发现
      const registry = getSkillRegistry();
      await registry.refresh();

      // 显示 Skills 管理面板
      return {
        success: true,
        message: 'show_skills_manager',
        data: { action: 'show_skills_manager' },
      };
    } catch (error) {
      const errorMessage = `获取 Skills 失败: ${error instanceof Error ? error.message : '未知错误'}`;
      sessionActions().addAssistantMessage(errorMessage);
      return { success: false, error: errorMessage };
    }
  },
};

export default skillsCommand;
