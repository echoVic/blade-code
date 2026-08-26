import type { ConstrainedSamplingConfig } from '@earendil-works/pi-ai';
import type { JSONSchema7 } from 'json-schema';
import type {
  BrowserErrorCode,
  BrowserInteractionVisual,
  BrowserToolName,
} from '../../browser/types.js';
import type { PermissionMode } from '../../config/types.js';
import type { ExecutionContext } from './ExecutionTypes.js';

/**
 * Node.js 错误类型（带有 code 属性）
 */
export interface NodeError extends Error {
  code?: string;
}

/**
 * 工具类型枚举（简化为 3 种）
 *
 * - ReadOnly: 只读操作，无副作用（Read, Glob, Grep, WebFetch, WebSearch, TaskOutput, TaskCreate/TaskGet/TaskUpdate/TaskList, Plan 工具等）
 * - Write: 文件写入操作（Edit, Write, NotebookEdit）
 * - Execute: 命令执行，可能有副作用（Bash, KillShell, Task, Skill, SlashCommand）
 */
export enum ToolKind {
  ReadOnly = 'readonly',
  Write = 'write',
  Execute = 'execute',
}

/**
 * Metadata 基础字段 - 所有工具共享
 */
interface BaseMetadataFields {
  summary?: string;
  shouldExitLoop?: boolean;
  targetMode?: PermissionMode;
  modelId?: string;
  model?: string;
}

/**
 * 文件操作类工具的基础字段
 */
interface FileMetadataFields extends BaseMetadataFields {
  file_path: string;
  file_size?: number;
  last_modified?: string;
}

/**
 * Diff 相关字段（Write/Edit 工具）
 */
interface DiffMetadataFields extends FileMetadataFields {
  kind: 'edit';
  oldContent: string;
  newContent?: string;
  snapshot_created?: boolean;
  session_id?: string;
  message_id?: string;
}

/**
 * Read 工具的字段
 */
interface ReadMetadataFields extends FileMetadataFields {
  file_type: string;
  encoding: string;
  acp_mode?: boolean;
  acp_fallback?: boolean;
  is_binary?: boolean;
  lines_read?: number;
  total_lines?: number;
  start_line?: number;
  end_line?: number;
}

/**
 * Write 工具的字段
 */
interface WriteMetadataFields extends DiffMetadataFields {
  content_size: number;
  encoding: string;
  created_directories?: boolean;
  has_diff?: boolean;
}

/**
 * Edit 工具的字段
 */
interface EditMetadataFields extends DiffMetadataFields {
  matches_found: number;
  replacements_made: number;
  replace_all: boolean;
  old_string_length: number;
  new_string_length: number;
  original_size: number;
  new_size: number;
  size_diff: number;
  diff_snippet?: string | null;
}

export interface ApplyPatchChangeMetadata {
  kind: 'add' | 'update' | 'delete';
  path: string;
  oldContent: string | null;
  newContent: string | null;
  diff?: string;
}

interface ApplyPatchMetadataFields extends BaseMetadataFields {
  kind: 'patch';
  changes: ApplyPatchChangeMetadata[];
  affected_paths: string[];
  snapshot_created?: boolean;
  session_id?: string;
  message_id?: string;
}

/**
 * Edit 工具错误诊断的字段
 */
interface EditErrorMetadataFields extends BaseMetadataFields {
  searchStringLength: number;
  fuzzyMatches: Array<{
    line: number;
    similarity: number;
    preview: string;
  }>;
  excerptRange: [number, number];
  totalLines: number;
}

/**
 * Glob 工具的字段
 */
interface GlobMetadataFields extends BaseMetadataFields {
  search_path: string;
  pattern: string;
  total_matches: number;
  returned_matches: number;
  max_results: number;
  include_directories?: boolean;
  case_sensitive?: boolean;
  truncated: boolean;
  matches?: Array<{
    path: string;
    relative_path: string;
    is_directory: boolean;
    mtime?: number;
  }>;
}

/**
 * Grep 工具的字段
 */
interface GrepMetadataFields extends BaseMetadataFields {
  search_pattern: string;
  search_path: string;
  output_mode: string;
  case_insensitive?: boolean;
  total_matches: number;
  original_total?: number;
  offset?: number;
  head_limit?: number;
  strategy?: string;
  exit_code?: number;
}

/**
 * Bash 工具的字段（后台执行）
 */
interface BashBackgroundMetadataFields extends BaseMetadataFields {
  command: string;
  background: true;
  pid?: number;
  bash_id: string;
  shell_id: string;
  message?: string;
  sandboxed?: boolean;
  auto_backgrounded?: boolean;
  background_reason?: 'explicit' | 'foreground_budget';
  foreground_budget_ms?: number;
  terminal_transport?: 'local' | 'acp';
  acp_mode?: boolean;
}

