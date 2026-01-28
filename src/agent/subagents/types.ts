/**
 * Subagent 系统类型定义
 */

import { PermissionMode } from '../../config/types.js';

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
 * - default → DEFAULT (默认模式)
 * - acceptEdits → AUTO_EDIT (自动接受编辑)
 * - dontAsk → YOLO (不询问直接执行)
 * - bypassPermissions → YOLO (绕过权限检查)
 * - plan → PLAN (计划模式)
 * - ignore → DEFAULT (忽略，使用默认)
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

  /** 自动加载的 skills 列表 */
  skills?: string[];

  /** 配置来源（用于调试和优先级） */
  source?:
    | 'builtin'
    | 'claude-code-user'
    | 'claude-code-project'
    | 'blade-user'
    | 'blade-project'
    | `plugin:${string}`;
}

/**
 * Subagent 执行上下文
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

  /** 工具执行开始回调（用于 UI 进度显示） */
  onToolStart?: (toolName: string) => void;
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
  /** 许可证信息（Claude Code skills 格式） */
  license?: string;
}
