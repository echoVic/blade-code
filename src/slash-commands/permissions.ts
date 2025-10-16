/**
 * /permissions 命令 - 交互式权限管理器
 */

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

async function permissionsCommandHandler(
  _args: string[],
  _context: SlashCommandContext
): Promise<SlashCommandResult> {
  return {
    success: true,
    message: 'show_permissions_manager',
    data: {
      action: 'show_permissions_manager',
    },
  };
}

const permissionsCommand: SlashCommand = {
  name: 'permissions',
  description: '管理项目的本地权限规则',
  fullDescription: '打开权限管理器，管理 .blade/settings.local.json 中的权限规则',
  usage: '/permissions',
  aliases: ['perm'],
  category: 'ui',
  handler: permissionsCommandHandler,
};

export default permissionsCommand;
