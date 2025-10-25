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
  Memory = 'memory', // 内存操作工具（如 TODO 管理），安全且无需确认
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
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<TResult>;
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
  /** 🆕 是否为只读工具（可选，默认根据 kind 推断） */
  isReadOnly?: boolean;
  /** Schema 定义 (通常是 Zod Schema) */
  schema: TSchema;
  /** 工具描述 */
  description: ToolDescription;
  /** 执行函数 */
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
  /** 版本号 */
  version?: string;
  /** 分类 */
  category?: string;
  /** 标签 */
  tags?: string[];

  /**
   * ✅ 新增：签名内容提取器
   * 从参数中提取用于权限签名的内容字符串
   * @param params - 类型安全的参数对象
   * @returns 签名内容字符串（如 "mv file.txt" 或 "/src/foo.ts"）
   * @example
   * // Bash 工具
   * extractSignatureContent: (params) => params.command
   * // Read 工具
   * extractSignatureContent: (params) => params.file_path
   */
  extractSignatureContent?: (params: TParams) => string;

  /**
   * ✅ 新增：权限规则抽象器
   * 将具体参数抽象为通配符权限规则
   * @param params - 类型安全的参数对象
   * @returns 权限规则字符串（如 "mv:*" 或 "**\/*.ts"）
   * @example
   * // Bash 工具
   * abstractPermissionRule: (params) => `${extractMainCmd(params.command)}:*`
   * // Read 工具
   * abstractPermissionRule: (params) => `**\/*${path.extname(params.file_path)}`
   */
  abstractPermissionRule?: (params: TParams) => string;
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
  /** 🆕 是否为只读工具 */
  readonly isReadOnly: boolean;
  /** 工具描述 */
  readonly description: ToolDescription;
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

  /**
   * ✅ 新增：签名内容提取器
   * 从参数中提取用于权限签名的内容字符串
   */
  extractSignatureContent?: (params: TParams) => string;

  /**
   * ✅ 新增：权限规则抽象器
   * 将具体参数抽象为通配符权限规则
   */
  abstractPermissionRule?: (params: TParams) => string;
}

/**
 * 根据 ToolKind 推断是否为只读工具
 */
export function isReadOnlyKind(kind: ToolKind): boolean {
  const READ_ONLY_KINDS = [
    ToolKind.Read, // 文件读取
    ToolKind.Search, // 搜索工具
    ToolKind.Network, // 网络请求（仅 GET）
    ToolKind.Think, // 思考工具
    ToolKind.Memory, // TODO 管理（记录计划）
  ];

  return READ_ONLY_KINDS.includes(kind);
}
