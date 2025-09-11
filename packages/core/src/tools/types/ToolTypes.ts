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
  Other = 'other'
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  success: boolean;
  llmContent: string | object;      // 传递给LLM的内容
  displayContent: string;           // 显示给用户的内容
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
  NETWORK_ERROR = 'network_error'
}

/**
 * JSON Schema 定义 (简化版本)
 */
export interface JSONSchema7 {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  enum?: any[];
  items?: JSONSchema7;
  default?: any;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  additionalProperties?: boolean | JSONSchema7;
  oneOf?: JSONSchema7[];
  anyOf?: JSONSchema7[];
  allOf?: JSONSchema7[];
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
  execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<TResult>;
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