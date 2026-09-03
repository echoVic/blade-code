/**
 * Slash Command 类型定义
 */

import type {
  ResumedSubagent,
  SessionMcpContentSnapshot,
} from '../agent/runtime/SessionRuntime.js';
import type { AgentSession } from '../agent/subagents/AgentSessionStore.js';
import type { SessionSurfaceSummary } from '../api/sessionSurfaceSchemas.js';
import type {
  McpCompletionInput,
  McpNormalizedCompletionResult,
} from '../mcp/McpCompletion.js';
import type { McpNormalizedPromptResult } from '../mcp/McpContentCatalog.js';
import type { McpLogLevel } from '../mcp/McpLogging.js';
import type { McpInstructionsSnapshot, McpLogSnapshot } from '../mcp/McpRegistry.js';
import type { McpTaskSnapshot } from '../mcp/McpTasks.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type {
  CommunicationStyleConfiguration,
  CommunicationStyleSelection,
} from '../services/communicationStyle.js';
import type {
  ReasoningEffortConfiguration,
  ReasoningEffortSelection,
} from '../services/pi/reasoningEffort.js';
import type {
  ResponseVerbosityConfiguration,
  ResponseVerbositySelection,
} from '../services/pi/responseVerbosity.js';
import type {
  ServiceTierConfiguration,
  ServiceTierSelection,
} from '../services/pi/serviceTier.js';
import type {
  RewindSessionOptions,
  RewoundSession,
  SessionMetadata,
  SessionRewindCheckpoint,
} from '../services/SessionService.js';
import type { SideConversationResult } from '../services/SideConversationService.js';
import { sessionActions } from '../store/vanilla.js';

export type SessionSelectionIntent = 'resume' | 'fork';
export type SessionSelectionCandidate = SessionMetadata | SessionSurfaceSummary;

export type SlashCommandWorkspaceKind = 'local' | 'acp-remote';

export const REMOTE_SAFE_SLASH_COMMAND_NAMES = Object.freeze([
  'help',
  'version',
  'btw',
  'effort',
  'speed',
  'verbosity',
  'style',
] as const);

const remoteSafeSlashCommandNames = new Set<string>(REMOTE_SAFE_SLASH_COMMAND_NAMES);

export function isRemoteSafeSlashCommandName(name: string): boolean {
  return remoteSafeSlashCommandNames.has(name);
}

export type SessionSelectionAction =
  | {
      action: 'select_session';
      intent: SessionSelectionIntent;
      sessions: SessionSelectionCandidate[];
    }
  | {
      action: 'activate_session';
      intent: SessionSelectionIntent;
      session: SessionSelectionCandidate;
    };

export type SlashCommandAction =
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
  | 'invoke_plugin_command'
  | 'invoke_mcp_prompt'
  | 'invoke_once_model'
  | 'restore_forked_session'
  | 'session_exported'
  | 'start_goal'
  | 'resume_goal'
  | 'goal_cleared'
  | 'rewind_session'
  | 'subagent_resumed'
  | 'show_side_conversation'
  | 'select_session'
  | 'activate_session';

/**
 * Slash command 返回的结构化数据
 */