/**
 * Bash 工具的字段（前台执行）
 */
interface BashForegroundMetadataFields extends BaseMetadataFields {
  command: string;
  background?: false;
  execution_time: number;
  exit_code: number | null;
  signal?: NodeJS.Signals | null;
  stdout_length?: number;
  stderr_length?: number;
  capture_truncated?: boolean;
  projection_truncated?: boolean;
  output_truncated?: boolean;
  stdout_total_bytes?: number;
  stderr_total_bytes?: number;
  stdout_retained_bytes?: number;
  stderr_retained_bytes?: number;
  stdout_omitted_bytes?: number;
  stderr_omitted_bytes?: number;
  raw_output_bytes?: number;
  stdout_projection_truncated?: boolean;
  stderr_projection_truncated?: boolean;
  output_accounting_complete?: boolean;
  terminal_transport?: 'local' | 'acp' | 'local_fallback';
  terminal_output_merged?: boolean;
  has_stderr?: boolean;
  acp_mode?: boolean;
  sandboxed?: boolean;
}

/**
 * WebSearch 工具的字段
 */
interface WebSearchMetadataFields extends BaseMetadataFields {
  query: string;
  provider: string;
  fetched_at: string;
  total_results: number;
  returned_results: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

/**
 * WebFetch 工具的字段
 */
interface WebFetchMetadataFields extends BaseMetadataFields {
  url: string;
  method: string;
  status: number;
  response_time: number;
  content_length: number;
  redirected: boolean;
  redirect_count: number;
  final_url?: string;
  content_type?: string;
  redirect_chain?: string[];
}

interface BrowserToolMetadataFields extends BaseMetadataFields {
  browser: {
    action: BrowserToolName;
    status: 'ok' | 'warning' | 'error';
    pageId?: string;
    snapshotId?: string;
    origin?: string;
    url?: string;
    title?: string;
    truncated?: boolean;
    actionApplied?: boolean | 'unknown';
    sideEffectsUncertain?: boolean;
    candidateOrigin?: string;
    errorCode?: BrowserErrorCode;
    diagnosticCount?: number;
    interaction?: BrowserInteractionVisual;
    artifact?: {
      id: string;
      kind: 'image';
      mimeType: 'image/png';
      size: number;
      sha256: string;
      persisted: true;
      path?: string;
    };
  };
}

/**
 * 泛型 Metadata 类型
 *
 * @template T - 具体的 metadata 字段接口
 *
 * @example
 * // 在工具内部使用具体类型
 * const metadata: Metadata<EditMetadataFields> = { ... };
 *
 * // 返回时自动兼容 ToolResultMetadata
 * return { success: true, metadata };
 */
type Metadata<T extends BaseMetadataFields = BaseMetadataFields> = T & {
  [key: string]: unknown;
};

/**
 * 预定义的 Metadata 类型别名（方便使用）
 */
type FileMetadata = Metadata<FileMetadataFields>;
type DiffMetadata = Metadata<DiffMetadataFields>;
export type ReadMetadata = Metadata<ReadMetadataFields>;
export type WriteMetadata = Metadata<WriteMetadataFields>;
export type EditMetadata = Metadata<EditMetadataFields>;
export type ApplyPatchMetadata = Metadata<ApplyPatchMetadataFields>;
export type EditErrorMetadata = Metadata<EditErrorMetadataFields>;
export type GlobMetadata = Metadata<GlobMetadataFields>;
export type GrepMetadata = Metadata<GrepMetadataFields>;
export type BashBackgroundMetadata = Metadata<BashBackgroundMetadataFields>;
export type BashForegroundMetadata = Metadata<BashForegroundMetadataFields>;
type BashMetadata = BashBackgroundMetadata | BashForegroundMetadata;
export type WebSearchMetadata = Metadata<WebSearchMetadataFields>;
export type WebFetchMetadata = Metadata<WebFetchMetadataFields>;
export type BrowserToolMetadata = Metadata<BrowserToolMetadataFields>;

/**
 * ToolResult.metadata 的类型（向后兼容）
 *
 * 使用 Metadata<BaseMetadataFields> 作为基础，允许任意扩展字段
 */
export type ToolResultMetadata = Metadata<BaseMetadataFields>;

/**
 * 类型守卫：检查 metadata 是否为 diff 类型（Write/Edit）
 */
function _isDiffMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is DiffMetadata {
  return (
    metadata !== undefined &&
    metadata.kind === 'edit' &&
    typeof metadata.file_path === 'string' &&
    typeof metadata.oldContent === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为文件类型
 */
function _isFileMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is FileMetadata {
  return metadata !== undefined && typeof metadata.file_path === 'string';
}

/**
 * 类型守卫：检查 metadata 是否为命令执行类型
 */
function _isBashMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is BashMetadata {
  return metadata !== undefined && typeof metadata.command === 'string';
}

/**
 * 类型守卫：检查 metadata 是否为 Glob 类型
 */
export function isGlobMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is GlobMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.pattern === 'string' &&
    typeof metadata.search_path === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为 Grep 类型
 */
function _isGrepMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is GrepMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.search_pattern === 'string' &&
    typeof metadata.search_path === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为 Read 类型
 */
function _isReadMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is ReadMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.file_path === 'string' &&
    typeof metadata.file_type === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为 Edit 类型
 */
export function isEditMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is EditMetadata {
  return (
    metadata !== undefined &&
    metadata.kind === 'edit' &&
    typeof metadata.matches_found === 'number'
  );
}

/**
 * 泛型工具执行结果
 *
 * @template TMetadata - metadata 的具体类型
 *
 * @example
 * // 在工具内部使用具体类型
 * async function execute(): Promise<TypedToolResult<EditMetadata>> {
 * return {
 * success: true,
 * llmContent: '...',
 * metadata: { file_path: '...', matches_found: 1, ... }
 * };
 * }
 */
interface TypedToolResult<TMetadata extends ToolResultMetadata = ToolResultMetadata> {
  success: boolean;
  llmContent: string | object;
  error?: ToolError;
  metadata?: TMetadata;
}

/**
 * 工具展示输出（由格式化层生成，供所有 UI 消费者使用）
 */
export interface ToolDisplayOutput {
  /** 状态：ok / fail / warn */
  status: 'ok' | 'fail' | 'warn';
  /** 一行摘要 */
  summary: string;
  /** 多行详情（diff、输出预览等），可选 */
  detail?: string;
}

/**
 * 工具执行结果（向后兼容的非泛型版本）
 */
export type ToolResult = TypedToolResult<ToolResultMetadata>;

/**
 * 工具错误类型
 */
interface ToolError {
  message: string;
  type: ToolErrorType;
  code?: string;
  details?: unknown;
}

export enum ToolErrorType {
  VALIDATION_ERROR = 'validation_error',
  PERMISSION_DENIED = 'permission_denied',
  EXECUTION_ERROR = 'execution_error',
  RESOURCE_EXHAUSTED = 'resource_exhausted',
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
  constrainedSampling?: false | ConstrainedSamplingConfig;
}

/**
 * 工具调用抽象
 */
export interface ToolInvocation<TParams = unknown, TResult = ToolResult> {
  readonly toolName: string;
  readonly params: TParams;

  getDescription(): string;
  getAffectedPaths(): string[];
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>
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
 * 工具配置 (泛型接口，用于配合 TypeBox Schema)
 * TSchema: TypeBox Schema 类型
 * TParams: 推断的参数类型
 */
export interface ToolConfig<TSchema = unknown, TParams = unknown> {
  /** 工具唯一名称 */
  name: string;
  /** 工具显示名称 */
  displayName: string;
  /** 工具类型 */
  kind: ToolKind;
  /** 是否可与同批其他并发安全工具共享执行（可选，默认 false） */
  isConcurrencySafe?: boolean;
  /** 批内调度模式；shared 仍可由文件锁或 kind 配额进一步限流 */
  parallelism?: 'shared' | 'exclusive';
  /** 是否启用 OpenAI Structured Outputs（可选，默认 false） */
  strict?: boolean;
  /** TypeBox Schema 定义 */
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
   * [OK] 新增：签名内容提取器
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
   * 返回调用可能读写的路径，用于权限、安全审阅和多路径工具。
   */
  affectedPaths?: (params: TParams) => string[];

  /**
   * [OK] 新增：权限规则抽象器
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
  /** 是否支持并发安全 */
  readonly isConcurrencySafe: boolean;
  /** 是否可与同批其他 shared 工具并发 */
  readonly parallelism?: 'shared' | 'exclusive';
  /** 是否启用 OpenAI Structured Outputs */
  readonly strict: boolean;
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
  execute(
    params: TParams,
    signal?: AbortSignal,
    context?: Partial<ExecutionContext>
  ): Promise<ToolResult>;

  /**
   * [OK] 新增：签名内容提取器
   * 从参数中提取用于权限签名的内容字符串
   */
  extractSignatureContent?: (params: TParams) => string;

  /**
   * [OK] 新增：权限规则抽象器
   * 将具体参数抽象为通配符权限规则
   */
  abstractPermissionRule?: (params: TParams) => string;
}

/**
 * 根据 ToolKind 推断是否为只读工具
 */
export function isReadOnlyKind(kind: ToolKind): boolean {
  return kind === ToolKind.ReadOnly;
}
