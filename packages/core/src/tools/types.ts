// 使用Anthropic的工具调用格式
export type Tool = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: any[];
      items?: {
        type: string;
      };
      properties?: Record<string, any>;
      required?: string[];
    }>;
    required: string[];
  };
};

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
  /** 执行是否成功 */
  success: boolean;
  /** 返回数据 */
  data?: any;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  duration?: number;
  /** 额外元数据 */
  metadata?: Record<string, any>;
}

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  /** 执行ID */
  executionId: string;
  /** 执行时间戳 */
  timestamp: number;
  /** 用户ID */
  userId?: string;
  /** 会话ID */
  sessionId?: string;
  /** 额外上下文数据 */
  context?: Record<string, any>;
}

/**
 * 工具注册选项
 */
export interface ToolRegistrationOptions {
  /** 是否覆盖已存在的工具 */
  override?: boolean;
  /** 工具启用状态 */
  enabled?: boolean;
  /** 工具权限配置 */
  permissions?: string[];
}

/**
 * 工具调用请求
 */
export interface ToolCallRequest {
  /** 工具名称 */
  toolName: string;
  /** 调用参数 */
  parameters: Record<string, any>;
  /** 执行上下文 */
  context?: ToolExecutionContext;
}

/**
 * 工具调用响应
 */
export interface ToolCallResponse {
  /** 请求ID */
  requestId: string;
  /** 工具名称 */
  toolName: string;
  /** 执行结果 */
  result: ToolExecutionResult;
  /** 执行上下文 */
  context: ToolExecutionContext;
}

/**
 * 工具管理器配置
 */
export interface ToolManagerConfig {
  /** 是否启用调试模式 */
  debug?: boolean;
  /** 最大并发执行数 */
  maxConcurrency?: number;
  /** 执行超时时间（毫秒） */
  executionTimeout?: number;
  /** 是否记录执行历史 */
  logHistory?: boolean;
  /** 历史记录最大数量 */
  maxHistorySize?: number;
}

/**
 * 工具执行历史记录
 */
export interface ToolExecutionHistory {
  /** 执行ID */
  executionId: string;
  /** 工具名称 */
  toolName: string;
  /** 执行参数 */
  parameters: Record<string, any>;
  /** 执行结果 */
  result: ToolExecutionResult;
  /** 执行上下文 */
  context: ToolExecutionContext;
  /** 创建时间 */
  createdAt: Date;
}

/**
 * 工具验证错误
 */
export class ToolValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: any
  ) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

/**
 * 工具执行错误
 */
export class ToolExecutionError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

/**
 * 工具注册错误
 */
export class ToolRegistrationError extends Error {
  constructor(
    message: string,
    public readonly toolName?: string
  ) {
    super(message);
    this.name = 'ToolRegistrationError';
  }
}
