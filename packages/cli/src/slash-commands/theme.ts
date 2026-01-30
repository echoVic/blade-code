/**
 * /theme 命令 - 交互式主题选择器
 */

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

/**
 * 主题命令处理函数
 * 直接触发主题选择器的显示
 */
async function themeCommandHandler(
  _args: string[],
  _context: SlashCommandContext
): Promise<SlashCommandResult> {
  // 触发显示主题选择器的信号
  return {
    success: true,
    message: 'show_theme_selector', // 特殊标记
    data: {
      action: 'show_theme_selector',
    },
  };
}

/**
 * Theme 命令定义
 */
const themeCommand: SlashCommand = {
  name: 'theme',
  description: '打开交互式主题选择器',
  aliases: ['themes', 'style'],
  usage: '/theme',
  examples: ['/theme'],
  category: 'ui',
  handler: themeCommandHandler,
};

export default themeCommand;