export interface SlashCommandData {
  /** UI 指令（触发特定 UI 组件） */
  action?: SlashCommandAction;
  /** Session selection intent */
  intent?: SessionSelectionIntent;
  /** 模式（如 add/edit） */
  mode?: string;
  /** 压缩结果相关 */
  compactedMessages?: Message[];
  boundaryMessage?: unknown;
  summaryMessage?: unknown;
  preTokens?: number;
  postTokens?: number;
  filesIncluded?: string[];
  /** Resume 相关 */
  sessions?: SessionSelectionCandidate[];
  session?: SessionSelectionCandidate;
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
 * // [NOT RECOMMENDED]: 在 ACP 模式下会污染本地 store 但 IDE 看不到
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
  /** Immutable workspace ownership; callers default to local for compatibility. */
  workspaceKind?: SlashCommandWorkspaceKind;
  /** Owning user surface. Host interactions must fail closed when omitted. */
  surface?: 'tui' | 'headless' | 'acp';
  /** 当前 Agent session，用于隔离 session-owned runtime resources */
  sessionId?: string;
  /** 工作目录（可选，默认为 cwd） */
  workspaceRoot?: string;
  /** 当前调用方拥有的会话历史；ACP 等非 UI 表面应显式传入 */
  messages?: Message[];
  /** Lifecycle-owned, UI-safe Session history catalog boundary. */
  sessionSurfaces?: {
    list: () => Promise<SessionSurfaceSummary[]>;
  };
  /** 当前表面拥有的 session runtime rewind 边界 */
  rewind?: {
    listCheckpoints: () => Promise<SessionRewindCheckpoint[]>;
    execute: (options: RewindSessionOptions) => Promise<RewoundSession>;
  };
  /** Current surface-owned session lifecycle boundary. */
  lifecycle?: {
    archiveCurrent: () => Promise<SessionMetadata>;
  };
  /** 当前表面拥有的 Session reasoning configuration boundary。 */
  reasoning?: {
    get: () => Promise<ReasoningEffortConfiguration>;
    set: (selection: ReasoningEffortSelection) => Promise<ReasoningEffortConfiguration>;
  };
  /** 当前表面拥有的 Session provider service-tier boundary。 */
  serviceTier?: {
    get: () => Promise<ServiceTierConfiguration>;
    set: (selection: ServiceTierSelection) => Promise<ServiceTierConfiguration>;
  };
  /** 当前表面拥有的 Session response verbosity boundary。 */
  responseVerbosity?: {
    get: () => Promise<ResponseVerbosityConfiguration>;
    set: (
      selection: ResponseVerbositySelection
    ) => Promise<ResponseVerbosityConfiguration>;
  };
  /** 当前表面拥有的 Session communication-style boundary。 */
  communicationStyle?: {
    get: () => Promise<CommunicationStyleConfiguration>;
    set: (
      selection: CommunicationStyleSelection
    ) => Promise<CommunicationStyleConfiguration>;
  };
  /** Current surface-owned native read-only code review boundary. */
  codeReview?: {
    run: (
      request: {
        kind: 'uncommitted' | 'base' | 'commit';
        ref?: string;
        instructions?: string;
      },
      signal?: AbortSignal
    ) => Promise<{
      reviewId: string;
      status: 'completed' | 'stale' | 'failed' | 'aborted' | 'interrupted';
      findings: number;
      content: string;
    }>;
  };
  /** Current surface-owned ephemeral side conversation boundary. */
  sideConversation?: {
    ask: (question: string, signal?: AbortSignal) => Promise<SideConversationResult>;
  };
  /** 当前表面拥有的 durable subagent 控制边界 */
  subagents?: {
    list: () => Promise<AgentSession[]>;
    resume: (agentId: string, prompt: string) => Promise<ResumedSubagent>;
  };
  /** 当前 Session 私有 MCP content boundary。 */
  mcp?: {
    getCatalog: () => Promise<SessionMcpContentSnapshot>;
    refresh: (serverName?: string) => Promise<void>;
    getPrompt: (
      serverName: string,
      name: string,
      arguments_: Record<string, string>
    ) => Promise<McpNormalizedPromptResult>;
    complete: (
      serverName: string,
      input: McpCompletionInput,
      signal?: AbortSignal
    ) => Promise<McpNormalizedCompletionResult>;
    listTasks: (serverName?: string) => Promise<McpTaskSnapshot[]>;
    getTask: (taskId: string) => Promise<McpTaskSnapshot | undefined>;
    cancelTask: (
      taskId: string,
      signal?: AbortSignal
    ) => Promise<McpTaskSnapshot | undefined>;
    getLogs: (
      serverName?: string,
      options?: { afterRevision?: number; limit?: number }
    ) => Promise<McpLogSnapshot>;
    setLoggingLevel: (serverName: string, level: McpLogLevel) => Promise<void>;
    getInstructions: () => Promise<McpInstructionsSnapshot>;
  };
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
