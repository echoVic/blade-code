import type { JSONSchema7 } from 'json-schema';
import type { ExecutionContext } from './ExecutionTypes.js';

/**
 * 工具类型枚举
 */
export enum ToolKind {
  Read = 'read',
  Edit = 'edit',
  Delete = 'delete',
  Move = 'move',
  Search = 'search',
  Execute = 'execute',
  Network = 'network',
  Think = 'think',
  External = 'external',
  Other = 'other',
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  success: boolean;
  llmContent: string | object; // 传递给LLM的内容
  displayContent: string; // 显示给用户的内容
  error?: ToolError;
  metadata?: Record<string, any>;
}

/**
 * 工具错误类型
 */
export interface ToolError {
  message: string;
  type: ToolErrorType;
  code?: string;
  details?: any;
}

export enum ToolErrorType {
  VALIDATION_ERROR = 'validation_error',
  PERMISSION_DENIED = 'permission_denied',
  EXECUTION_ERROR = 'execution_error',
  TIMEOUT_ERROR = 'timeout_error',
  NETWORK_ERROR = 'network_error',
}

/**
 * 函数声明 (用于LLM函数调用)
 */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

/**
 * 工具调用抽象
 */
export interface ToolInvocation<TParams = any, TResult = ToolResult> {
  readonly toolName: string;
  readonly params: TParams;

  getDescription(): string;
  getAffectedPaths(): string[];
  shouldConfirm(): Promise<ConfirmationDetails | null>;
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<TResult>;
}

/**
 * 确认详情
 */
export interface ConfirmationDetails {
  type: 'edit' | 'execute' | 'delete' | 'network' | 'external';
  title: string;
  message: string;
  risks?: string[];
  affectedFiles?: string[];
}

/**
 * 工具描述格式
 */
export interface ToolDescription {
  /** 简短描述 (1行) */
  short: string;
  /** 详细说明 (可选) */
  long?: string;
  /** 使用说明列表 */
  usageNotes?: string[];
  /** 使用示例 */
  examples?: Array<{
    description: string;
    params: Record<string, unknown>;
  }>;
  /** 重要提示 */
  important?: string[];
}

/**
 * 确认回调函数类型
 */
export type ConfirmationCallback<TParams> = (
  params: TParams
) => Promise<ConfirmationDetails | null>;

/**
 * 工具配置 (泛型接口，用于配合 Zod Schema)
 * TSchema: Schema 类型 (如 z.ZodObject)
 * TParams: 推断的参数类型
 */
export interface ToolConfig<TSchema = unknown, TParams = unknown> {
  /** 工具唯一名称 */
  name: string;
  /** 工具显示名称 */
  displayName: string;
  /** 工具类型 */
  kind: ToolKind;
  /** Schema 定义 (通常是 Zod Schema) */
  schema: TSchema;
  /** 工具描述 */
  description: ToolDescription;
  /** 是否需要确认 (boolean 或回调函数) */
  requiresConfirmation?: boolean | ConfirmationCallback<TParams>;
  /** 执行函数 */
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
  /** 版本号 */
  version?: string;
  /** 分类 */
  category?: string;
  /** 标签 */
  tags?: string[];
}

/**
 * Tool 接口
 */
export interface Tool<TParams = unknown> {
  /** 工具名称 */
  readonly name: string;
  /** 显示名称 */
  readonly displayName: string;
  /** 工具类型 */
  readonly kind: ToolKind;
  /** 工具描述 */
  readonly description: ToolDescription;
  /** 是否需要确认 */
  readonly requiresConfirmation: boolean;
  /** 版本号 */
  readonly version: string;
  /** 分类 */
  readonly category?: string;
  /** 标签 */
  readonly tags: string[];

  /**
   * 获取函数声明 (用于 LLM)
   */
  getFunctionDeclaration(): FunctionDeclaration;

  /**
   * 获取工具元信息
   */
  getMetadata(): Record<string, unknown>;

  /**
   * 构建工具调用
   */
  build(params: TParams): ToolInvocation<TParams>;

  /**
   * 一键执行
   */
  execute(params: TParams, signal?: AbortSignal): Promise<ToolResult>;
}
