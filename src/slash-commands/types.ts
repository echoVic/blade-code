/**
 * Slash Command 类型定义
 */

export interface SlashCommandResult {
  success: boolean;
  message?: string; // 简短状态消息（如 "帮助信息已显示"）
  content?: string; // 完整内容（用于 ACP 模式显示给用户）
  error?: string;
  data?: any;
}

/**
 * Slash Command 上下文
 *
 * 注意：
 * - UI 状态操作（addUserMessage, addAssistantMessage 等）已迁移到 vanilla store
 * - 配置管理已迁移到 Store + configActions()
 *
 * Slash command 应直接使用：
 *   import { sessionActions, configActions } from '../store/vanilla.js';
 *   sessionActions().addAssistantMessage('...');
 *   configActions().updateConfig({ ... });
 */
export interface SlashCommandContext {
  cwd: string;
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
