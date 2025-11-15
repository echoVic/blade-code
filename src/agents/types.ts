/**
 * Blade Subagent System - Core Type Definitions
 *
 * 定义 Subagent 系统的核心类型，包括定义、结果、任务等。
 */

/**
 * Subagent 定义
 *
 * 描述一个 subagent 的配置，包括系统提示词、工具、执行限制等。
 */
export interface SubagentDefinition {
  /** 唯一标识符（小写字母+连字符，如 'file-search'） */
  name: string;

  /** 显示名称（可选） */
  displayName?: string;

  /** 描述何时调用此 subagent */
  description: string;

  /** 系统提示词 */
  systemPrompt: string;

  /** 模型选择 */
  model?: 'haiku' | 'sonnet' | 'opus';

  /** 允许使用的工具列表（undefined 表示继承所有工具） */
  tools?: string[];

  /** 最大执行回合数（默认 10） */
  maxTurns?: number;

  /** 超时时间（毫秒，默认 300000 = 5分钟） */
  timeout?: number;

  /** Token 预算（默认 100000） */
  tokenBudget?: number;

  /** 输入参数 JSON Schema（可选） */
  inputSchema?: JSONSchema;

  /** 输出结果 JSON Schema（可选） */
  outputSchema?: JSONSchema;

  /** 配置文件来源路径 */
  source?: string;
}

/**
 * JSON Schema 类型（简化版）
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  enum?: any[];
  [key: string]: any;
}

/**
 * Subagent 执行结果
 */
export interface SubagentResult {
  /** 执行输出结果 */
  output: unknown;

  /** 终止原因 */
  terminateReason: TerminateReason;

  /** 实际执行的回合数 */
  turns: number;

  /** 执行时长（毫秒） */
  duration: number;

  /** Token 使用情况 */
  tokenUsage?: TokenUsage;

  /** 活动记录（可选，用于调试和观测） */
  activities?: SubagentActivity[];
}

/**
 * 任务终止原因
 */
export enum TerminateReason {
  /** 成功完成目标 */
  GOAL = 'GOAL',

  /** 超时 */
  TIMEOUT = 'TIMEOUT',

  /** 达到最大回合数 */
  MAX_TURNS = 'MAX_TURNS',

  /** 超出 Token 预算 */
  TOKEN_LIMIT = 'TOKEN_LIMIT',

  /** 用户取消 */
  ABORTED = 'ABORTED',

  /** 执行错误 */
  ERROR = 'ERROR',
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  /** 输入 tokens */
  input: number;

  /** 输出 tokens */
  output: number;

  /** 总计 */
  total: number;
}

/**
 * Subagent 活动事件
 *
 * 用于记录 subagent 执行过程中的关键活动
 */
export interface SubagentActivity {
  /** 活动类型 */
  type: 'thought' | 'tool_call' | 'tool_result' | 'error';

  /** 时间戳（ISO 8601 格式） */
  timestamp: string;

  /** 活动数据 */
  data: unknown;
}

/**
 * 持久化任务记录
 *
 * 保存到磁盘的任务信息
 */
export interface PersistedTask {
  /** 任务 ID */
  id: string;

  /** 任务状态 */
  status: TaskStatus;

  /** Subagent 名称 */
  agentName: string;

  /** 输入参数 */
  params: Record<string, unknown>;

  /** 执行结果（任务完成后） */
  result?: SubagentResult;

  /** 错误信息（任务失败时） */
  error?: string;

  /** 创建时间戳 */
  createdAt: number;

  /** 开始执行时间戳 */
  startedAt?: number;

  /** 完成时间戳 */
  completedAt?: number;

  /** Token 使用情况 */
  tokenUsage?: TokenUsage;
}

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Subagent 配置（Markdown frontmatter）
 *
 * 从 Markdown 文件的 YAML frontmatter 解析出来的原始配置
 */
export interface SubagentConfig {
  /** 必需字段 */
  name: string;
  description: string;

  /** 可选字段 */
  model?: 'haiku' | 'sonnet' | 'opus';
  tools?: string; // 逗号分隔的字符串
  max_turns?: number;
  timeout?: number;
  token_budget?: number;
  input_schema?: JSONSchema;
  output_schema?: JSONSchema;

  /** 允许其他字段（扩展性） */
  [key: string]: unknown;
}

/**
 * 执行上下文
 *
 * 传递给 SubagentExecutor 的运行时上下文
 *
 * 注意：这里复用了 Blade 的 ExecutionContext 类型
 * 从 src/tools/types/ExecutionTypes.ts 导入
 */
export type { ConfirmationHandler, ExecutionContext } from '../tools/types/index.js';

/**
 * Token 预算超出错误
 */
export class TokenBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenBudgetExceededError';
  }
}

/**
 * 并发限制错误
 */
export class ConcurrentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentLimitError';
  }
}

/**
 * 配置解析错误
 */
export class ConfigParseError extends Error {
  constructor(
    message: string,
    public filePath?: string
  ) {
    super(message);
    this.name = 'ConfigParseError';
  }
}
