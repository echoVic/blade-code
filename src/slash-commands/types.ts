/**
 * Slash Command 类型定义
 */

export interface SlashCommandResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: any;
}

export interface SlashCommandContext {
  cwd: string;
  addUserMessage: (message: string) => void;
  addAssistantMessage: (message: string) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  fullDescription?: string;
  usage?: string;
  aliases?: string[];
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
