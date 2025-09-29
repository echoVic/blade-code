/**
 * Slash Commands 注册和处理中心
 */

import { builtinCommands } from './builtin-commands.js';
import initCommand from './init.js';
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
 * 执行 slash command
 */
export async function executeSlashCommand(
  input: string,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  try {
    const { command, args } = parseSlashCommand(input);

    // 查找命令
    const slashCommand = slashCommands[command];
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
 * 计算字符串匹配分数
 */
function calculateMatchScore(input: string, target: string): number {
  const lowerInput = input.toLowerCase();
  const lowerTarget = target.toLowerCase();

  if (lowerTarget === lowerInput) return 100; // 完全匹配
  if (lowerTarget.startsWith(lowerInput)) return 80; // 前缀匹配
  if (lowerTarget.includes(lowerInput)) return 60; // 包含匹配

  // 模糊匹配：检查是否包含输入的所有字符（按顺序）
  let inputIndex = 0;
  for (let i = 0; i < lowerTarget.length && inputIndex < lowerInput.length; i++) {
    if (lowerTarget[i] === lowerInput[inputIndex]) {
      inputIndex++;
    }
  }

  if (inputIndex === lowerInput.length) return 40; // 模糊匹配
  return 0; // 无匹配
}

/**
 * 获取命令补全建议
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
 * 获取模糊匹配的命令建议
 */
export function getFuzzyCommandSuggestions(input: string): CommandSuggestion[] {
  const query = input.startsWith('/') ? input.slice(1) : input;

  if (!query) {
    // 如果没有输入，返回所有命令
    return Object.values(slashCommands).map((cmd) => ({
      command: `/${cmd.name}`,
      description: cmd.description,
      matchScore: 50,
    }));
  }

  const suggestions: CommandSuggestion[] = [];

  Object.values(slashCommands).forEach((cmd) => {
    // 检查命令名称匹配
    const nameScore = calculateMatchScore(query, cmd.name);

    // 检查描述匹配
    const descScore = calculateMatchScore(query, cmd.description) * 0.5;

    // 检查别名匹配
    let aliasScore = 0;
    if (cmd.aliases) {
      aliasScore = Math.max(
        ...cmd.aliases.map((alias) => calculateMatchScore(query, alias))
      );
    }

    const finalScore = Math.max(nameScore, descScore, aliasScore);

    if (finalScore > 0) {
      suggestions.push({
        command: `/${cmd.name}`,
        description: cmd.description,
        matchScore: finalScore,
      });
    }
  });

  // 按匹配分数排序
  return suggestions.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
}

export type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';
