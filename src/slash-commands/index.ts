/**
 * Slash Commands 注册和处理中心
 */

import Fuse from 'fuse.js';
import { builtinCommands } from './builtinCommands.js';
import gitCommand from './git.js';
import ideCommand from './ide.js';
import initCommand from './init.js';
import modelCommand from './model.js';
import permissionsCommand from './permissions.js';
import themeCommand from './theme.js';
import type {
  CommandSuggestion,
  SlashCommand,
  SlashCommandContext,
  SlashCommandRegistry,
  SlashCommandResult,
} from './types.js';

// 注册所有 slash commands
const slashCommands: SlashCommandRegistry = {
  ...builtinCommands,
  init: initCommand,
  theme: themeCommand,
  permissions: permissionsCommand,
  model: modelCommand,
  git: gitCommand,
  ide: ideCommand,
};

/**
 * 检测输入是否为 slash command
 */
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

/**
 * 解析 slash command
 */
export function parseSlashCommand(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error('不是有效的 slash command');
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0] || '';
  const args = parts.slice(1);

  return { command, args };
}

/**
 * 根据名称或别名查找命令
 */
function findCommand(name: string): SlashCommand | undefined {
  // 先按名称查找
  if (slashCommands[name]) {
    return slashCommands[name];
  }
  // 再按别名查找
  for (const cmd of Object.values(slashCommands)) {
    if (cmd.aliases?.includes(name)) {
      return cmd;
    }
  }
  return undefined;
}

/**
 * 执行 slash command
 */
export async function executeSlashCommand(
  input: string,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  try {
    const { command, args } = parseSlashCommand(input);

    // 查找命令（支持别名）
    const slashCommand = findCommand(command);
    if (!slashCommand) {
      return {
        success: false,
        error: `未知命令: /${command}\\n使用 /help 查看可用命令`,
      };
    }

    // 执行命令
    return await slashCommand.handler(args, context);
  } catch (error) {
    return {
      success: false,
      error: `命令执行失败: ${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}

/**
 * 获取所有注册的命令
 */
export function getRegisteredCommands(): SlashCommand[] {
  return Object.values(slashCommands);
}

/**
 * 注册新的 slash command
 */
export function registerSlashCommand(command: SlashCommand): void {
  slashCommands[command.name] = command;
}

/**
 * 获取命令补全建议（简单前缀匹配）
 */
export function getCommandSuggestions(partialCommand: string): string[] {
  const prefix = partialCommand.startsWith('/')
    ? partialCommand.slice(1)
    : partialCommand;
  const suggestions = Object.keys(slashCommands)
    .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((name) => `/${name}`);

  return suggestions;
}

/**
 * 获取模糊匹配的命令建议（使用 fuse.js）
 */
export function getFuzzyCommandSuggestions(input: string): CommandSuggestion[] {
  // 移除前导斜杠，并 trim 掉空格（用户可能输入 "/init " 然后按 Tab）
  const query = (input.startsWith('/') ? input.slice(1) : input).trim();

  // 准备搜索数据：将命令转换为可搜索的对象
  const searchableCommands = Object.values(slashCommands).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases || [],
    command: cmd,
  }));

  if (!query) {
    // 如果没有输入，返回所有命令
    return searchableCommands.map((item) => ({
      command: `/${item.name}`,
      description: item.description,
      matchScore: 50,
    }));
  }

  // 配置 Fuse.js
  const fuse = new Fuse(searchableCommands, {
    keys: [
      { name: 'name', weight: 3 }, // 命令名权重最高
      { name: 'aliases', weight: 2.5 }, // 别名权重次之
      { name: 'description', weight: 0.5 }, // 描述权重最低
    ],
    threshold: 0.4, // 匹配阈值（0 = 完全匹配，1 = 匹配任何东西）
    includeScore: true,
    ignoreLocation: true, // 忽略位置，只关注匹配度
    minMatchCharLength: 1,
  });

  // 执行搜索
  const results = fuse.search(query);

  // 转换为 CommandSuggestion 格式
  // Fuse.js 的 score 越低越好（0 = 完美匹配），我们需要反转为 0-100 的分数
  const suggestions: CommandSuggestion[] = results.map((result) => {
    const score = result.score ?? 1;
    const matchScore = Math.round((1 - score) * 100); // 转换为 0-100 分数

    return {
      command: `/${result.item.name}`,
      description: result.item.description,
      matchScore,
    };
  });

  // 过滤掉分数太低的结果（< 40 分）
  return suggestions.filter((s) => (s.matchScore || 0) >= 40);
}

export type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
