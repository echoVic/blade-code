import {
  type CommunicationStyleSelection,
  PermissionMode,
  type ReasoningEffortSelection,
  type ResponseVerbositySelection,
  type ServiceTierSelection,
} from '../../config/types.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { WorktreeSession } from '../../worktree/WorktreeManager.js';
import type { VerificationVerdict } from '../loop/independentVerification.js';
import type { LoopEvent } from '../loop/types.js';
import type { SubagentIsolationMode } from './SubagentWorktreeLifecycle.js';
export type ClaudeCodePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan'
  | 'ignore';

/**
 * 将 Claude Code permissionMode 映射到 Blade PermissionMode
 *
 * 映射关系：
 * - default -> DEFAULT (默认模式)
 * - acceptEdits -> AUTO_EDIT (自动接受编辑)
 * - dontAsk -> YOLO (不询问直接执行)
 * - bypassPermissions -> YOLO (绕过权限检查)
 * - plan -> PLAN (计划模式)
 * - ignore -> DEFAULT (忽略，使用默认)
 */
export function mapClaudeCodePermissionMode(
  mode: ClaudeCodePermissionMode | undefined
): PermissionMode {
  switch (mode) {
    case 'default':
    case 'ignore':
    case undefined:
      return PermissionMode.DEFAULT;
    case 'acceptEdits':
      return PermissionMode.AUTO_EDIT;
    case 'dontAsk':
    case 'bypassPermissions':
      return PermissionMode.YOLO;
    case 'plan':
      return PermissionMode.PLAN;
    default:
      return PermissionMode.DEFAULT;
  }
}

export type SubagentColor =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan';
export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  color?: SubagentColor;
  configPath?: string;

  /**
   * 模型别名（sonnet/opus/haiku）或 'inherit'
   * - inherit: 继承父 Agent 模型（默认）
   * - 注意：Blade 目前不支持多模型，此字段仅用于兼容 Claude Code 配置
   */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  skills?: string[];
  isolation?: SubagentIsolationMode;
  source?:
    | 'builtin'
    | 'claude-code-user'
    | 'claude-code-project'
    | 'blade-user'
    | 'blade-project'
    | 'flag'
    | `plugin:${string}`;
}

/**
 * Subagent 执行上下文
 *
 * 事件传递：
 * - 通过 `onEvent` 统一回调接收所有 LoopEvent
 * - Phase 4 完成：旧命名回调已删除，统一走 onEvent
 */
export interface SubagentContext {
  prompt: string;
  parentSessionId?: string;

  /** Root Session owning Provider request admission for the full child tree. */
  providerAdmissionOwnerId?: string;
  parentMessageId?: string;
  permissionMode?: PermissionMode;
  modelId?: string;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  subagentSessionId?: string;

  /** Foreground cancellation boundary owned by the invoking surface. */
  signal?: AbortSignal;

  /** Source agent ID for resumed runs */
  resumedFrom?: string;

  /** Root agent ID for the lineage */
  rootAgentId?: string;

  /** Resume depth from the root */
  resumeDepth?: number;
  workspaceRoot?: string;

  /** 子代理是否已位于预创建的 managed worktree */
  worktreeActive?: boolean;

  /** Resume 时继承的完整模型历史 */
  existingMessages?: Message[];
  onEvent?: (event: LoopEvent) => void | Promise<void>;
}

export interface SubagentResult {
  success: boolean;
  message: string;
  error?: string;
  agentId?: string;

  /** 执行结束后的完整模型历史，用于 durable resume */
  messages?: Message[];
  worktreePath?: string;
  worktreeBranch?: string;

  /** 用于后台 resume 的完整 worktree lease */
  worktree?: WorktreeSession;

  /** 最后一次源码修改后成功执行的结构化验证命令 */
  verificationCommands?: string[];

  /** verification subagent 的结构化最终判定 */
  verificationVerdict?: VerificationVerdict;

  /** Goal verifier 的有界、脱敏修复反馈 */
  verificationFeedback?: string;
  modifiedFiles?: string[];
  stats?: {
    tokens?: number;
    toolCalls?: number;
    duration?: number;
  };
}

/**
 * Subagent Frontmatter（YAML 配置）
 *
 * 兼容 Claude Code 官方格式：
 * - tools 支持逗号分隔字符串或数组
 * - model 支持 sonnet/opus/haiku 或 'inherit'
 * - permissionMode 支持 default/acceptEdits/dontAsk/bypassPermissions/plan/ignore
 * - skills 支持自动加载的 skills 列表
 */
export interface SubagentFrontmatter {
  name: string;
  description: string;
  tools?: string[] | string;
  color?: SubagentColor;
  /** 模型别名（sonnet/opus/haiku）或 'inherit' */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string;
  permissionMode?: ClaudeCodePermissionMode;
  skills?: string[] | string;
  isolation?: SubagentIsolationMode;
  license?: string;
}
