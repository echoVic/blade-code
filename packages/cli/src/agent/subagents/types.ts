/**
 * Subagent 系统类型定义
 */

import {
  type CommunicationStyleSelection,
  PermissionMode,
  type ReasoningEffortSelection,
  type ResponseVerbositySelection,
  type ServiceTierSelection,
} from '../../config/types.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { WorktreeSession } from '../../worktree/WorktreeManager.js';
import type { LoopEvent } from '../loop/types.js';
import type { SubagentIsolationMode } from './SubagentWorktreeLifecycle.js';

/**
 * Claude Code permissionMode 类型
 * 参考: https://code.claude.com/docs/en/sub-agents
 */
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

/**
 * Subagent 背景颜色
 */
export type SubagentColor =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan';

/**
 * Subagent 配置
 */
export interface SubagentConfig {
  /** Subagent 唯一标识符 */
  name: string;

  /** 描述（给 LLM 看的能力说明） */
  description: string;

  /** 系统提示模板（可选，支持变量替换） */
  systemPrompt?: string;

  /** 允许的工具列表（空数组 = 所有工具） */
  tools?: string[];

  /** 禁止的工具列表（优先于允许列表） */
  disallowedTools?: string[];

  /** UI 背景颜色（可选，用于视觉区分） */
  color?: SubagentColor;

  /** 配置文件路径（用于调试） */
  configPath?: string;

  /**
   * 模型别名（sonnet/opus/haiku）或 'inherit'
   * - inherit: 继承父 Agent 模型（默认）
   * - 注意：Blade 目前不支持多模型，此字段仅用于兼容 Claude Code 配置
   */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string;

  /** 权限模式（已映射为 Blade PermissionMode） */
  permissionMode?: PermissionMode;

  /** 最大对话轮次 */
  maxTurns?: number;

  /** 自动加载的 skills 列表 */
  skills?: string[];

  /** 默认文件系统隔离模式 */
  isolation?: SubagentIsolationMode;

  /** 配置来源（用于调试和优先级） */
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
  /** 任务提示 */
  prompt: string;

  /** 父 Agent 的会话 ID（可选，用于追溯） */
  parentSessionId?: string;

  /** 父 Agent 的消息 ID（可选） */
  parentMessageId?: string;

  /** 父 Agent 的权限模式（继承给子 Agent） */
  permissionMode?: PermissionMode;

  /** 父 Session 当前的 durable reasoning 策略 */
  reasoningEffort?: ReasoningEffortSelection;

  /** 父 Session 当前的 provider service tier */
  serviceTier?: ServiceTierSelection;

  /** 父 Session 当前的 response verbosity */
  responseVerbosity?: ResponseVerbositySelection;

  /** 父 Session 当前的 communication style */
  communicationStyle?: CommunicationStyleSelection;

  /** 子代理会话 ID（用于与主会话关联） */
  subagentSessionId?: string;

  /** Source agent ID for resumed runs */
  resumedFrom?: string;

  /** Root agent ID for the lineage */
  rootAgentId?: string;

  /** Resume depth from the root */
  resumeDepth?: number;

  /** 子代理执行目录（默认继承父 Agent） */
  workspaceRoot?: string;

  /** 子代理是否已位于预创建的 managed worktree */
  worktreeActive?: boolean;

  /** Resume 时继承的完整模型历史 */
  existingMessages?: Message[];

  /**
   * 统一事件回调
   * SubagentExecutor 直接转发所有 LoopEvent。
   */
  onEvent?: (event: LoopEvent) => void | Promise<void>;
}

/**
 * Subagent 执行结果
 */
export interface SubagentResult {
  /** 执行是否成功 */
  success: boolean;

  /** 结果消息 */
  message: string;

  /** 错误信息（如果失败） */
  error?: string;

  /** 子代理会话 ID（用于关联独立 JSONL 文件） */
  agentId?: string;

  /** 执行结束后的完整模型历史，用于 durable resume */
  messages?: Message[];

  /** 保留的隔离 worktree 路径（无改动自动清理时为空） */
  worktreePath?: string;

  /** 保留的隔离 worktree 分支 */
  worktreeBranch?: string;

  /** 用于后台 resume 的完整 worktree lease */
  worktree?: WorktreeSession;

  /** 最后一次源码修改后成功执行的结构化验证命令 */
  verificationCommands?: string[];

  /** 执行统计 */
  stats?: {
    /** Token 使用量 */
    tokens?: number;

    /** 工具调用次数 */
    toolCalls?: number;

    /** 执行时长（毫秒） */
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
  /** 工具列表（逗号分隔字符串或数组），不指定则继承所有工具 */
  tools?: string[] | string;
  /** UI 背景颜色 */
  color?: SubagentColor;
  /** 模型别名（sonnet/opus/haiku）或 'inherit' */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string;
  /** 权限模式（Claude Code 格式，将被映射为 Blade PermissionMode） */
  permissionMode?: ClaudeCodePermissionMode;
  /** 自动加载的 skills 列表（逗号分隔字符串或数组） */
  skills?: string[] | string;
  /** 默认文件系统隔离模式 */
  isolation?: SubagentIsolationMode;
  /** 许可证信息（Claude Code skills 格式） */
  license?: string;
}
