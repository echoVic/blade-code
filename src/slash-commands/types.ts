/**
 * Slash Command 类型定义
 */

import { sessionActions } from '../store/vanilla.js';

type SlashCommandAction =
  | 'show_model_selector'
  | 'show_model_add_wizard'
  | 'show_agents_manager'
  | 'show_agent_creation_wizard'
  | 'show_theme_selector'
  | 'show_permissions_editor'
  | 'show_skills_manager'
  | 'show_hooks_manager'
  | 'show_plugins_manager'
  | 'invoke_skill'
  | 'invoke_custom_command'
  | 'invoke_plugin_command';

/**
 * Slash command 返回的结构化数据
 */
export interface SlashCommandData {
  /** UI 指令（触发特定 UI 组件） */
  action?: SlashCommandAction;
  /** 模式（如 add/edit） */
  mode?: string;
  /** 压缩结果相关 */
  compactedMessages?: unknown[];
  boundaryMessage?: unknown;
  summaryMessage?: unknown;
  preTokens?: number;
  postTokens?: number;
  filesIncluded?: string[];
  /** Resume 相关 */
  sessions?: unknown[];
  selectedSession?: unknown;
  /** 扩展字段（用于未来新增的数据类型） */
  [key: string]: unknown;
}

export interface SlashCommandResult {
  success: boolean;
  message?: string; // 简短状态消息（如 "帮助信息已显示"）
  content?: string; // 完整内容（用于 ACP 模式显示给用户）
  error?: string;
  data?: SlashCommandData;
}

/**
 * ACP 模式下的回调接口
 *
 * 当 slash command 在 ACP 模式下执行时，使用这些回调将输出发送给 IDE
 */
export interface AcpCallbacks {
  /** 发送文本消息给 IDE */
  sendMessage: (text: string) => void;
  /** 发送工具调用开始通知 */
  sendToolStart?: (
    toolName: string,
    params: Record<string, unknown>,
    toolKind?: 'readonly' | 'write' | 'execute'
  ) => void;
  /** 发送工具调用结果通知 */
  sendToolResult?: (
    toolName: string,
    result: { success: boolean; summary?: string }
  ) => void;
}

/**
 * Slash Command 上下文
 *
 * ## 输出方式迁移指南
 *
 * **推荐方式**（兼容 CLI 和 ACP）：
 * ```ts
 * import { getUI } from './types.js';
 *
 * const ui = getUI(context);
 * ui.sendMessage('Hello!');
 * ```
 *
 * **旧方式**（仅 CLI，ACP 模式下 IDE 收不到输出）：
 * ```ts
 * // ❌ 不推荐：在 ACP 模式下会污染本地 store 但 IDE 看不到
 * sessionActions().addAssistantMessage('...');
 * ```
 *
 * ## 迁移状态
 *
 * 已迁移：/init, /help, /version, /status
 * 待迁移：/git, /mcp, /agents, /compact, /resume, /config, /context, /cost 等
 */
export interface SlashCommandContext {
  cwd: string;
  /** 工作目录（可选，默认为 cwd） */
  workspaceRoot?: string;
  /** ACP 模式下的回调（可选） */
  acp?: AcpCallbacks;
  /** 取消信号（可选，用于中止长时间运行的操作） */
  signal?: AbortSignal;
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

/**
 * 统一的 UI 输出接口
 *
 * 抽象了 CLI 和 ACP 两种输出模式的差异，slash command 应使用此接口发送消息。
 */
export interface SlashCommandUI {
  /** 发送消息（自动处理换行） */
  sendMessage: (text: string) => void;
  /** 发送工具调用开始通知（可选） */
  sendToolStart?: (
    toolName: string,
    params: Record<string, unknown>,
    toolKind?: 'readonly' | 'write' | 'execute'
  ) => void;
  /** 发送工具调用结果通知（可选） */
  sendToolResult?: (
    toolName: string,
    result: { success: boolean; summary?: string }
  ) => void;
}

/**
 * 从 context 获取统一的 UI 输出接口
 *
 * 优先使用 ACP 回调（IDE 模式），否则回退到 CLI store。
 * 所有 slash command 应使用此函数获取输出接口，而不是直接调用 sessionActions()。
 *
 * @example
 * ```ts
 * const ui = getUI(context);
 * ui.sendMessage('Hello!');
 * ```
 */
export function getUI(context: SlashCommandContext): SlashCommandUI {
  if (context.acp) {
    return {
      sendMessage: (text: string) => context.acp!.sendMessage(`• ${text}\n\n`),
      sendToolStart: context.acp.sendToolStart,
      sendToolResult: context.acp.sendToolResult,
    };
  }

  // CLI 模式：使用 store actions
  return {
    sendMessage: (text: string) => sessionActions().addAssistantMessage(text),
    sendToolStart: undefined,
    sendToolResult: undefined,
  };
}
