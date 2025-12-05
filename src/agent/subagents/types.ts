/**
 * Subagent 系统类型定义
 */

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
  permissionMode?: string;
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
 */
export interface SubagentFrontmatter {
  name: string;
  description: string;
  tools?: string[];
  color?: SubagentColor;
}
