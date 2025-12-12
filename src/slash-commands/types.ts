/**
 * Slash Command 类型定义
 */

import type { ConfigManager } from '../config/ConfigManager.js';

export interface SlashCommandResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: any;
}

/**
 * Slash Command 上下文
 *
 * 注意：UI 状态操作（addUserMessage, addAssistantMessage 等）
 * 已迁移到 vanilla store，slash command 应直接使用：
 *
 * import { sessionActions } from '../store/vanilla.js';
 * sessionActions().addAssistantMessage('...');
 */
export interface SlashCommandContext {
  cwd: string;
  configManager?: ConfigManager;
}

export interface SlashCommand {
  name: string;
  description: string;
  fullDescription?: string;
  usage?: string;
  aliases?: string[];
  category?: string;
  examples?: string[];
  handler: (
    args: string[],
    context: SlashCommandContext
  ) => Promise<SlashCommandResult>;
}

export interface CommandSuggestion {
  command: string;
  description: string;
  highlighted?: boolean;
  matchScore?: number;
}

export type SlashCommandRegistry = Record<string, SlashCommand>;
