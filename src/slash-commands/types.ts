/**
 * Slash Command 类型定义
 */

import type { ConfigManager } from '../config/ConfigManager.js';
import type { SessionMessage } from '../ui/contexts/SessionContext.js';

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
  configManager?: ConfigManager;
  // 会话恢复相关
  restoreSession?: (sessionId: string, messages: SessionMessage[]) => void;
  sessionId?: string;
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
